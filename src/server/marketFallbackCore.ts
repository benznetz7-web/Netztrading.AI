export interface FallbackQuote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  timestamp: string;
  source: string;
  marketState: string;
}

export interface FallbackCandle {
  openTime: string;
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  isOpen: boolean;
}

const SWISSQUOTE_MAP: Record<string, string> = {
  XAUUSD: 'XAU/USD',
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  AUDUSD: 'AUD/USD',
  USDCAD: 'USD/CAD',
  USDCHF: 'USD/CHF',
  NZDUSD: 'NZD/USD',
};

const YAHOO_FX_MAP: Record<string, string> = {
  XAUUSD: 'GC=F',
  EURUSD: 'EURUSD=X',
  GBPUSD: 'GBPUSD=X',
  USDJPY: 'JPY=X',
  AUDUSD: 'AUDUSD=X',
  USDCAD: 'CAD=X',
  USDCHF: 'CHF=X',
  NZDUSD: 'NZDUSD=X',
};

const KRAKEN_PAIR_MAP: Record<string, { req: string; resKeys: string[] }> = {
  BTCUSD: { req: 'XBTUSD', resKeys: ['XXBTZUSD', 'XBTUSD'] },
  ETHUSD: { req: 'ETHUSD', resKeys: ['XETHZUSD', 'ETHUSD'] },
  SOLUSD: { req: 'SOLUSD', resKeys: ['SOLUSD'] },
  XRPUSD: { req: 'XRPUSD', resKeys: ['XXRPZUSD', 'XRPUSD'] },
  BNBUSD: { req: 'BNBUSD', resKeys: ['BNBUSD'] },
  LTCUSD: { req: 'LTCUSD', resKeys: ['XLTCZUSD', 'LTCUSD'] },
};

const TF_SECONDS: Record<string, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
  W1: 604800,
};

const KRAKEN_INTERVAL: Record<string, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D1: 1440,
  W1: 10080,
};

async function fetchJsonWithTimeout(url: string, headers: Record<string, string> = {}, ms = 9000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const txt = await res.text();
    return JSON.parse(txt);
  } finally {
    clearTimeout(t);
  }
}

async function fetchSwissquoteSingle(sym: string, instr: string): Promise<FallbackQuote | null> {
  try {
    const arr = await fetchJsonWithTimeout(
      `https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${instr}`,
      { Accept: 'application/json' },
      7000
    );
    if (!Array.isArray(arr) || !arr.length) return null;
    const item = arr[0];
    const prices = Array.isArray(item?.spreadProfilePrices) ? item.spreadProfilePrices : [];
    const pick =
      prices.find((p: any) => p?.spreadProfile === 'prime') ||
      prices.find((p: any) => p?.spreadProfile === 'standard') ||
      prices[0];
    const bid = Number(pick?.bid);
    const ask = Number(pick?.ask);
    if (!(bid > 0) || !(ask >= bid)) return null;
    const ts = Number(item?.ts) || Date.now();
    return {
      symbol: sym,
      bid,
      ask,
      mid: (bid + ask) / 2,
      spread: ask - bid,
      timestamp: new Date(ts).toISOString(),
      source: 'SWISSQUOTE',
      marketState: 'open',
    };
  } catch {
    return null;
  }
}

export async function fetchFallbackQuotes(): Promise<Record<string, FallbackQuote>> {
  const out: Record<string, FallbackQuote> = {};

  const sqPromises = Object.entries(SWISSQUOTE_MAP).map(async ([sym, instr]) => {
    const q = await fetchSwissquoteSingle(sym, instr);
    if (q) out[sym] = q;
  });

  const krakenPromise = (async () => {
    try {
      const pairs = Object.values(KRAKEN_PAIR_MAP)
        .map((x) => x.req)
        .join(',');
      const data = await fetchJsonWithTimeout(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`, {}, 8000);
      const resObj = data?.result || {};
      const nowIso = new Date().toISOString();
      for (const [sym, cfg] of Object.entries(KRAKEN_PAIR_MAP)) {
        const hitKey = cfg.resKeys.find((k) => resObj[k]);
        const row = hitKey ? resObj[hitKey] : null;
        if (!row) continue;
        const bid = Number(row.b?.[0]);
        const ask = Number(row.a?.[0]);
        if (bid > 0 && ask >= bid) {
          out[sym] = {
            symbol: sym,
            bid,
            ask,
            mid: (bid + ask) / 2,
            spread: ask - bid,
            timestamp: nowIso,
            source: 'KRAKEN',
            marketState: 'open',
          };
        }
      }
    } catch {
      // ignore
    }
  })();

  await Promise.allSettled([...sqPromises, krakenPromise]);
  return out;
}

function aggregateBarsByBucket(bars: FallbackCandle[], bucketSec: number): FallbackCandle[] {
  const bucketMs = bucketSec * 1000;
  const map = new Map<number, FallbackCandle>();
  for (const b of bars) {
    const key = Math.floor(b.timeMs / bucketMs) * bucketMs;
    const ex = map.get(key);
    if (!ex) {
      map.set(key, {
        openTime: new Date(key).toISOString(),
        timeMs: key,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        isOpen: false,
      });
    } else {
      ex.high = Math.max(ex.high, b.high);
      ex.low = Math.min(ex.low, b.low);
      ex.close = b.close;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.timeMs - b.timeMs);
}

export async function fetchFallbackCandles(
  rawSym: string,
  rawTf: string
): Promise<{ ok: true; source: string; closedBars: FallbackCandle[]; formingBar: FallbackCandle | null } | { ok: false; status: number; error: string }> {
  const sym = String(rawSym || '').toUpperCase().trim();
  const tf = String(rawTf || '').toUpperCase().trim();
  const tfSec = TF_SECONDS[tf];
  if (!tfSec || (!KRAKEN_PAIR_MAP[sym] && !YAHOO_FX_MAP[sym])) {
    return { ok: false, status: 400, error: 'Unsupported symbol or timeframe.' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const currentBucketMs = Math.floor(nowSec / tfSec) * tfSec * 1000;

  if (KRAKEN_PAIR_MAP[sym]) {
    const cfg = KRAKEN_PAIR_MAP[sym];
    const interval = KRAKEN_INTERVAL[tf] || 15;
    try {
      const data = await fetchJsonWithTimeout(
        `https://api.kraken.com/0/public/OHLC?pair=${cfg.req}&interval=${interval}`,
        {},
        9000
      );
      const resObj = data?.result || {};
      const key = Object.keys(resObj).find((k) => k !== 'last');
      const rows = key ? resObj[key] : null;
      if (!Array.isArray(rows) || rows.length < 30) {
        throw new Error('Insufficient Kraken bars');
      }
      const normalized: FallbackCandle[] = rows
        .map((r: any) => {
          const timeMs = Number(r[0]) * 1000;
          return {
            openTime: new Date(timeMs).toISOString(),
            timeMs,
            open: Number(r[1]),
            high: Number(r[2]),
            low: Number(r[3]),
            close: Number(r[4]),
            isOpen: timeMs >= currentBucketMs,
          };
        })
        .filter((b) => Number.isFinite(b.timeMs) && Number.isFinite(b.close))
        .slice(-220);

      const formingBar = normalized.length && normalized[normalized.length - 1].isOpen ? normalized[normalized.length - 1] : null;
      const closedBars = normalized.filter((b) => !b.isOpen);
      return { ok: true, source: 'KRAKEN', closedBars, formingBar };
    } catch (err: any) {
      return { ok: false, status: 502, error: err?.message || 'Kraken OHLC unavailable' };
    }
  }

  // Forex & Gold via Yahoo Finance (+ Swissquote live spot alignment for XAUUSD)
  const ySym = YAHOO_FX_MAP[sym];
  let yInt = '15m';
  let yRange = '5d';
  if (tf === 'M1') { yInt = '1m'; yRange = '1d'; }
  else if (tf === 'M5') { yInt = '5m'; yRange = '5d'; }
  else if (tf === 'M15') { yInt = '15m'; yRange = '5d'; }
  else if (tf === 'M30') { yInt = '30m'; yRange = '1mo'; }
  else if (tf === 'H1') { yInt = '1h'; yRange = '1mo'; }
  else if (tf === 'H4') { yInt = '1h'; yRange = '3mo'; }
  else if (tf === 'D1') { yInt = '1d'; yRange = '1y'; }
  else if (tf === 'W1') { yInt = '1d'; yRange = '2y'; }

  try {
    const [yData, sqGold] = await Promise.all([
      fetchJsonWithTimeout(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=${yInt}&range=${yRange}`,
        { 'User-Agent': 'Mozilla/5.0' },
        10000
      ),
      sym === 'XAUUSD' ? fetchSwissquoteSingle('XAUUSD', 'XAU/USD') : Promise.resolve(null),
    ]);

    const res0 = yData?.chart?.result?.[0];
    const tsList: number[] = res0?.timestamp || [];
    const q = res0?.indicators?.quote?.[0] || {};
    if (!tsList.length) throw new Error(`No Yahoo bars for ${sym}`);

    let rawBars: FallbackCandle[] = [];
    for (let i = 0; i < tsList.length; i++) {
      const o = Number(q.open?.[i]);
      const h = Number(q.high?.[i]);
      const l = Number(q.low?.[i]);
      const c = Number(q.close?.[i]);
      const timeMs = Number(tsList[i]) * 1000;
      if ([o, h, l, c, timeMs].every(Number.isFinite) && c > 0) {
        rawBars.push({
          openTime: new Date(timeMs).toISOString(),
          timeMs,
          open: o,
          high: h,
          low: l,
          close: c,
          isOpen: false,
        });
      }
    }

    if (tf === 'H4') {
      rawBars = aggregateBarsByBucket(rawBars, 14400);
    } else if (tf === 'W1') {
      const weekMs = 7 * 86400 * 1000;
      const wMap = new Map<number, FallbackCandle>();
      for (const b of rawBars) {
        const d = new Date(b.timeMs);
        const day = d.getUTCDay();
        const diffToMon = (day + 6) % 7;
        const monStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMon);
        const ex = wMap.get(monStart);
        if (!ex) {
          wMap.set(monStart, { ...b, timeMs: monStart, openTime: new Date(monStart).toISOString() });
        } else {
          ex.high = Math.max(ex.high, b.high);
          ex.low = Math.min(ex.low, b.low);
          ex.close = b.close;
        }
      }
      rawBars = Array.from(wMap.values()).sort((a, b) => a.timeMs - b.timeMs);
      void weekMs;
    }

    // Align COMEX futures (GC=F) basis to live Spot XAU/USD when Swissquote spot quote is active
    if (sym === 'XAUUSD' && sqGold && rawBars.length) {
      const futLast = Number(res0?.meta?.regularMarketPrice) || rawBars[rawBars.length - 1].close;
      const basis = sqGold.mid - futLast;
      if (Number.isFinite(basis) && Math.abs(basis) < 35) {
        rawBars = rawBars.map((b) => ({
          ...b,
          open: Number((b.open + basis).toFixed(2)),
          high: Number((b.high + basis).toFixed(2)),
          low: Number((b.low + basis).toFixed(2)),
          close: Number((b.close + basis).toFixed(2)),
        }));
      }
    }

    const sliced = rawBars.slice(-220).map((b) => ({
      ...b,
      isOpen: b.timeMs >= currentBucketMs,
    }));

    const formingBar = sliced.length && sliced[sliced.length - 1].isOpen ? sliced[sliced.length - 1] : null;
    const closedBars = sliced.filter((b) => !b.isOpen);
    return {
      ok: true,
      source: sym === 'XAUUSD' ? 'SWISSQUOTE+YAHOO' : 'YAHOO+SWISSQUOTE',
      closedBars,
      formingBar,
    };
  } catch (err: any) {
    return { ok: false, status: 502, error: err?.message || `Backup OHLC unavailable for ${sym}` };
  }
}
