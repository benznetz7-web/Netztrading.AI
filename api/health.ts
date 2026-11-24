export default function handler(_req: any, res: any) {
  res.status(200).json({
    ok: true,
    aiConfigured: Boolean(process.env.GEMINI_API_KEY),
    runtime: 'vercel',
  });
}
