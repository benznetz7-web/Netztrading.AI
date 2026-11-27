import React from 'react';
import { AlertTriangle, RotateCw, Sparkles } from 'lucide-react';
import type { AiAnalysisResult, LangCode, MtfSnapshot } from '../types/trading';

interface AiAnalystCardProps {
  lang: LangCode;
  symbol: string;
  tf: string;
  mtfBreakdown?: MtfSnapshot[];
  result: AiAnalysisResult | null;
  loading: boolean;
  error: string | null;
  autoAi: boolean;
  onToggleAutoAi: () => void;
  onAnalyzeNow: () => void;
}

export const AiAnalystCard: React.FC<AiAnalystCardProps> = ({
  lang,
  symbol,
  tf,
  mtfBreakdown,
  result,
  loading,
  error,
  autoAi,
  onToggleAutoAi,
  onAnalyzeNow,
}) => {
  const isKh = lang === 'kh';

  const bias = result?.bias || 'WAIT';
  const biasBadgeClass =
    bias === 'BUY'
      ? 'bg-emerald-500 text-slate-950'
      : bias === 'SELL'
      ? 'bg-red-500 text-white'
      : 'bg-amber-500 text-slate-950';

  const hasReversal =
    Boolean(result?.reversalAlert) &&
    !['none', 'គ្មាន', 'n/a', 'no'].includes(result!.reversalAlert.trim().toLowerCase());

  return (
    <section className="rounded-2xl border border-indigo-500/40 bg-gradient-to-br from-[#161c28] to-[#0d111a] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1e2535] pb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="h-4 w-4 shrink-0 text-indigo-400" />
          <span className="text-xs font-extrabold uppercase tracking-wide text-indigo-300">
            {isKh ? 'AI វិភាគទីផ្សារផ្ទាល់' : 'AI Market Analyst'}
          </span>
          <span className="font-mono text-[10px] text-slate-400 whitespace-nowrap">
            {symbol} · {tf}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleAutoAi}
            className={`cursor-pointer rounded-lg border px-2.5 py-1 font-mono text-[11px] font-bold whitespace-nowrap transition-colors ${
              autoAi
                ? 'border-indigo-500/60 bg-indigo-500/20 text-indigo-200'
                : 'border-[#1e2535] bg-[#080a0f] text-slate-400 hover:text-slate-200'
            }`}
          >
            {autoAi ? (isKh ? 'Auto AI: បើក' : 'Auto AI: ON') : isKh ? 'Auto AI: បិទ' : 'Auto AI: OFF'}
          </button>

          <button
            type="button"
            onClick={onAnalyzeNow}
            disabled={loading}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-indigo-400/70 bg-indigo-500 px-2.5 py-1 text-[11px] font-extrabold text-white whitespace-nowrap transition-colors hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-60 active:scale-95"
          >
            <RotateCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            <span>{loading ? (isKh ? 'កំពុងវិភាគ…' : 'Analyzing…') : isKh ? 'វិភាគ AI ភ្លាម' : 'Analyze Now'}</span>
          </button>
        </div>
      </div>

      {mtfBreakdown && mtfBreakdown.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
          <span className="font-bold text-indigo-300">MTF:</span>
          {mtfBreakdown.map((m) => {
            const colorCls =
              m.bias === 'BULLISH'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : m.bias === 'BEARISH'
                ? 'border-red-500/40 bg-red-500/10 text-red-300'
                : 'border-[#1e2535] bg-[#080a0f] text-slate-400';
            const dirTxt = m.bias === 'BULLISH' ? 'BULL' : m.bias === 'BEARISH' ? 'BEAR' : 'FLAT';
            return (
              <span key={m.tf} className={`rounded-md border px-1.5 py-0.5 font-bold ${colorCls}`}>
                {m.tf} {dirTxt}
              </span>
            );
          })}
        </div>
      )}

      {error && (
        <div className="mt-2.5 flex items-center justify-between gap-2 rounded-xl border border-red-500/40 bg-red-950/40 px-3 py-2 font-mono text-[11px] text-red-300">
          <span>{error}</span>
          <button
            type="button"
            onClick={onAnalyzeNow}
            className="shrink-0 cursor-pointer rounded-md border border-red-500/40 bg-red-900/40 px-2 py-0.5 text-[10px] font-bold text-red-200 hover:border-red-400"
          >
            {isKh ? 'សាកល្បងម្តងទៀត' : 'Retry'}
          </button>
        </div>
      )}

      {!result && loading && !error && (
        <div className="mt-3 rounded-xl border border-[#1e2535] bg-[#080a0f] p-3 font-mono text-[11px] text-indigo-300">
          {isKh
            ? `AI កំពុងអានទៀន OHLC, MTF, តំបន់ S/R និង ICT សម្រាប់ ${symbol} (${tf})…`
            : `AI reading live OHLC, MTF, S/R levels & ICT structure for ${symbol} (${tf})…`}
        </div>
      )}

      {!result && !loading && !error && (
        <div className="mt-3 rounded-xl border border-[#1e2535] bg-[#080a0f] p-3 font-mono text-[11px] text-slate-400">
          {isKh
            ? 'ចុច "វិភាគ AI ភ្លាម" ឬរង់ចាំទិន្នន័យទៀនបញ្ចប់ការផ្ទុក ដើម្បីទទួលការវិភាគដោយ AI។'
            : 'Click "Analyze Now" or wait for live candles to sync for AI market synthesis.'}
        </div>
      )}

      {result && (
        <div className="mt-3 flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-block rounded-full px-3 py-0.5 font-mono text-xs font-extrabold ${biasBadgeClass}`}>
                AI · {result.bias}
              </span>
              <span className="font-mono text-xs font-bold text-white">{result.setupType}</span>
              <span className="font-mono text-[11px] text-slate-400">
                · {result.confidence}% {isKh ? 'ទំនុកចិត្ត' : 'Confidence'}
              </span>
            </div>
            <span className="font-mono text-[10px] text-slate-500">
              {result.modelUsed ? `${result.modelUsed} · ` : ''}
              {new Date(result.analyzedAt).toLocaleTimeString('en-US', { hour12: false })}
            </span>
          </div>

          <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] px-3 py-2 text-xs leading-relaxed text-slate-200">
            {result.summary}
          </div>

          {hasReversal && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/45 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              <div>
                <strong className="font-mono text-amber-300">
                  {isKh ? 'ការត្រឡប់នៅ S/R: ' : 'S/R Reversal: '}
                </strong>
                <span>{result.reversalAlert}</span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 text-[11px] md:grid-cols-3">
            <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5">
              <span className="block font-mono text-[10px] font-bold text-blue-400">
                {isKh ? 'ទីតាំង S/R' : 'S/R VERDICT'}
              </span>
              <div className="mt-1 text-slate-200">{result.srVerdict}</div>
            </div>
            <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5">
              <span className="block font-mono text-[10px] font-bold text-emerald-400">
                {isKh ? 'ផែនការចូល Trade' : 'ENTRY PLAN'}
              </span>
              <div className="mt-1 text-slate-200">{result.entryPlan}</div>
            </div>
            <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5">
              <span className="block font-mono text-[10px] font-bold text-red-400">
                {isKh ? 'ហានិភ័យ / លក្ខខណ្ឌខូច' : 'RISK / INVALIDATION'}
              </span>
              <div className="mt-1 text-slate-200">{result.riskNote}</div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
