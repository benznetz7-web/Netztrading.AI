import { fetchFallbackCandles, fetchFallbackQuotes } from '../src/server/marketFallbackCore.ts';

export default async function handler(req: any, res: any) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const mode = String(Array.isArray(req.query?.mode) ? req.query.mode[0] : req.query?.mode || 'quotes');
  if (mode === 'quotes') {
    const quotes = await fetchFallbackQuotes();
    res.status(200).json({ source: 'BACKUP (SWISSQUOTE/KRAKEN)', quotes });
    return;
  }

  if (mode === 'candles') {
    const symbol = String(Array.isArray(req.query?.symbol) ? req.query.symbol[0] : req.query?.symbol || '');
    const tf = String(Array.isArray(req.query?.tf) ? req.query.tf[0] : req.query?.tf || 'M15');
    const result = await fetchFallbackCandles(symbol, tf);
    if (result.ok) {
      res.status(200).json(result);
    } else {
      res.status(result.status).json({ error: result.error });
    }
    return;
  }

  res.status(400).json({ error: 'Invalid mode.' });
}
