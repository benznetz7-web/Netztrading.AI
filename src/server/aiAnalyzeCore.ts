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

function resolveGroqApiKey(): string | null {
  const raw = process.env.GROQ_API_KEY || '';
  const cleaned = raw.trim().replace(/^["']|["']$/g, '');
  return cleaned.length > 10 ? cleaned : null;
}

function resolveOpenRouterApiKey(): string | null {
  const raw = process.env.OPENROUTER_API_KEY || '';
  const cleaned = raw.trim().replace(/^["']|["']$/g, '');
  return cleaned.length > 10 ? cleaned : null;
}

function normalizeAiPayload(
  symbol: string,
  tf: string,
  parsed: Record<string, unknown>,
  modelUsed: string
): AiAnalyzeResponsePayload {
  const rawBias = String(parsed.bias || 'WAIT').toUpperCase().trim();
  const bias: 'BUY' | 'SELL' | 'WAIT' = rawBias === 'BUY' || rawBias === 'SELL' ? rawBias : 'WAIT';
  const confidence = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 50)));
  return {
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
    modelUsed,
  };
}

async function analyzeWithOpenAiCompatibleEndpoint(opts: {
  url: string;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
  symbol: string;
  tf: string;
  modelLabel: string;
}): Promise<{ ok: true; data: AiAnalyzeResponsePayload } | { ok: false; status: number }> {
  try {
    const res = await fetch(opts.url, {
      method: 'POST',
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
      body: JSON.stringify(opts.body),
    });
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    const raw = await res.text();
    const data = JSON.parse(raw);
    const content = String(data?.choices?.[0]?.message?.content || data?.content || '');
    if (!content.trim()) {
      return { ok: false, status: 502 };
    }
    const parsed = extractJsonObject(content);
    return {
      ok: true,
      data: normalizeAiPayload(opts.symbol, opts.tf, parsed, opts.modelLabel),
    };
  } catch {
    return { ok: false, status: 504 };
  }
}

export async function analyzeMarketWithGemini(
  rawBody: unknown
): Promise<{ ok: true; status: number; data: AiAnalyzeResponsePayload } | { ok: false; status: number; error: string }> {
  const apiKey = resolveGeminiApiKey();
  const groqKey = resolveGroqApiKey();
  const openRouterKey = resolveOpenRouterApiKey();

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

  const candles = body.recentCandles.slice(-14).map((c) => [
    String(c.t || '').slice(11, 16) || String(c.t || '').slice(0, 16),
    Number(c.o),
    Number(c.h),
    Number(c.l),
    Number(c.c),
  ]);
  const latestCandleTag = candles[candles.length - 1]?.[0] || '';
  const cacheKey = `${symbol}:${tf}:${lang}:${latestCandleTag}:${body.quantSignal?.state || ''}`;
  const cached = serverAiCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, status: 200, data: cached.payload };
  }

  const langInstruction =
    lang === 'kh'
      ? 'Write srVerdict, reversalAlert, entryPlan, riskNote, summary in concise Khmer (ភាសាខ្មែរ) under 18 words each using ONLY exact numbers from Snapshot.'
      : 'Write srVerdict, reversalAlert, entryPlan, riskNote, summary in crisp English under 18 words each using ONLY exact numbers from Snapshot.';

  const promptPayload = {
    s: symbol,
    tf,
    q: body.quote,
    lvl: body.keyLevels,
    sig: body.quantSignal,
    ohlc14: candles,
  };
  const snapshotMessage = `Snapshot ${symbol} ${tf}:\n${JSON.stringify(promptPayload)}`;

  const allGeminiModels = Array.from(
    new Set([process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite', 'gemini-4-hydrogen'])
  );
  const nowMs = Date.now();
  const activeGeminiModels = allGeminiModels.filter((m) => (modelCooldownUntil.get(m) || 0) <= nowMs);

  let lastErr: { status: number; message: string } = { status: 503, message: 'All AI engines busy.' };
  const attemptNotes: string[] = [];
  const startedAt = Date.now();

  if (apiKey && activeGeminiModels.length > 0) {
    const aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        timeout: 15000,
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    for (const modelName of activeGeminiModels) {
      if (Date.now() - startedAt > 18000) break;
      const t0 = Date.now();
      try {
        const config: Record<string, unknown> = {
          abortSignal: AbortSignal.timeout(10500),
          systemInstruction:
            `Institutional Forex/Gold/Crypto S/R & price-action analyst. Evaluate ohlc14 ([HH:MM,O,H,L,C]) vs R1/R2/S1/S2/PDH/PDL, EMA8/21, MACD, RSI14, ATR14. ` +
            `Highlight S/R rejections/bounces (reversals at R1/R2 or S1/S2) vs breakouts. Never invent prices. ${langInstruction}`,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              bias: { type: Type.STRING, description: 'BUY, SELL, or WAIT.' },
              confidence: { type: Type.INTEGER, description: '0 to 100.' },
              setupType: { type: Type.STRING, description: '2-4 word setup name.' },
              srVerdict: { type: Type.STRING, description: 'Price vs S1/R1/PDH/PDL.' },
              reversalAlert: { type: Type.STRING, description: 'Reversal at R1/R2/S1/S2 or None.' },
              entryPlan: { type: Type.STRING, description: 'Exact entry zone, TP1, SL.' },
              riskNote: { type: Type.STRING, description: 'Invalidation price.' },
              summary: { type: Type.STRING, description: 'One-sentence verdict.' },
            },
            required: ['bias', 'confidence', 'setupType', 'srVerdict', 'reversalAlert', 'entryPlan', 'riskNote', 'summary'],
          },
        };

        if (modelName === 'gemini-4-hydrogen') {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
        }

        const response = await aiClient.models.generateContent({
          model: modelName,
          contents: snapshotMessage,
          config: config as any,
        });

        const parsed = extractJsonObject(response.text ?? '{}');
        const payload = normalizeAiPayload(symbol, tf, parsed, modelName);

        serverAiCache.set(cacheKey, { payload, expiresAt: Date.now() + 120000 });
        if (serverAiCache.size > 60) {
          const oldestKey = serverAiCache.keys().next().value;
          if (oldestKey) serverAiCache.delete(oldestKey);
        }

        return { ok: true, status: 200, data: payload };
      } catch (err) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const formatted = formatGeminiError(err);
        lastErr = { status: formatted.status, message: formatted.message };
        attemptNotes.push(`${modelName}:${formatted.status}(${elapsed}s)`);
        if (formatted.retryableWithFallback) {
          modelCooldownUntil.set(modelName, Date.now() + (formatted.status === 429 ? 65000 : 120000));
          continue;
        }
      }
    }
  } else if (apiKey) {
    attemptNotes.push('gemini:cooldown');
  }

  // Fallback 1: Groq (optional fast key)
  if (groqKey && (modelCooldownUntil.get('groq') || 0) <= Date.now() && Date.now() - startedAt < 21000) {
    const t0 = Date.now();
    const groqModel = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    const groqRes = await analyzeWithOpenAiCompatibleEndpoint({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      headers: { Authorization: `Bearer ${groqKey}` },
      timeoutMs: 7500,
      symbol,
      tf,
      modelLabel: `groq:${groqModel}`,
      body: {
        model: groqModel,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              `Institutional Forex/Gold/Crypto S/R & price-action analyst. Evaluate ohlc14 ([HH:MM,O,H,L,C]) vs R1/R2/S1/S2/PDH/PDL, EMA8/21, MACD, RSI14, ATR14. ` +
              `Highlight S/R rejections/bounces vs breakouts. Never invent prices. ${langInstruction} ` +
              `Return ONLY a valid JSON object with keys: bias ("BUY"|"SELL"|"WAIT"), confidence (integer 0..100), setupType, srVerdict, reversalAlert, entryPlan, riskNote, summary.`,
          },
          { role: 'user', content: snapshotMessage },
        ],
      },
    });
    if (groqRes.ok) {
      serverAiCache.set(cacheKey, { payload: groqRes.data, expiresAt: Date.now() + 120000 });
      return { ok: true, status: 200, data: groqRes.data };
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    attemptNotes.push(`groq:${groqRes.status}(${elapsed}s)`);
    modelCooldownUntil.set('groq', Date.now() + 60000);
  }

  // Fallback 2: OpenRouter free-tier models (optional free key)
  if (openRouterKey && (modelCooldownUntil.get('openrouter') || 0) <= Date.now() && Date.now() - startedAt < 21000) {
    const t0 = Date.now();
    const orModel = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
    const orRes = await analyzeWithOpenAiCompatibleEndpoint({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: {
        Authorization: `Bearer ${openRouterKey}`,
        'X-Title': 'NETHAGA PRO',
      },
      timeoutMs: 8500,
      symbol,
      tf,
      modelLabel: `openrouter:${orModel.split('/').pop() || 'free'}`,
      body: {
        model: orModel,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              `Institutional Forex/Gold/Crypto S/R & price-action analyst. Evaluate ohlc14 vs R1/R2/S1/S2/PDH/PDL, EMA8/21, MACD, RSI14, ATR14. ` +
              `Never invent prices. ${langInstruction} ` +
              `Return ONLY a valid JSON object with keys: bias ("BUY"|"SELL"|"WAIT"), confidence (integer 0..100), setupType, srVerdict, reversalAlert, entryPlan, riskNote, summary.`,
          },
          { role: 'user', content: snapshotMessage },
        ],
      },
    });
    if (orRes.ok) {
      serverAiCache.set(cacheKey, { payload: orRes.data, expiresAt: Date.now() + 120000 });
      return { ok: true, status: 200, data: orRes.data };
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    attemptNotes.push(`openrouter:${orRes.status}(${elapsed}s)`);
    modelCooldownUntil.set('openrouter', Date.now() + 60000);
  }

  // Fallback 3: Free keyless OVHcloud AI Endpoint (Meta-Llama-3.3-70B-Instruct)
  if ((modelCooldownUntil.get('ovh-llama') || 0) <= Date.now() && Date.now() - startedAt < 21000) {
    const t0 = Date.now();
    const ovhRes = await analyzeWithOpenAiCompatibleEndpoint({
      url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions',
      timeoutMs: 6500,
      symbol,
      tf,
      modelLabel: 'ovh:Llama-3.3-70B',
      body: {
        model: 'Meta-Llama-3_3-70B-Instruct',
        temperature: 0.2,
        max_tokens: 480,
        messages: [
          {
            role: 'system',
            content:
              `Institutional Forex/Gold/Crypto S/R & price-action analyst. Evaluate ohlc14 vs R1/R2/S1/S2/PDH/PDL, EMA8/21, MACD, RSI14, ATR14. ` +
              `Never invent prices. ${langInstruction} ` +
              `Return ONLY a valid JSON object with keys: bias ("BUY"|"SELL"|"WAIT"), confidence (integer 0..100), setupType, srVerdict, reversalAlert, entryPlan, riskNote, summary.`,
          },
          { role: 'user', content: snapshotMessage },
        ],
      },
    });
    if (ovhRes.ok) {
      serverAiCache.set(cacheKey, { payload: ovhRes.data, expiresAt: Date.now() + 120000 });
      return { ok: true, status: 200, data: ovhRes.data };
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    attemptNotes.push(`ovh:${ovhRes.status}(${elapsed}s)`);
    modelCooldownUntil.set('ovh-llama', Date.now() + (ovhRes.status === 429 ? 65000 : 45000));
  }

  // Fallback 4: Free keyless Pollinations AI (gpt-oss-20b; crisp English exact-number mode so no mangled numbers)
  if ((modelCooldownUntil.get('pollinations') || 0) <= Date.now() && Date.now() - startedAt < 23000) {
    const t0 = Date.now();
    const pollRes = await analyzeWithOpenAiCompatibleEndpoint({
      url: 'https://text.pollinations.ai/openai',
      timeoutMs: 12000,
      symbol,
      tf,
      modelLabel: 'pollinations:gpt-oss-20b',
      body: {
        model: 'openai',
        jsonMode: true,
        private: true,
        messages: [
          {
            role: 'system',
            content:
              `Institutional Forex/Gold/Crypto S/R & price-action analyst. Strictly use ONLY exact numbers from Snapshot (never invent prices or lots). ` +
              `Return ONLY a valid JSON object with keys: bias ("BUY"|"SELL"|"WAIT"), confidence (integer 0..100), setupType, srVerdict, reversalAlert, entryPlan, riskNote, summary. Write crisp English under 18 words per field.`,
          },
          { role: 'user', content: snapshotMessage },
        ],
      },
    });
    if (pollRes.ok) {
      serverAiCache.set(cacheKey, { payload: pollRes.data, expiresAt: Date.now() + 120000 });
      return { ok: true, status: 200, data: pollRes.data };
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    attemptNotes.push(`pollinations:${pollRes.status}(${elapsed}s)`);
    modelCooldownUntil.set('pollinations', Date.now() + 25000);
  }

  return {
    ok: false,
    status: lastErr.status,
    error: attemptNotes.length ? `${lastErr.message} [${attemptNotes.join(', ')}]` : lastErr.message,
  };
}
