import { resolveGeminiApiKey } from '../src/server/aiAnalyzeCore.ts';

export default function handler(_req: any, res: any) {
  res.status(200).json({
    ok: true,
    aiConfigured: Boolean(resolveGeminiApiKey()),
    runtime: 'vercel',
  });
}
