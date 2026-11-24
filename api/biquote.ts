import { proxyBiquoteGet } from '../src/server/biquoteProxyCore.ts';

export default async function handler(req: any, res: any) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const p = Array.isArray(req.query?.path) ? req.query.path[0] : req.query?.path;
  const result = await proxyBiquoteGet(p);
  if (result.ok) {
    res.status(result.status).json(result.data);
  } else {
    res.status(result.status).json({ error: result.error });
  }
}
