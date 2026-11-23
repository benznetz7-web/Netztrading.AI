import React from 'react';
import { Bell, BellOff, Crown, FlaskConical, RotateCw } from 'lucide-react';
import type { LangCode, ProviderType } from '../types/trading';

interface HeaderBarProps {
  subtitle: string;
  provider: ProviderType;
  statusMessage: string;
  statusLevel: 'ok' | 'warn' | 'err';
  refreshing: boolean;
  refreshLabel: string;
  alertEnabled: boolean;
  alertLabel: string;
  alertCountdown: string;
  lang: LangCode;
  qaLabel: string;
  onSetProvider: (p: ProviderType) => void;
  onRefresh: () => void;
  onToggleAlert: () => void;
  onSetLang: (l: LangCode) => void;
  onOpenQa: () => void;
}

export const HeaderBar: React.FC<HeaderBarProps> = ({
  subtitle,
  provider,
  statusMessage,
  statusLevel,
  refreshing,
  refreshLabel,
  alertEnabled,
  alertLabel,
  alertCountdown,
  lang,
  qaLabel,
  onSetProvider,
  onRefresh,
  onToggleAlert,
  onSetLang,
  onOpenQa,
}) => {
  const dotColor =
    statusLevel === 'ok' ? 'bg-emerald-500' : statusLevel === 'err' ? 'bg-red-500' : 'bg-amber-500';
  const textColor =
    statusLevel === 'ok' ? 'text-emerald-400' : statusLevel === 'err' ? 'text-red-400' : 'text-amber-400';

  return (
    <header className="sticky top-0 z-40 border-b border-[#1e2535] bg-[#121620]/95 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2.5 px-3.5 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-amber-500 to-yellow-300 text-slate-950 shadow-sm">
            <Crown className="h-4 w-4 stroke-[2.5]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-base font-extrabold tracking-tight text-amber-400 whitespace-nowrap">NETHAGA</span>
              <span className="hidden font-mono text-[10px] font-bold text-slate-400 sm:inline whitespace-nowrap">
                FAST PRO · FX + CRYPTO
              </span>
            </div>
            <div className="truncate text-[11px] text-slate-400 max-w-[240px] sm:max-w-none">{subtitle}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-[#1e2535] bg-[#080a0f] p-0.5">
            <button
              type="button"
              onClick={() => onSetProvider('BIQUOTE')}
              className={`cursor-pointer rounded-md px-2.5 py-1 text-[11px] font-extrabold whitespace-nowrap transition-colors ${
                provider === 'BIQUOTE' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              BIQUOTE
            </button>
            <button
              type="button"
              onClick={() => onSetProvider('EXNESS')}
              className={`cursor-pointer rounded-md px-2.5 py-1 text-[11px] font-extrabold whitespace-nowrap transition-colors ${
                provider === 'EXNESS' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              EXNESS MT5
            </button>
          </div>

          <div className="flex items-center gap-1.5 rounded-lg border border-[#1e2535] bg-[#080a0f] px-2.5 py-1 text-[11px]">
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotColor}`} />
            <span className={`font-mono font-semibold whitespace-nowrap ${textColor}`}>{statusMessage}</span>
          </div>

          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#1e2535] bg-[#080a0f] px-2.5 py-1.5 text-xs font-bold text-amber-400 whitespace-nowrap transition-colors hover:border-amber-500 active:scale-95"
          >
            <RotateCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>{refreshLabel}</span>
          </button>

          <button
            type="button"
            onClick={onToggleAlert}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#1e2535] bg-[#080a0f] px-2.5 py-1.5 text-xs font-bold text-slate-200 whitespace-nowrap transition-colors hover:border-amber-500 active:scale-95"
          >
            {alertEnabled ? <Bell className="h-3.5 w-3.5 text-amber-400" /> : <BellOff className="h-3.5 w-3.5 text-slate-500" />}
            <span>{alertLabel}</span>
            <span className="font-mono text-amber-400">{alertCountdown}</span>
          </button>

          <div className="inline-flex rounded-lg border border-[#1e2535] bg-[#080a0f] p-0.5">
            <button
              type="button"
              onClick={() => onSetLang('en')}
              className={`cursor-pointer rounded-md px-2 py-1 text-[11px] font-extrabold whitespace-nowrap transition-colors ${
                lang === 'en' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              EN
            </button>
            <button
              type="button"
              onClick={() => onSetLang('kh')}
              className={`cursor-pointer rounded-md px-2 py-1 text-[11px] font-extrabold whitespace-nowrap transition-colors ${
                lang === 'kh' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              ខ្មែរ
            </button>
          </div>

          <button
            type="button"
            onClick={onOpenQa}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#1e2535] bg-[#080a0f] px-2.5 py-1.5 text-xs font-bold text-slate-200 whitespace-nowrap transition-colors hover:border-amber-500 active:scale-95"
          >
            <FlaskConical className="h-3.5 w-3.5 text-amber-400" />
            <span>{qaLabel}</span>
          </button>
        </div>
      </div>
    </header>
  );
};
