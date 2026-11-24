import { analyzeMarketWithGemini } from '../src/server/aiAnalyzeCore.ts';

export default async function handler(req: any, res: any) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ error: 'Invalid JSON request body.' });
      return;
    }
  }

  const result = await analyzeMarketWithGemini(body);
  if (result.ok) {
    res.status(result.status).json(result.data);
  } else {
    res.status(result.status).json({ error: result.error });
  }
}
