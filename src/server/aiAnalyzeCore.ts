import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

export interface AiAnalyzeRequestBody {
  symbol: string;
  tf: string;
  lang: 'en' | 'kh';
  quote: {
    bid: number;
    ask: number;
    mid: number;
    spread: number;
  };
  quantSignal: {
    state: string;
    type: string;
    entryMode: string;
    setupScore: number;
    entry: number | null;
    sl: number | null;
    tp1: number | null;
    tp2: number | null;
    tp3: number | null;
    regime: string;
    ema8: number | null;
    ema21: number | null;
    macdHist: number | null;
    rsi14: number | null;
    atr14: number | null;
    structure: string;
    reversalWarning: boolean;
    reversalReason?: string | null;
  };
  keyLevels: {
    r1: number | null;
    r2: number | null;
    s1: number | null;
    s2: number | null;
    pdh: number | null;
    pdl: number | null;
  };
  recentCandles: Array<{
    t: string;
    o: number;
    h: number;
    l: number;
    c: number;
  }>;
  candleTime?: number;
}

export interface AiAnalyzeResponsePayload {
  symbol: string;
  tf: string;
  bias: 'BUY' | 'SELL' | 'WAIT';
  confidence: number;
  setupType: string;
  srVerdict: string;
  reversalAlert: string;
  entryPlan: string;
  riskNote: string;
  summary: string;
  analyzedAt: string;
  modelUsed?: string;
}

const VALID_SYMBOL_RE = /^[A-Z0-9]{3,12}$/;
const VALID_TF_SET = new Set(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1']);

// Short TTL in-memory cache (35s) and per-model failure cooldown (3m) so retries never stall on a degraded model
const serverAiCache = new Map<string, { payload: AiAnalyzeResponsePayload; expiresAt: number }>();
const modelCooldownUntil = new Map<string, number>();

function extractJsonObject(raw: string): Record<string, unknown> {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    }
    throw new Error('AI returned malformed response format. Please retry.');
  }
}

function formatGeminiError(err: unknown): { status: number; message: string; retryableWithFallback: boolean } {
  const rawMsg = err instanceof Error ? err.message : String(err || 'Gemini AI analysis failed');
  const errName = err instanceof Error ? err.name : '';
  let status = 502;
  let message = rawMsg;

  if (errName === 'TimeoutError' || errName === 'AbortError' || rawMsg.toLowerCase().includes('aborted') || rawMsg.toLowerCase().includes('timeout')) {
    return {
      status: 504,
      message: 'AI server busy (timeout). Please tap Retry.',
      retryableWithFallback: true,
    };
  }

  try {
    const start = rawMsg.indexOf('{');
    if (start !== -1) {
      const parsed = JSON.parse(rawMsg.slice(start));
      const code = Number(parsed?.error?.code);
      const apiMsg = String(parsed?.error?.message || '');
      const apiStatus = String(parsed?.error?.status || '');
      if (code === 429 || apiStatus === 'RESOURCE_EXHAUSTED') {
        return {
          status: 429,
          message: 'AI rate/daily quota reached. Please wait a bit before retrying.',
          retryableWithFallback: true,
        };
      }
      if (code === 404 || apiStatus === 'NOT_FOUND') {
        return {
          status: 502,
          message: apiMsg || 'Configured AI model unavailable.',
          retryableWithFallback: true,
        };
      }
      if (code === 400 || apiStatus === 'INVALID_ARGUMENT') {
        return {
          status: 400,
          message: apiMsg || 'Invalid AI request configuration.',
          retryableWithFallback: true,
        };
      }
      if (apiMsg) {
        message = apiMsg.split('\n')[0].slice(0, 180);
      }
      if (Number.isInteger(code) && code >= 400 && code < 600) {
        status = code;
      }
    }
  } catch {
    // keep rawMsg
  }

  if (rawMsg.includes('429') || rawMsg.toLowerCase().includes('quota')) {
    return {
      status: 429,
      message: 'AI rate/daily quota reached. Please wait a bit before retrying.',
      retryableWithFallback: true,
    };
  }
  if (rawMsg.toLowerCase().includes('api key')) {
    return {
      status: 503,
      message: 'GEMINI_API_KEY is missing or invalid.',
      retryableWithFallback: false,
    };
  }
  return {
    status,
    message: message.slice(0, 220),
    retryableWithFallback:
      status === 503 ||
      status === 500 ||
      status === 504 ||
      rawMsg.includes('404') ||
      rawMsg.includes('NOT_FOUND') ||
      rawMsg.includes('503') ||
      rawMsg.includes('UNAVAILABLE') ||
      rawMsg.includes('500') ||
      rawMsg.includes('504'),
  };
}

export function resolveGeminiApiKey(): string | null {
  let raw =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.VITE_GEMINI_API_KEY ||
    process.env.NEXT_PUBLIC_GEMINI_API_KEY ||
    process.env.API_KEY ||
    '';

  if (!raw) {
    for (const [k, v] of Object.entries(process.env)) {
      if (v && /^(VITE_|NEXT_PUBLIC_)?(GEMINI|GOOGLE_GENERATIVE_AI|GOOGLE_API).*KEY$/i.test(k.trim())) {
        raw = v;
        break;
      }
    }
  }

  const cleaned = raw.trim().replace(/^["']|["']$/g, '');
  return cleaned.length > 10 ? cleaned : null;
}

export async function analyzeMarketWithGemini(
  rawBody: unknown
): Promise<{ ok: true; status: number; data: AiAnalyzeResponsePayload } | { ok: false; status: number; error: string }> {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      error:
        'GEMINI_API_KEY not found on server. On Vercel: Settings → Environment Variables → add GEMINI_API_KEY (Production & Preview) → Redeploy.',
    };
  }

  const body = rawBody as Partial<AiAnalyzeRequestBody> | null;
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, error: 'Invalid JSON body.' };
  }

  const symbol = String(body.symbol || '').toUpperCase().trim();
  const tf = String(body.tf || '').toUpperCase().trim();
  const lang: 'en' | 'kh' = body.lang === 'kh' ? 'kh' : 'en';

  if (!VALID_SYMBOL_RE.test(symbol) || !VALID_TF_SET.has(tf)) {
    return { ok: false, status: 400, error: 'Invalid symbol or timeframe.' };
  }

  if (
    !body.quote ||
    !Number.isFinite(Number(body.quote.mid)) ||
    !Array.isArray(body.recentCandles) ||
    body.recentCandles.length < 5
  ) {
    return { ok: false, status: 400, error: 'Insufficient live quote or candle context for AI analysis.' };
  }

  const candles = body.recentCandles.slice(-24).map((c) => ({
    t: String(c.t || '').slice(0, 19),
    o: Number(c.o),
    h: Number(c.h),
    l: Number(c.l),
    c: Number(c.c),
  }));
  const latestCandleTag = candles[candles.length - 1]?.t || '';
  const cacheKey = `${symbol}:${tf}:${lang}:${latestCandleTag}:${body.quantSignal?.state || ''}`;
  const cached = serverAiCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, status: 200, data: cached.payload };
  }

  const aiClient = new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: 12000,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const langInstruction =
    lang === 'kh'
      ? 'Write all descriptive text fields (srVerdict, reversalAlert, entryPlan, riskNote, summary) in clear, natural Khmer (ភាសាខ្មែរ) with exact numbers.'
      : 'Write all descriptive text fields (srVerdict, reversalAlert, entryPlan, riskNote, summary) in concise, actionable English with exact numbers.';

  const promptPayload = {
    symbol,
    timeframe: tf,
    liveQuote: body.quote,
    keyLevels: body.keyLevels,
    quantContext: body.quantSignal,
    last24ClosedCandles: candles,
  };

  const allModels = Array.from(
    new Set([process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite', 'gemini-4-hydrogen'])
  );
  const nowMs = Date.now();
  const activeModels = allModels.filter((m) => (modelCooldownUntil.get(m) || 0) <= nowMs);
  const baseModels = activeModels.length ? activeModels : allModels;

  let lastErr: { status: number; message: string } = { status: 503, message: 'Gemini AI temporarily busy.' };

  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      if (lastErr.status !== 503 && lastErr.status !== 504) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    const modelsToTry = pass === 0 ? baseModels : ['gemini-3.1-flash-lite'];

    for (const modelName of modelsToTry) {
      try {
        const config: Record<string, unknown> = {
          abortSignal: AbortSignal.timeout(11000),
          systemInstruction:
            `You are an institutional Forex, Gold & Crypto price-action & S/R quant analyst inside a fast trading terminal. ` +
            `Evaluate the last 24 OHLC candles against R1/R2/S1/S2/PDH/PDL, EMA 8/21, MACD, RSI(14), ATR(14), and market structure. ` +
            `Pay special attention to REVERSALS AT RESISTANCE (R1/R2/PDH rejection wicks, lower highs, RSI overbought turn) and REVERSALS AT SUPPORT (S1/S2/PDL bounce wicks, higher lows, RSI oversold turn), as well as clean trend continuation/breakouts. ` +
            `Never invent prices outside the provided candles/levels. Keep every field crisp and under 25 words. ${langInstruction}`,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              bias: {
                type: Type.STRING,
                description: 'Must be exactly BUY, SELL, or WAIT.',
              },
              confidence: {
                type: Type.INTEGER,
                description: 'Confidence score from 0 to 100.',
              },
              setupType: {
                type: Type.STRING,
                description:
                  'Short 2-4 word setup name, e.g. S1 Bounce Reversal, R1 Rejection Sell, EMA Trend Continuation, Squeeze Breakout.',
              },
              srVerdict: {
                type: Type.STRING,
                description: 'Concise assessment of current price position relative to S1/R1/PDH/PDL.',
              },
              reversalAlert: {
                type: Type.STRING,
                description: 'Whether price is currently reversing at R1/R2 or S1/S2, or None if trending cleanly.',
              },
              entryPlan: {
                type: Type.STRING,
                description: 'Immediate actionable plan: exact zone to enter/confirm and TP1/SL logic.',
              },
              riskNote: {
                type: Type.STRING,
                description: 'Key invalidation price or risk caution.',
              },
              summary: {
                type: Type.STRING,
                description: 'One-sentence synthesis of why BUY, SELL, or WAIT right now.',
              },
            },
            required: ['bias', 'confidence', 'setupType', 'srVerdict', 'reversalAlert', 'entryPlan', 'riskNote', 'summary'],
          },
        };

        if (modelName === 'gemini-4-hydrogen') {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
        }

        const response = await aiClient.models.generateContent({
          model: modelName,
          contents: `Analyze this live market snapshot for ${symbol} on ${tf} and give a fast, decisive trading verdict:\n${JSON.stringify(promptPayload)}`,
          config: config as any,
        });

        const parsed = extractJsonObject(response.text ?? '{}');
        const rawBias = String(parsed.bias || 'WAIT').toUpperCase().trim();
        const bias: 'BUY' | 'SELL' | 'WAIT' = rawBias === 'BUY' || rawBias === 'SELL' ? rawBias : 'WAIT';
        const confidence = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 50)));

        const payload: AiAnalyzeResponsePayload = {
          symbol,
          tf,
          bias,
          confidence,
          setupType: String(parsed.setupType || 'Market Scan'),
          srVerdict: String(parsed.srVerdict || '—'),
          reversalAlert: String(parsed.reversalAlert || 'None'),
          entryPlan: String(parsed.entryPlan || '—'),
          riskNote: String(parsed.riskNote || '—'),
          summary: String(parsed.summary || '—'),
          analyzedAt: new Date().toISOString(),
          modelUsed: modelName,
        };

        serverAiCache.set(cacheKey, { payload, expiresAt: Date.now() + 35000 });
        if (serverAiCache.size > 60) {
          const oldestKey = serverAiCache.keys().next().value;
          if (oldestKey) serverAiCache.delete(oldestKey);
        }

        return { ok: true, status: 200, data: payload };
      } catch (err) {
        const formatted = formatGeminiError(err);
        lastErr = { status: formatted.status, message: formatted.message };
        if (formatted.retryableWithFallback) {
          modelCooldownUntil.set(modelName, Date.now() + (formatted.status === 429 ? 45000 : 180000));
          continue;
        }
        return { ok: false, status: formatted.status, error: formatted.message };
      }
    }
  }

  return { ok: false, status: lastErr.status, error: lastErr.message };
}
