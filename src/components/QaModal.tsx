import React from 'react';
import { FlaskConical, X } from 'lucide-react';
import { APP_VERSION, RELEASE_DATE } from '../constants/markets';
import type { QaLogEntry } from '../engine/qaSuite';

interface QaModalProps {
  open: boolean;
  title: string;
  desc: string;
  logs: QaLogEntry[];
  running: boolean;
  onClose: () => void;
  onRunQa: () => void;
}

export const QaModal: React.FC<QaModalProps> = ({ open, title, desc, logs, running, onClose, onRunQa }) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative max-h-[86vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[#1e2535] bg-gradient-to-br from-[#161c28] to-[#0d111a] p-5 shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close QA Modal"
          className="absolute right-3 top-3 cursor-pointer rounded-lg border border-[#1e2535] bg-[#080a0f] p-1.5 text-slate-300 transition-colors hover:border-amber-500 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-1.5 flex items-center gap-2 pr-8">
          <FlaskConical className="h-4 w-4 text-amber-400" />
          <h3 className="text-base font-bold text-white">{title}</h3>
        </div>
        <p className="mb-3 text-xs text-slate-400">{desc}</p>

        <div className="mb-3 rounded-xl border border-[#1e2535] bg-[#080a0f] p-3 font-mono text-[11px]">
          <div className="font-bold text-amber-400">
            Version: {APP_VERSION} · Date: {RELEASE_DATE}
          </div>
          <div className="mt-0.5 text-slate-400">
            BIQUOTE: /api/&#123;active, latest, &#123;sym&#125;/ohlc&#125; &amp; /hubs/tick (Zero Fake Data)
          </div>
          <div className="text-slate-400">EXNESS MT5 Bridge: /api/quote &amp; /api/candles</div>
        </div>

        <div className="flex flex-col gap-2 rounded-xl border border-[#1e2535] bg-[#080a0f] p-3">
          <div className="flex items-center justify-between gap-2">
            <strong className="font-mono text-[11px] text-amber-400">20-Test QA Suite + Live Checks</strong>
            <button
              type="button"
              onClick={onRunQa}
              disabled={running}
              className="cursor-pointer rounded-lg border border-amber-400 bg-amber-500 px-3 py-1.5 text-[11px] font-extrabold text-slate-950 transition-colors hover:bg-amber-400 disabled:opacity-50"
            >
              {running ? 'Running…' : 'Run Full QA Suite'}
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto rounded-lg border border-[#1e2535] bg-[#06080c] p-2.5 font-mono text-[11px] leading-relaxed">
            {logs.length === 0 ? (
              <span className="text-slate-400">
                Click &ldquo;Run Full QA Suite&rdquo; to run all 20 unit assertions and live BIQUOTE checks.
              </span>
            ) : (
              logs.map((item, idx) => (
                <div
                  key={idx}
                  className={
                    item.status === 'pass'
                      ? 'text-emerald-400'
                      : item.status === 'fail'
                      ? 'text-red-400'
                      : 'text-amber-400'
                  }
                >
                  {item.text}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-amber-400 bg-amber-500 px-4 py-1.5 text-xs font-extrabold text-slate-950 hover:bg-amber-400"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
