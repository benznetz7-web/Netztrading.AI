import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';

const aiClient = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

interface AiAnalyzeBody {
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
}

const VALID_SYMBOL_RE = /^[A-Z0-9]{3,12}$/;
const VALID_TF_SET = new Set(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1']);

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, aiConfigured: Boolean(aiClient) });
  });

  app.post('/api/ai-analyze', async (req, res) => {
    if (!aiClient) {
      res.status(503).json({
        error: 'GEMINI_API_KEY is not configured in environment secrets.',
      });
      return;
    }

    const body = req.body as Partial<AiAnalyzeBody> | null;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Invalid JSON body.' });
      return;
    }

    const symbol = String(body.symbol || '').toUpperCase().trim();
    const tf = String(body.tf || '').toUpperCase().trim();
    const lang = body.lang === 'kh' ? 'kh' : 'en';

    if (!VALID_SYMBOL_RE.test(symbol) || !VALID_TF_SET.has(tf)) {
      res.status(400).json({ error: 'Invalid symbol or timeframe.' });
      return;
    }

    if (!body.quote || !Number.isFinite(Number(body.quote.mid)) || !Array.isArray(body.recentCandles) || body.recentCandles.length < 5) {
      res.status(400).json({ error: 'Insufficient live quote or candle context for AI analysis.' });
      return;
    }

    const candles = body.recentCandles.slice(-24).map((c) => ({
      t: String(c.t || '').slice(0, 19),
      o: Number(c.o),
      h: Number(c.h),
      l: Number(c.l),
      c: Number(c.c),
    }));

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

    try {
      const response = await aiClient.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Analyze this live market snapshot for ${symbol} on ${tf} and give a fast, decisive trading verdict:\n${JSON.stringify(promptPayload)}`,
        config: {
          systemInstruction:
            `You are an institutional Forex, Gold & Crypto price-action & S/R quant analyst inside a fast trading terminal. ` +
            `Evaluate the last 24 OHLC candles against R1/R2/S1/S2/PDH/PDL, EMA 8/21, MACD, RSI(14), ATR(14), and market structure. ` +
            `Pay special attention to REVERSALS AT RESISTANCE (R1/R2/PDH rejection wicks, lower highs, RSI overbought turn) and REVERSALS AT SUPPORT (S1/S2/PDL bounce wicks, higher lows, RSI oversold turn), as well as clean trend continuation/breakouts. ` +
            `Never invent prices outside the provided candles/levels. Keep every field crisp and under 25 words. ${langInstruction}`,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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
                description: 'Short 2-4 word setup name, e.g. S1 Bounce Reversal, R1 Rejection Sell, EMA Trend Continuation, Squeeze Breakout.',
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
        },
      });

      const rawText = (response.text ?? '{}').trim();
      const parsed = JSON.parse(rawText);
      const rawBias = String(parsed.bias || 'WAIT').toUpperCase();
      const bias = rawBias === 'BUY' || rawBias === 'SELL' ? rawBias : 'WAIT';
      const confidence = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 50)));

      res.json({
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
      });
    } catch (err: any) {
      const msg = err?.message || 'Gemini AI analysis failed';
      res.status(502).json({ error: msg });
    }
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`NETHAGA server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
