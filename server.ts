import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeMarketWithGemini, resolveGeminiApiKey } from './src/server/aiAnalyzeCore.ts';
import { proxyBiquoteGet } from './src/server/biquoteProxyCore.ts';
import { fetchFallbackCandles, fetchFallbackQuotes } from './src/server/marketFallbackCore.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, aiConfigured: Boolean(resolveGeminiApiKey()) });
  });

  app.post('/api/ai-analyze', async (req, res) => {
    const result = await analyzeMarketWithGemini(req.body);
    if (result.ok) {
      res.status(result.status).json(result.data);
    } else {
      res.status(result.status).json({ error: result.error });
    }
  });

  app.get('/api/biquote', async (req, res) => {
    const p = Array.isArray(req.query?.path) ? req.query.path[0] : req.query?.path;
    const result = await proxyBiquoteGet(p);
    if (result.ok) {
      res.status(result.status).json(result.data);
    } else {
      res.status(result.status).json({ error: result.error });
    }
  });

  app.get('/api/market-fallback', async (req, res) => {
    const mode = Array.isArray(req.query?.mode) ? req.query.mode[0] : req.query?.mode;
    if (mode === 'quotes') {
      const quotes = await fetchFallbackQuotes();
      const count = Object.keys(quotes).length;
      if (!count) {
        res.status(502).json({ error: 'Backup quote providers unavailable' });
        return;
      }
      res.json({ ok: true, count, quotes });
      return;
    }
    if (mode === 'candles') {
      const symbol = String(Array.isArray(req.query?.symbol) ? req.query.symbol[0] : req.query?.symbol || '');
      const tf = String(Array.isArray(req.query?.tf) ? req.query.tf[0] : req.query?.tf || '');
      const result = await fetchFallbackCandles(symbol, tf);
      if (result.ok) {
        res.json(result);
      } else {
        res.status(result.status).json({ error: result.error });
      }
      return;
    }
    res.status(400).json({ error: 'Invalid mode. Use mode=quotes or mode=candles.' });
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
      },
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

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`NETHAGA server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
