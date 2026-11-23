import React from 'react';
import { SYMBOL_SPECS, TF_PROFILES } from '../constants/markets';
import { calculateEMASeries, fmtPrice } from '../engine/indicators';
import type {
  CandleBar,
  ChartLayers,
  FreshnessResult,
  ProviderType,
  QuoteData,
  SignalOutput,
  TimeframeKey,
} from '../types/trading';

interface TradingChartProps {
  symbol: string;
  tf: TimeframeKey;
  provider: ProviderType;
  closedBars: CandleBar[];
  formingBar: CandleBar | null;
  liveQuote: QuoteData | null;
  freshness: FreshnessResult;
  signal: SignalOutput;
  layers: ChartLayers;
  chartTitle: string;
  errorMsg: string | null;
  onToggleLayer: (k: keyof ChartLayers) => void;
}

export const TradingChart: React.FC<TradingChartProps> = ({
  symbol,
  tf,
  provider,
  closedBars,
  formingBar,
  liveQuote,
  freshness,
  signal,
  layers,
  chartTitle,
  errorMsg,
  onToggleLayer,
}) => {
  const sIdx = Math.max(0, closedBars.length - 42);
  const disp = closedBars.slice(sIdx);
  const allV = formingBar ? [...disp, formingBar] : disp;
  const qM = liveQuote?.mid;
  const kl = signal.keyLevels;

  const hasBars = allV.length > 0;
  let lo = 0;
  let hi = 1;
  if (hasBars) {
    const lvls: number[] = [...allV.flatMap((x) => [x.high, x.low])];
    if (typeof qM === 'number' && Number.isFinite(qM)) lvls.push(qM);
    if (layers.sr) {
      if (kl.r1) lvls.push(kl.r1.price);
      if (kl.s1) lvls.push(kl.s1.price);
    }
    if (signal.state === 'READY') {
      if (signal.entry !== null) lvls.push(signal.entry);
      if (signal.tp1 !== null) lvls.push(signal.tp1);
      if (signal.tp2 !== null) lvls.push(signal.tp2);
      if (signal.sl !== null) lvls.push(signal.sl);
    }
    const vL = lvls.filter(Number.isFinite);
    const mn = Math.min(...vL);
    const mx = Math.max(...vL);
    const pad = Math.max((mx - mn) * 0.08, (SYMBOL_SPECS[symbol]?.pipSize || 0.01) * 5);
    lo = mn - pad;
    hi = mx + pad;
  }

  const y = (p: number) => 228 - ((p - lo) / (hi - lo || 1)) * 216;
  const sp = hasBars ? 600 / allV.length : 14;
  const bw = Math.max(3, Math.min(12, sp * 0.62));

  const cl = closedBars.map((x) => x.close);
  const e8 = disp.length ? calculateEMASeries(cl, 8).slice(-disp.length) : [];
  const e21 = disp.length ? calculateEMASeries(cl, 21).slice(-disp.length) : [];
  const buildPath = (s: number[]) =>
    s.map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i * sp + sp / 2).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');

  const hLines: Array<{ price: number; col: string; lbl: string; dash: string }> = [];
  if (hasBars && layers.sr) {
    if (kl.r2) hLines.push({ price: kl.r2.price, col: '#f87171', lbl: `R2 ${fmtPrice(kl.r2.price, symbol)} (${kl.r2.touches}x)`, dash: '5 3' });
    if (kl.r1) hLines.push({ price: kl.r1.price, col: '#ef4444', lbl: `R1 ${fmtPrice(kl.r1.price, symbol)} (${kl.r1.touches}x)`, dash: '5 3' });
    if (kl.s1) hLines.push({ price: kl.s1.price, col: '#10b981', lbl: `S1 ${fmtPrice(kl.s1.price, symbol)} (${kl.s1.touches}x)`, dash: '5 3' });
    if (kl.s2) hLines.push({ price: kl.s2.price, col: '#34d399', lbl: `S2 ${fmtPrice(kl.s2.price, symbol)} (${kl.s2.touches}x)`, dash: '5 3' });
  }
  if (hasBars && layers.liq) {
    if (kl.pdh) hLines.push({ price: kl.pdh, col: '#22d3ee', lbl: `PDH ${fmtPrice(kl.pdh, symbol)}`, dash: '2 3' });
    if (kl.pdl) hLines.push({ price: kl.pdl, col: '#22d3ee', lbl: `PDL ${fmtPrice(kl.pdl, symbol)}`, dash: '2 3' });
    if (kl.eqHigh) hLines.push({ price: kl.eqHigh, col: '#fbbf24', lbl: `EQH ${fmtPrice(kl.eqHigh, symbol)}`, dash: '2 2' });
    if (kl.eqLow) hLines.push({ price: kl.eqLow, col: '#fbbf24', lbl: `EQL ${fmtPrice(kl.eqLow, symbol)}`, dash: '2 2' });
  }

  const ictZones: Array<{ top: number; bottom: number; ci: number; col: string; lbl: string }> = [];
  if (hasBars && layers.ict) {
    if (signal.fvg?.latestBull) {
      ictZones.push({ top: signal.fvg.latestBull.top, bottom: signal.fvg.latestBull.bottom, ci: signal.fvg.latestBull.index, col: '#10b981', lbl: 'BULL FVG' });
    }
    if (signal.fvg?.latestBear) {
      ictZones.push({ top: signal.fvg.latestBear.top, bottom: signal.fvg.latestBear.bottom, ci: signal.fvg.latestBear.index, col: '#ef4444', lbl: 'BEAR FVG' });
    }
    if (signal.ob?.type !== 'NONE' && signal.ob?.high) {
      ictZones.push({ top: signal.ob.high, bottom: signal.ob.low, ci: signal.ob.index, col: '#a855f7', lbl: 'OB' });
    }
    if (signal.breaker?.type !== 'NONE' && signal.breaker?.high) {
      ictZones.push({ top: signal.breaker.high, bottom: signal.breaker.low, ci: signal.breaker.index, col: '#3b82f6', lbl: 'BREAKER' });
    }
  }

  const showSignalLines = hasBars && signal.state === 'READY' && Number.isFinite(signal.entry);
  const liveRef = hasBars ? (typeof qM === 'number' && Number.isFinite(qM) ? qM : allV[allV.length - 1].close) : null;

  return (
    <div className="rounded-2xl border border-[#1e2535] bg-[#0b0e14] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs font-bold text-amber-400">
            {symbol} · {TF_PROFILES[tf]?.label || tf}
          </span>
          <strong className="text-[13px] font-bold text-slate-100">{chartTitle}</strong>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onToggleLayer('sr')}
            className={`cursor-pointer rounded-md border px-2 py-1 text-[10px] font-bold transition-colors ${
              layers.sr
                ? 'border-amber-500 bg-amber-500/15 text-amber-400'
                : 'border-[#1e2535] bg-[#080a0f] text-slate-300 hover:border-amber-500/60'
            }`}
          >
            S/R Levels
          </button>
          <button
            type="button"
            onClick={() => onToggleLayer('liq')}
            className={`cursor-pointer rounded-md border px-2 py-1 text-[10px] font-bold transition-colors ${
              layers.liq
                ? 'border-amber-500 bg-amber-500/15 text-amber-400'
                : 'border-[#1e2535] bg-[#080a0f] text-slate-300 hover:border-amber-500/60'
            }`}
          >
            PDH/PDL/EQ
          </button>
          <button
            type="button"
            onClick={() => onToggleLayer('ict')}
            className={`cursor-pointer rounded-md border px-2 py-1 text-[10px] font-bold transition-colors ${
              layers.ict
                ? 'border-amber-500 bg-amber-500/15 text-amber-400'
                : 'border-[#1e2535] bg-[#080a0f] text-slate-300 hover:border-amber-500/60'
            }`}
          >
            FVG/OB
          </button>
          <div className="ml-1 flex items-center gap-1.5 font-mono text-[11px]">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                !hasBars ? 'bg-red-500' : freshness.fresh ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
            />
            <span className={!hasBars ? 'text-red-400' : freshness.fresh ? 'text-emerald-400' : 'text-amber-400'}>
              {!hasBars ? 'UNAVAILABLE' : `${provider} · ${freshness.status}`}
            </span>
          </div>
        </div>
      </div>

      <div className="relative h-[245px] w-full overflow-hidden rounded-xl border border-slate-800 bg-[#080b10] sm:h-[320px]">
        <svg className="block h-full w-full" viewBox="0 0 660 240" preserveAspectRatio="none">
          <line x1="0" y1="40" x2="600" y2="40" stroke="#161b26" />
          <line x1="0" y1="80" x2="600" y2="80" stroke="#161b26" />
          <line x1="0" y1="120" x2="600" y2="120" stroke="#161b26" />
          <line x1="0" y1="160" x2="600" y2="160" stroke="#161b26" />
          <line x1="0" y1="200" x2="600" y2="200" stroke="#161b26" />
          <line x1="150" y1="0" x2="150" y2="240" stroke="#161b26" />
          <line x1="300" y1="0" x2="300" y2="240" stroke="#161b26" />
          <line x1="450" y1="0" x2="450" y2="240" stroke="#161b26" />
          <line x1="600" y1="0" x2="600" y2="240" stroke="#1f2937" strokeWidth="1.5" />

          {/* ICT Zones */}
          <g>
            {ictZones.map((z, idx) => {
              if (!(z.top > 0 && z.bottom > 0)) return null;
              const ri = Math.max(0, (z.ci >= 0 ? z.ci : sIdx) - sIdx);
              const sx = Math.min(540, Math.max(0, ri * sp));
              const w = Math.max(40, 600 - sx);
              const yt = Math.min(y(z.top), y(z.bottom));
              const h = Math.max(5, Math.abs(y(z.top) - y(z.bottom)));
              return (
                <g key={`${z.lbl}-${idx}`}>
                  <rect x={sx} y={yt} width={w} height={h} fill={z.col} fillOpacity="0.12" stroke={z.col} strokeDasharray="3 2" />
                  <text x={sx + 4} y={Math.max(12, yt + 10)} fill={z.col} fontSize="8" fontFamily="monospace">
                    {z.lbl}
                  </text>
                </g>
              );
            })}
          </g>

          {/* Key S/R & Liquidity Levels */}
          <g>
            {hLines.map((ln, idx) => {
              if (!Number.isFinite(ln.price) || ln.price < lo || ln.price > hi) return null;
              const yy = y(ln.price);
              return (
                <g key={`${ln.lbl}-${idx}`}>
                  <line x1="0" x2="600" y1={yy} y2={yy} stroke={ln.col} strokeWidth="1.1" strokeDasharray={ln.dash} opacity="0.75" />
                  <text x="6" y={yy - 3} fill={ln.col} fontSize="8.5" fontFamily="monospace">
                    {ln.lbl}
                  </text>
                </g>
              );
            })}
          </g>

          {/* Candlesticks */}
          <g>
            {allV.map((b, i) => {
              const x = i * sp + sp / 2;
              const up = b.close >= b.open;
              const col = up ? '#10b981' : '#ef4444';
              const bodyTop = Math.min(y(b.open), y(b.close));
              const bodyH = Math.max(2, Math.abs(y(b.open) - y(b.close)));
              return (
                <g key={`${b.timeMs}-${i}`}>
                  <line
                    x1={x}
                    x2={x}
                    y1={y(b.high)}
                    y2={y(b.low)}
                    stroke={col}
                    strokeWidth={b.isOpen ? '1' : '1.4'}
                    strokeDasharray={b.isOpen ? '2 2' : undefined}
                  />
                  <rect
                    x={x - bw / 2}
                    y={bodyTop}
                    width={bw}
                    height={bodyH}
                    fill={col}
                    fillOpacity={b.isOpen ? 0.35 : 1}
                    stroke={b.isOpen ? '#f59e0b' : undefined}
                    strokeDasharray={b.isOpen ? '2 1' : undefined}
                  />
                </g>
              );
            })}
          </g>

          {/* EMA 8 & EMA 21 */}
          {e8.length > 0 && <path d={buildPath(e8)} fill="none" stroke="#f59e0b" strokeWidth="1.5" opacity="0.9" />}
          {e21.length > 0 && (
            <path d={buildPath(e21)} fill="none" stroke="#3b82f6" strokeWidth="1.3" strokeDasharray="3 2" opacity="0.8" />
          )}

          {/* Active Signal Levels */}
          {showSignalLines && signal.tp2 !== null && (
            <g>
              <line x1="0" y1={y(signal.tp2)} x2="600" y2={y(signal.tp2)} stroke="#10b981" strokeWidth="1.5" strokeDasharray="4 3" />
              <rect x="602" y={y(signal.tp2) - 7.5} width="56" height="15" fill="#065f46" rx="2" />
              <text x="605" y={y(signal.tp2) + 3} fill="#34d399" fontSize="9" fontWeight="bold" fontFamily="monospace">
                {fmtPrice(signal.tp2, symbol)}
              </text>
            </g>
          )}
          {showSignalLines && signal.tp1 !== null && (
            <g>
              <line x1="0" y1={y(signal.tp1)} x2="600" y2={y(signal.tp1)} stroke="#34d399" strokeWidth="1.5" strokeDasharray="4 3" />
              <rect x="602" y={y(signal.tp1) - 7.5} width="56" height="15" fill="#064e3b" rx="2" />
              <text x="605" y={y(signal.tp1) + 3} fill="#6ee7b7" fontSize="9" fontWeight="bold" fontFamily="monospace">
                {fmtPrice(signal.tp1, symbol)}
              </text>
            </g>
          )}
          {showSignalLines && signal.entry !== null && (
            <g>
              <line x1="0" y1={y(signal.entry)} x2="600" y2={y(signal.entry)} stroke="#3b82f6" strokeWidth="2" />
              <rect x="602" y={y(signal.entry) - 7.5} width="56" height="15" fill="#1d4ed8" rx="2" />
              <text x="605" y={y(signal.entry) + 3} fill="#fff" fontSize="9" fontWeight="bold" fontFamily="monospace">
                {fmtPrice(signal.entry, symbol)}
              </text>
            </g>
          )}
          {liveRef !== null && Number.isFinite(liveRef) && (
            <g>
              <line x1="0" y1={y(liveRef)} x2="600" y2={y(liveRef)} stroke="#f59e0b" strokeWidth="1" strokeDasharray="2 2" />
              <rect x="602" y={y(liveRef) - 7.5} width="56" height="15" fill="#d97706" rx="2" />
              <text x="605" y={y(liveRef) + 3} fill="#000" fontSize="9" fontWeight="bold" fontFamily="monospace">
                {fmtPrice(liveRef, symbol)}
              </text>
            </g>
          )}
          {showSignalLines && signal.sl !== null && (
            <g>
              <line x1="0" y1={y(signal.sl)} x2="600" y2={y(signal.sl)} stroke="#ef4444" strokeWidth="1.5" strokeDasharray="4 3" />
              <rect x="602" y={y(signal.sl) - 7.5} width="56" height="15" fill="#7f1d1d" rx="2" />
              <text x="605" y={y(signal.sl) + 3} fill="#fca5a5" fontSize="9" fontWeight="bold" fontFamily="monospace">
                {fmtPrice(signal.sl, symbol)}
              </text>
            </g>
          )}
        </svg>

        {!hasBars && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#080b10]/85 p-4 text-center font-mono text-[13px] font-bold text-red-400">
            {errorMsg ? `DATA UNAVAILABLE — ${errorMsg}` : 'SYNCING CANDLE DATA…'}
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
        <span>R1/R2 (Red) · S1/S2 (Green) · PDH/PDL/EQ (Cyan) · FVG/OB</span>
        <span className="font-mono">— EMA 8 · -- EMA 21</span>
      </div>
    </div>
  );
};
