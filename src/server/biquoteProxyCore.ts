const BIQUOTE_ORIGIN = 'https://biquote.io';
const ALLOWED_PATH_RE = /^\/api\/(active|latest|[A-Z0-9]{3,12}\/ohlc)$/;

export async function proxyBiquoteGet(
  rawPath: unknown
): Promise<{ ok: true; status: number; data: unknown } | { ok: false; status: number; error: string }> {
  const input = String(rawPath || '').trim();
  if (!input.startsWith('/api/')) {
    return { ok: false, status: 400, error: 'Invalid BIQUOTE endpoint path.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(input, BIQUOTE_ORIGIN);
  } catch {
    return { ok: false, status: 400, error: 'Malformed BIQUOTE path.' };
  }

  if (parsed.origin !== BIQUOTE_ORIGIN || !ALLOWED_PATH_RE.test(parsed.pathname)) {
    return { ok: false, status: 403, error: 'Endpoint not allowed.' };
  }

  const targetUrl = `${BIQUOTE_ORIGIN}${parsed.pathname}${parsed.search}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);

  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    const raw = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status === 429 ? 429 : 502,
        error: `BIQUOTE server HTTP ${res.status}${res.status === 502 ? ' (Bad Gateway — upstream down)' : ''}`,
      };
    }
    try {
      return { ok: true, status: 200, data: JSON.parse(raw) };
    } catch {
      return { ok: false, status: 502, error: `BIQUOTE returned non-JSON (HTTP ${res.status})` };
    }
  } catch (err: any) {
    return {
      ok: false,
      status: 504,
      error: `BIQUOTE unreachable: ${err?.name === 'AbortError' ? 'Timeout' : err?.message || 'Network error'}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
