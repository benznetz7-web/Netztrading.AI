import { SYMBOL_SPECS } from '../constants/markets';
import type { CandleBar } from '../types/trading';

export function fmtPrice(v: number | null | undefined, sym: string, digitsOv: number | null = null): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const d = digitsOv !== null ? digitsOv : (SYMBOL_SPECS[sym]?.digits ?? 2);
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function calculateEMASeries(v: number[], p: number): number[] {
  if (!v.length) return [];
  const k = 2 / (p + 1);
  const o = [v[0]];
  for (let i = 1; i < v.length; i++) {
    o.push(v[i] * k + o[i - 1] * (1 - k));
  }
  return o;
}

export function calculateMACD(closes: number[]): { macd: number; signal: number; hist: number; prevHist: number } {
  if (closes.length < 30) return { macd: 0, signal: 0, hist: 0, prevHist: 0 };
  const e12 = calculateEMASeries(closes, 12);
  const e26 = calculateEMASeries(closes, 26);
  const line = e12.map((v, i) => v - e26[i]);
  const sig = calculateEMASeries(line, 9);
  const n = line.length - 1;
  return {
    macd: line[n],
    signal: sig[n],
    hist: line[n] - sig[n],
    prevHist: line[n - 1] - sig[n - 1],
  };
}

export function calculateSqueezeAndBands(closes: number[], atr14: number): {
  squeezeOn: boolean;
  squeezePopUp: boolean;
  squeezePopDown: boolean;
  bbUpper: number;
  bbLower: number;
} {
  if (closes.length < 20 || !(atr14 > 0)) {
    return { squeezeOn: false, squeezePopUp: false, squeezePopDown: false, bbUpper: 0, bbLower: 0 };
  }
  const slice = closes.slice(-20);
  const sma = slice.reduce((a, b) => a + b, 0) / 20;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - sma) ** 2, 0) / 20);
  const bbUpper = sma + 2 * std;
  const bbLower = sma - 2 * std;
  const kcUpper = sma + 1.5 * atr14;
  const kcLower = sma - 1.5 * atr14;
  const squeezeOn = bbUpper <= kcUpper && bbLower >= kcLower;
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const squeezePopUp = (prev <= kcUpper && last > kcUpper) || (last > bbUpper && last > sma);
  const squeezePopDown = (prev >= kcLower && last < kcLower) || (last < bbLower && last < sma);
  return { squeezeOn, squeezePopUp, squeezePopDown, bbUpper, bbLower };
}

export function calculateRSI(v: number[], p = 14): number | null {
  if (v.length <= p) return null;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= p; i++) {
    const d = v[i] - v[i - 1];
    if (d > 0) g += d;
    else l -= d;
  }
  let ag = g / p;
  let al = l / p;
  for (let i = p + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

export function calculateATRSeries(c: CandleBar[], p = 14): number[] {
  if (c.length <= p) return [];
  const tr: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const x = c[i];
    const pr = c[i - 1].close;
    tr.push(Math.max(x.high - x.low, Math.abs(x.high - pr), Math.abs(x.low - pr)));
  }
  let a = tr.slice(0, p).reduce((x, y) => x + y, 0) / p;
  const o = [a];
  for (let i = p; i < tr.length; i++) {
    a = (a * (p - 1) + tr[i]) / p;
    o.push(a);
  }
  return o;
}

export function calculateADX(c: CandleBar[], p = 14): number | null {
  if (c.length < p * 2 + 2) return null;
  const pDM: number[] = [];
  const mDM: number[] = [];
  const trL: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const u = c[i].high - c[i - 1].high;
    const d = c[i - 1].low - c[i].low;
    pDM.push(u > d && u > 0 ? u : 0);
    mDM.push(d > u && d > 0 ? d : 0);
    trL.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
  }
  let sT = trL.slice(0, p).reduce((a, b) => a + b, 0);
  let sP = pDM.slice(0, p).reduce((a, b) => a + b, 0);
  let sM = mDM.slice(0, p).reduce((a, b) => a + b, 0);
  const dxL: number[] = [];
  for (let i = p; i < trL.length; i++) {
    sT = sT - sT / p + trL[i];
    sP = sP - sP / p + pDM[i];
    sM = sM - sM / p + mDM[i];
    const pDI = sT > 0 ? (sP / sT) * 100 : 0;
    const mDI = sT > 0 ? (sM / sT) * 100 : 0;
    dxL.push(pDI + mDI > 0 ? (Math.abs(pDI - mDI) / (pDI + mDI)) * 100 : 0);
  }
  if (dxL.length < p) return dxL.length ? dxL[dxL.length - 1] : null;
  let adx = dxL.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < dxL.length; i++) {
    adx = (adx * (p - 1) + dxL[i]) / p;
  }
  return adx;
}

export function calculateEfficiencyRatio(c: CandleBar[], p = 12): number {
  if (c.length <= p) return 1;
  const st = c.length - 1 - p;
  const net = Math.abs(c[c.length - 1].close - c[st].close);
  let s = 0;
  for (let i = st + 1; i < c.length; i++) {
    s += Math.abs(c[i].close - c[i - 1].close);
  }
  return s > 0 ? net / s : 0;
}

export function aggregateWeeklyFromDaily(
  dailyClosed: CandleBar[],
  dailyForming: CandleBar | null = null,
  nowMs: number = Date.now()
): { closedBars: CandleBar[]; formingBar: CandleBar | null } {
  const all = [...(dailyClosed || []), ...(dailyForming ? [dailyForming] : [])].sort((a, b) => a.timeMs - b.timeMs);
  const buckets = new Map<number, CandleBar[]>();
  const getWeekStart = (ms: number) => {
    const dt = new Date(ms);
    const day = dt.getUTCDay();
    const diff = (day + 6) % 7;
    return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - diff);
  };
  const currentWeekStart = getWeekStart(nowMs);
  for (const b of all) {
    const wk = getWeekStart(b.timeMs);
    const arr = buckets.get(wk);
    if (arr) arr.push(b);
    else buckets.set(wk, [b]);
  }
  const weeks: CandleBar[] = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([wk, items]) => ({
      timeMs: wk,
      openTime: new Date(wk).toISOString(),
      open: items[0].open,
      high: Math.max(...items.map((x) => x.high)),
      low: Math.min(...items.map((x) => x.low)),
      close: items[items.length - 1].close,
      isOpen: wk >= currentWeekStart || items.some((x) => x.isOpen),
    }));
  return {
    closedBars: weeks.filter((w) => !w.isOpen),
    formingBar: weeks.find((w) => w.isOpen) || null,
  };
}
