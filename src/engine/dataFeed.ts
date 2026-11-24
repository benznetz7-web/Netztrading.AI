import {
  BIQUOTE_BASE,
  FRESHNESS_LIMITS_SEC,
  SUPPORTED_SYMBOLS,
  SYMBOL_SPECS,
  TF_PROFILES,
} from '../constants/markets';
import type {
  CandleBar,
  CandleBundle,
  FreshnessResult,
  ProviderType,
  QuoteData,
  TimeframeKey,
} from '../types/trading';
import { aggregateWeeklyFromDaily } from './indicators';

export type QuotesByProvider = Record<ProviderType, Record<string, QuoteData>>;

let rateLimitUntilMs = 0;
let biquoteDownUntilMs = 0;
let activeFeedMode: 'BIQUOTE' | 'BACKUP' = 'BIQUOTE';

export function getActiveFeedMode(): 'BIQUOTE' | 'BACKUP' {
  return activeFeedMode;
}

export function resetBiquoteBackoff(): void {
  biquoteDownUntilMs = 0;
}

export function safeFetch(url: string, opt: RequestInit = {}, ms = 15000): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opt, signal: c.signal }).finally(() => clearTimeout(t));
}

export async function biquoteFetchJson(url: string, retries = 1): Promise<any> {
  if (Date.now() < rateLimitUntilMs) throw new Error('Rate limited (429)');
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await safeFetch(url, {}, 15000);
      if (r.status === 429) {
        const ra = Number(r.headers.get('Retry-After') || '15');
        rateLimitUntilMs = Date.now() + Math.max(5, ra) * 1000;
        throw new Error(`HTTP 429 retry in ${ra}s`);
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rawText = await r.text();
      try {
        return JSON.parse(rawText);
      } catch {
        throw new Error(`Invalid JSON (HTTP ${r.status})`);
      }
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || err || '');
      if (msg.includes('HTTP 429') || attempt >= retries) break;
      await new Promise((res) => setTimeout(res, 450));
    }
  }

  // Fallback to same-origin /api/biquote proxy in browser so CORS-stripped 502/503 pages don't show cryptic "Load failed"
  if (typeof window !== 'undefined' && url.startsWith(BIQUOTE_BASE)) {
    const relPath = url.slice(BIQUOTE_BASE.length);
    try {
      const pr = await safeFetch(`/api/biquote?path=${encodeURIComponent(relPath)}`, {}, 12000);
      const raw = await pr.text();
      let parsed: any = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        // ignore
      }
      if (pr.ok && parsed) return parsed;
      if (parsed?.error) throw new Error(String(parsed.error));
      if (!pr.ok) throw new Error(`BIQUOTE HTTP ${pr.status}`);
    } catch (proxyErr: any) {
      if (proxyErr?.message && !String(proxyErr.message).includes('Load failed')) {
        throw proxyErr;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr || 'Network error'));
}

export function ingestQuoteUpdate(
  quotesByProvider: QuotesByProvider,
  sym: string,
  raw: any,
  prov: ProviderType,
  reqTs = false
): { accepted: boolean; reason?: string; quote?: QuoteData } {
  if (!raw || typeof raw !== 'object') return { accepted: false, reason: 'Empty payload' };
  const bid = Number(raw.bid);
  const ask = Number(raw.ask);
  if (!(bid > 0) || !(ask >= bid) || !Number.isFinite(bid) || !Number.isFinite(ask)) {
    return { accepted: false, reason: 'Invalid bid/ask' };
  }
  const rawTs = raw.timestamp || raw.time || (raw.time_msc ? Number(raw.time_msc) : null);
  if (reqTs && !rawTs) return { accepted: false, reason: 'Missing timestamp' };
  const tsMs = typeof rawTs === 'number' ? rawTs : rawTs ? Date.parse(rawTs) : NaN;
  if (!Number.isFinite(tsMs) || tsMs <= 0) return { accepted: false, reason: 'Invalid timestamp' };

  const ex = quotesByProvider[prov]?.[sym];
  if (ex) {
    if (tsMs < ex.providerTsMs) return { accepted: false, reason: 'Out-of-order ignored' };
    if (tsMs === ex.providerTsMs && bid === ex.bid && ask === ex.ask) {
      return { accepted: false, reason: 'Duplicate (age preserved)' };
    }
  }

  const mid = Number.isFinite(Number(raw.mid)) && Number(raw.mid) > 0 ? Number(raw.mid) : (bid + ask) / 2;
  const spread = Number.isFinite(Number(raw.spread)) ? Number(raw.spread) : ask - bid;
  const srvAge = Number.isFinite(Number(raw.quoteAgeSeconds)) ? Math.max(0, Number(raw.quoteAgeSeconds)) : null;
  const ms = String(raw.marketState || 'open').toLowerCase();

  const norm: QuoteData = {
    symbol: sym,
    provider: prov,
    source: raw.source || prov,
    bid,
    ask,
    mid,
    spread,
    high: Number.isFinite(Number(raw.high)) ? Number(raw.high) : null,
    low: Number.isFinite(Number(raw.low)) ? Number(raw.low) : null,
    dayDiffPercent: ms === 'closed' ? null : Number.isFinite(Number(raw.dayDiffPercent)) ? Number(raw.dayDiffPercent) : null,
    timestamp: new Date(tsMs).toISOString(),
    providerTsMs: tsMs,
    localReceiptMs: Date.now(),
    serverQuoteAgeSeconds: srvAge,
    marketState: ms,
    staleFlag: Boolean(raw.stale),
    digits: Number.isInteger(Number(raw.digits)) ? Number(raw.digits) : SYMBOL_SPECS[sym]?.digits ?? 2,
  };

  if (!quotesByProvider[prov]) quotesByProvider[prov] = {};
  quotesByProvider[prov][sym] = norm;
  return { accepted: true, quote: norm };
}

export function evaluateQuoteFreshness(
  quote: QuoteData | null | undefined,
  tf: TimeframeKey,
  nowMs: number = Date.now()
): FreshnessResult {
  const limit = FRESHNESS_LIMITS_SEC[tf] || 150;
  if (!quote) {
    return {
      available: false,
      fresh: false,
      status: 'UNAVAILABLE',
      ageSeconds: Infinity,
      limitSec: limit,
      label: 'DATA UNAVAILABLE',
    };
  }
  const age = Math.max(
    Math.max(0, Math.floor((nowMs - quote.providerTsMs) / 1000)),
    Math.max(0, Math.floor((nowMs - quote.localReceiptMs) / 1000)),
    quote.serverQuoteAgeSeconds ?? 0
  );
  if (quote.marketState === 'closed') {
    return { available: true, fresh: false, status: 'CLOSED', ageSeconds: age, limitSec: limit, label: 'MARKET CLOSED' };
  }
  if (quote.staleFlag || age > limit) {
    return {
      available: true,
      fresh: false,
      status: 'STALE',
      ageSeconds: age,
      limitSec: limit,
      label: `STALE (${age}s > ${limit}s)`,
    };
  }
  return { available: true, fresh: true, status: 'LIVE', ageSeconds: age, limitSec: limit, label: 'LIVE' };
}

export async function checkBiquoteActiveSymbols(): Promise<Set<string>> {
  const d = await biquoteFetchJson(`${BIQUOTE_BASE}/api/active`);
  const f = new Set<string>();
  if (Array.isArray(d)) {
    d.forEach((x) => {
      if (typeof x === 'string') f.add(x.toUpperCase());
      else {
        if (x?.symbol) f.add(String(x.symbol).toUpperCase());
        if (x?.name) f.add(String(x.name).toUpperCase());
      }
    });
  }
  return f;
}

export async function fetchBackupQuotesSnapshot(
  quotesByProvider: QuotesByProvider,
  onlySymbol?: string
): Promise<{ count: number; sources: string[] }> {
  const qs = onlySymbol ? `&symbol=${encodeURIComponent(onlySymbol)}` : '';
  const r = await safeFetch(`/api/market-fallback?mode=quotes${qs}`, { cache: 'no-store' }, onlySymbol ? 6000 : 12000);
  const raw = await r.text();
  let parsed: any = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`Backup feed format error (HTTP ${r.status})`);
  }
  if (!r.ok || !parsed?.quotes) {
    throw new Error(parsed?.error || `Backup feed HTTP ${r.status}`);
  }
  let count = 0;
  const sources = new Set<string>();
  for (const [sym, q] of Object.entries<any>(parsed.quotes)) {
    if (!SUPPORTED_SYMBOLS.includes(sym)) continue;
    const res = ingestQuoteUpdate(quotesByProvider, sym, q, 'BIQUOTE', true);
    if (res.accepted || res.reason === 'Duplicate (age preserved)') {
      count++;
      if (q?.source) sources.add(String(q.source));
    }
  }
  if (!count) throw new Error('Backup feed returned no valid quotes');
  return { count, sources: Array.from(sources) };
}

export async function fetchBiquoteLatestSnapshot(
  quotesByProvider: QuotesByProvider,
  onlySymbol?: string
): Promise<'BIQUOTE' | 'BACKUP'> {
  if (typeof window !== 'undefined' && Date.now() < biquoteDownUntilMs) {
    await fetchBackupQuotesSnapshot(quotesByProvider, onlySymbol);
    activeFeedMode = 'BACKUP';
    return 'BACKUP';
  }

  const forexSyms = SUPPORTED_SYMBOLS.filter((s) => SYMBOL_SPECS[s].desk === 'FOREX');
  const cryptoSyms = SUPPORTED_SYMBOLS.filter((s) => SYMBOL_SPECS[s].desk === 'CRYPTO');

  const fetchBatch = async (list: string[]) => {
    const p = await biquoteFetchJson(
      `${BIQUOTE_BASE}/api/latest?${list.map((s) => `symbols=${encodeURIComponent(s)}`).join('&')}`
    );
    const ent: Array<[string, any]> = Array.isArray(p)
      ? p.map((x) => [String(x?.symbol || '').toUpperCase(), x])
      : Object.entries(p || {}).map(([k, v]) => [String(k).toUpperCase(), v]);
    for (const [sym, raw] of ent) {
      if (SUPPORTED_SYMBOLS.includes(sym)) ingestQuoteUpdate(quotesByProvider, sym, raw, 'BIQUOTE', true);
    }
  };

  const results = await Promise.allSettled([fetchBatch(forexSyms), fetchBatch(cryptoSyms)]);
  if (results.every((r) => r.status === 'rejected')) {
    biquoteDownUntilMs = Date.now() + 30000;
    if (typeof window !== 'undefined') {
      try {
        await fetchBackupQuotesSnapshot(quotesByProvider);
        activeFeedMode = 'BACKUP';
        return 'BACKUP';
      } catch {
        // surface primary error below if backup also fails
      }
    }
    throw (results[0] as PromiseRejectedResult).reason;
  }
  biquoteDownUntilMs = 0;
  activeFeedMode = 'BIQUOTE';
  return 'BIQUOTE';
}

async function fetchBackupSymbolCandles(
  sym: string,
  tf: TimeframeKey,
  candlesCache: Record<string, CandleBundle>,
  cacheKey: string
): Promise<CandleBundle> {
  const r = await safeFetch(
    `/api/market-fallback?mode=candles&symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`,
    {},
    12000
  );
  const raw = await r.text();
  let parsed: any = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`Backup OHLC format error (HTTP ${r.status})`);
  }
  if (!r.ok || !parsed?.ok || !Array.isArray(parsed.closedBars)) {
    throw new Error(parsed?.error || `Backup OHLC HTTP ${r.status}`);
  }
  const closedBars: CandleBar[] = parsed.closedBars
    .map((b: any) => ({
      openTime: b.openTime,
      timeMs: Number(b.timeMs),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      isOpen: false,
    }))
    .filter((b: CandleBar) => Number.isFinite(b.timeMs) && [b.open, b.high, b.low, b.close].every(Number.isFinite))
    .sort((a: CandleBar, b: CandleBar) => a.timeMs - b.timeMs);

  const fb = parsed.formingBar
    ? {
        openTime: parsed.formingBar.openTime,
        timeMs: Number(parsed.formingBar.timeMs),
        open: Number(parsed.formingBar.open),
        high: Number(parsed.formingBar.high),
        low: Number(parsed.formingBar.low),
        close: Number(parsed.formingBar.close),
        isOpen: true,
      }
    : null;

  if (closedBars.length < 20) {
    throw new Error(`Insufficient backup bars for ${sym} (${tf})`);
  }
  const res: CandleBundle = {
    closedBars,
    formingBar: fb && Number.isFinite(fb.close) ? fb : null,
    fetchedAt: Date.now(),
  };
  candlesCache[cacheKey] = res;
  activeFeedMode = 'BACKUP';
  return res;
}

export async function fetchSymbolCandles(
  provider: ProviderType,
  sym: string,
  tf: TimeframeKey,
  candlesCache: Record<string, CandleBundle>,
  allowCache = false
): Promise<CandleBundle> {
  const key = `${provider}:${sym}:${tf}`;
  const c = candlesCache[key];
  const maxAge = (TF_PROFILES[tf]?.seconds || 300) >= 3600 ? 90000 : 12000;
  if (allowCache && c && Date.now() - c.fetchedAt < maxAge) return c;

  if (provider === 'EXNESS') {
    const r = await safeFetch(`/api/candles?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}&limit=300`);
    if (!r.ok) throw new Error(`EXNESS HTTP ${r.status}`);
    const d = await r.json();
    if (!d.connected || !Array.isArray(d.candles)) throw new Error(d.error || 'Bridge disconnected');
    const bars: CandleBar[] = d.candles
      .map((x: any) => ({
        timeMs: Number(x.time) * 1000,
        open: Number(x.open),
        high: Number(x.high),
        low: Number(x.low),
        close: Number(x.close),
        isOpen: Boolean(x.isOpen),
      }))
      .filter((x: CandleBar) => Number.isFinite(x.timeMs) && [x.open, x.high, x.low, x.close].every(Number.isFinite))
      .sort((a: CandleBar, b: CandleBar) => a.timeMs - b.timeMs);

    const res: CandleBundle = {
      closedBars: bars.filter((b) => !b.isOpen),
      formingBar: bars.find((b) => b.isOpen) || null,
      fetchedAt: Date.now(),
    };
    candlesCache[key] = res;
    return res;
  }

  if (tf === 'W1') {
    const d1 = await fetchSymbolCandles(provider, sym, 'D1', candlesCache, allowCache);
    const wk = aggregateWeeklyFromDaily(d1.closedBars, d1.formingBar);
    const res: CandleBundle = { ...wk, fetchedAt: Date.now() };
    candlesCache[key] = res;
    return res;
  }

  if (typeof window !== 'undefined' && Date.now() < biquoteDownUntilMs) {
    return fetchBackupSymbolCandles(sym, tf, candlesCache, key);
  }

  try {
    const iv = TF_PROFILES[tf]?.biquote;
    const p = await biquoteFetchJson(
      `${BIQUOTE_BASE}/api/${encodeURIComponent(sym)}/ohlc?interval=${encodeURIComponent(iv)}&limit=300`
    );
    const rb = Array.isArray(p?.bars) ? p.bars : [];
    if (!rb.length) throw new Error(`No OHLC bars for ${sym} (${iv})`);

    const parsed: CandleBar[] = rb
      .map((b: any) => ({
        openTime: b.openTime,
        timeMs: Date.parse(b.openTime),
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
        isOpen: Boolean(b.isOpen),
      }))
      .filter((b: CandleBar) => Number.isFinite(b.timeMs) && [b.open, b.high, b.low, b.close].every(Number.isFinite))
      .sort((a: CandleBar, b: CandleBar) => a.timeMs - b.timeMs);

    const f = parsed.filter((b) => b.isOpen);
    const res: CandleBundle = {
      closedBars: parsed.filter((b) => !b.isOpen),
      formingBar: f.length ? f[f.length - 1] : null,
      fetchedAt: Date.now(),
    };
    candlesCache[key] = res;
    biquoteDownUntilMs = 0;
    activeFeedMode = 'BIQUOTE';
    return res;
  } catch (err) {
    biquoteDownUntilMs = Date.now() + 30000;
    if (typeof window !== 'undefined') {
      try {
        return await fetchBackupSymbolCandles(sym, tf, candlesCache, key);
      } catch {
        // throw original error if backup also fails
      }
    }
    throw err;
  }
}

export function playSignalSound(): void {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    [587.33, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const s = ctx.currentTime + i * 0.16;
      o.type = 'sine';
      o.frequency.setValueAtTime(f, s);
      g.gain.setValueAtTime(0.18, s);
      g.gain.exponentialRampToValueAtTime(0.001, s + 0.35);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(s);
      o.stop(s + 0.36);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1200);
  } catch {
    // Ignore audio context restriction errors
  }
}
