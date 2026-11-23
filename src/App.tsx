import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as signalR from '@microsoft/signalr';
import {
  AlertTriangle,
  Bitcoin,
  Check,
  Clock,
  Coins,
  Copy,
  Layers,
  ListChecks,
  Lock,
  LockOpen,
  Shield,
  Zap,
} from 'lucide-react';
import { HeaderBar } from './components/HeaderBar';
import { QaModal } from './components/QaModal';
import { TradingChart } from './components/TradingChart';
import {
  APP_VERSION,
  BIQUOTE_HUB,
  RELEASE_DATE,
  STORAGE_KEYS,
  SUPPORTED_SYMBOLS,
  SYMBOL_SPECS,
  TF_PROFILES,
  TIMEFRAME_ORDER,
  TRANSLATIONS,
} from './constants/markets';
import {
  checkBiquoteActiveSymbols,
  evaluateQuoteFreshness,
  fetchBiquoteLatestSnapshot,
  fetchSymbolCandles,
  ingestQuoteUpdate,
  playSignalSound,
  safeFetch,
  type QuotesByProvider,
} from './engine/dataFeed';
import { fmtPrice } from './engine/indicators';
import { executeFullQaSuite, type QaLogEntry } from './engine/qaSuite';
import {
  evaluateSetup,
  getSymbolSpec,
  runWalkForwardForTimeframe,
  type BrokerSpecOverrideMap,
} from './engine/quantEngine';
import type {
  ActiveLock,
  CandleBar,
  CandleBundle,
  ChartLayers,
  ContractMode,
  HistoryEntry,
  LangCode,
  MarketDesk,
  ProviderType,
  QuoteData,
  RiskConfig,
  RiskLedger,
  SignalOutput,
  TimeframeKey,
  WalkForwardStats,
} from './types/trading';

function readStoredRiskConfig(): RiskConfig {
  const b = Number(localStorage.getItem(STORAGE_KEYS.riskBal));
  const p = Number(localStorage.getItem(STORAGE_KEYS.riskPct));
  const d = Number(localStorage.getItem(STORAGE_KEYS.dailyCap));
  const m = localStorage.getItem(STORAGE_KEYS.contractMode) === 'CENT' ? 'CENT' : 'STANDARD';
  const c = Number(localStorage.getItem(STORAGE_KEYS.commission));
  return {
    balance: Number.isFinite(b) && b >= 5 ? b : 80,
    riskPercent: Number.isFinite(p) && p >= 0.1 ? p : 0.5,
    dailyCap: Number.isFinite(d) && d >= 0.25 ? d : 1.0,
    contractMode: m,
    commission: Number.isFinite(c) && c >= 0 ? c : 0,
  };
}

function readStoredRiskLedger(): RiskLedger {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEYS.riskState) || 'null');
    if (s && s.dateUtc === today) return s;
  } catch {
    // ignore
  }
  return { dateUtc: today, dailyLossPct: 0, consecutiveLosses: 0, openPositions: 0, pausedForReview: false };
}

function readStoredHistory(): HistoryEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEYS.history) || '[]');
    return Array.isArray(v) ? v.filter((x) => x && (x.type === 'BUY' || x.type === 'SELL')).slice(0, 60) : [];
  } catch {
    return [];
  }
}

function createInitialSignal(sym: string, tf: TimeframeKey, prov: ProviderType): SignalOutput {
  return {
    asset: sym,
    tf,
    source: prov,
    state: 'WAIT',
    type: 'WAIT',
    entryMode: 'SCANNING',
    entry: null,
    entryZone: null,
    tp1: null,
    tp2: null,
    tp3: null,
    sl: null,
    grossRR: null,
    netRR: null,
    rrText: '—',
    danger: { tier: 'CLEAN', pct: 15, riskScale: 1.0, tp1R: 1.0, tp2R: 1.8, label: 'CLEAN' },
    regime: { regime: 'UNKNOWN', adx: 0, atrRatio: 1, er: 0, squeeze: false, label: '—' },
    keyLevels: { r1: null, r2: null, s1: null, s2: null, pdh: null, pdl: null, all: [] },
    watchNote: null,
    htfSummary: TF_PROFILES[tf]?.htf || 'H1',
    setupScore: 0,
    rules: [],
    diagVeto: 'Initializing',
    diagSetup: 'Scanning…',
    diagTrigger: 'Checking…',
    ema8: null,
    ema21: null,
    macdHist: null,
    rsi14: null,
    atr14: null,
    fvg: { validBull: [], validBear: [], latestBull: null, latestBear: null, label: '—' },
    structure: { type: 'NEUTRAL', kind: 'NONE', label: '—', eqHigh: null, eqLow: null, sweep: null },
    ob: { type: 'NONE', high: 0, low: 0, index: -1, label: '—' },
    breaker: { type: 'NONE', high: 0, low: 0, index: -1, label: 'None' },
    riskCalc: null,
    locked: false,
    reversalWarning: false,
    tp1Hit: false,
    tp2Hit: false,
    closedCount: 0,
    formingBar: null,
    candleTime: 0,
    time: '--:--:--',
    reason: 'Syncing…',
  };
}

export default function App() {
  const initialSymbol = useMemo(() => {
    const s = localStorage.getItem(STORAGE_KEYS.symbol);
    return s && SUPPORTED_SYMBOLS.includes(s) ? s : 'XAUUSD';
  }, []);

  const initialDesk = useMemo<MarketDesk>(() => {
    const d = localStorage.getItem(STORAGE_KEYS.desk);
    if (d === 'CRYPTO' || d === 'FOREX') {
      return SYMBOL_SPECS[initialSymbol].desk === d ? d : SYMBOL_SPECS[initialSymbol].desk;
    }
    return SYMBOL_SPECS[initialSymbol].desk;
  }, [initialSymbol]);

  const [lang, setLang] = useState<LangCode>(() => (localStorage.getItem(STORAGE_KEYS.language) === 'kh' ? 'kh' : 'en'));
  const [provider, setProvider] = useState<ProviderType>(() =>
    localStorage.getItem(STORAGE_KEYS.provider) === 'EXNESS' ? 'EXNESS' : 'BIQUOTE'
  );
  const [activeDesk, setActiveDesk] = useState<MarketDesk>(initialDesk);
  const [activeSymbol, setActiveSymbol] = useState<string>(initialSymbol);
  const [currentTF, setCurrentTF] = useState<TimeframeKey>('M15');
  const [alertEnabled, setAlertEnabled] = useState<boolean>(() => localStorage.getItem(STORAGE_KEYS.alerts) !== 'false');

  const [statusMessage, setStatusMessage] = useState<string>('Connecting…');
  const [statusLevel, setStatusLevel] = useState<'ok' | 'warn' | 'err'>('warn');
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const [riskConfig, setRiskConfig] = useState<RiskConfig>(readStoredRiskConfig);
  const [riskLedger, setRiskLedger] = useState<RiskLedger>(readStoredRiskLedger);
  const [chartLayers, setChartLayers] = useState<ChartLayers>(() => {
    try {
      const ly = JSON.parse(localStorage.getItem(STORAGE_KEYS.layers) || 'null');
      return ly ? { sr: true, liq: true, ict: true, ...ly } : { sr: true, liq: true, ict: true };
    } catch {
      return { sr: true, liq: true, ict: true };
    }
  });

  const [signalHistoryLog, setSignalHistoryLog] = useState<HistoryEntry[]>(readStoredHistory);
  const [historyFilter, setHistoryFilter] = useState<'ALL' | 'FOREX' | 'CRYPTO'>('ALL');
  const [confirmClearHistory, setConfirmClearHistory] = useState<boolean>(false);

  const [currentSignal, setCurrentSignal] = useState<SignalOutput>(() =>
    createInitialSignal(initialSymbol, 'M15', provider)
  );
  const [walkForwardStats, setWalkForwardStats] = useState<WalkForwardStats | null>(null);
  const [analysisLatencyMs, setAnalysisLatencyMs] = useState<number>(0);
  const [chartErrorMsg, setChartErrorMsg] = useState<string | null>(null);

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [tickPulseDir, setTickPulseDir] = useState<'up' | 'down' | 'flat'>('flat');
  const [, setQuoteRenderSeq] = useState<number>(0);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [qaModalOpen, setQaModalOpen] = useState<boolean>(false);
  const [qaLogs, setQaLogs] = useState<QaLogEntry[]>([]);
  const [qaRunning, setQaRunning] = useState<boolean>(false);

  // Mutable high-frequency refs (zero stale closures, zero wasted DOM churn)
  const quotesRef = useRef<QuotesByProvider>({ BIQUOTE: {}, EXNESS: {} });
  const brokerSpecsOverrideRef = useRef<BrokerSpecOverrideMap>({});
  const candlesCacheRef = useRef<Record<string, CandleBundle>>({});
  const wfCacheRef = useRef<Record<string, WalkForwardStats>>({});
  const activeLocksRef = useRef<Record<string, ActiveLock>>((() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEYS.lock) || '{}') || {};
    } catch {
      return {};
    }
  })());
  const dismissedBarRef = useRef<Record<string, number>>({});
  const lastSignalBarKeyRef = useRef<string | null>(null);

  const analysisEpochRef = useRef<number>(0);
  const queuedTickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWfTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const candleRetryTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const signalRConnRef = useRef<signalR.HubConnection | null>(null);
  const signalRStateRef = useRef<string>('DISCONNECTED');
  const isConnectingSrRef = useRef<boolean>(false);
  const subscribedKeyRef = useRef<string>('');

  // Mirror latest UI state into refs for callbacks
  const stateRef = useRef({
    provider,
    activeSymbol,
    currentTF,
    alertEnabled,
    riskConfig,
    riskLedger,
    currentSignal,
  });
  stateRef.current = {
    provider,
    activeSymbol,
    currentTF,
    alertEnabled,
    riskConfig,
    riskLedger,
    currentSignal,
  };

  const t = TRANSLATIONS[lang];

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 2800);
  }, []);

  const saveLocks = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.lock, JSON.stringify(activeLocksRef.current));
    } catch {
      // ignore
    }
  }, []);

  const saveRiskLedger = useCallback((next: RiskLedger) => {
    setRiskLedger(next);
    stateRef.current.riskLedger = next;
    try {
      localStorage.setItem(STORAGE_KEYS.riskState, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);

  const getLockKey = useCallback(
    (prov = stateRef.current.provider, sym = stateRef.current.activeSymbol, tf = stateRef.current.currentTF) =>
      `${prov}:${sym}:${tf}`,
    []
  );

  const closeActiveLock = useCallback(
    (key: string, reason: string, isLoss: boolean) => {
      const lk = activeLocksRef.current[key];
      if (!lk) return;
      dismissedBarRef.current[key] = lk.candleTime;
      delete activeLocksRef.current[key];
      saveLocks();
      if (isLoss && stateRef.current.riskLedger.openPositions > 0) {
        const rp = Math.max(0.1, Number(stateRef.current.riskConfig.riskPercent || 0.5));
        const cur = stateRef.current.riskLedger;
        const nextLosses = cur.consecutiveLosses + 1;
        saveRiskLedger({
          ...cur,
          dailyLossPct: Number((cur.dailyLossPct + rp).toFixed(2)),
          consecutiveLosses: nextLosses,
          pausedForReview: nextLosses >= 2 ? true : cur.pausedForReview,
        });
      }
      showToast(`${lk.asset} ${lk.type} closed: ${reason}`);
    },
    [saveLocks, saveRiskLedger, showToast]
  );

  const evaluateActiveLockOnTick = useCallback(
    (quote: QuoteData) => {
      const key = getLockKey();
      const lk = activeLocksRef.current[key];
      if (!lk || !quote) return;
      const px = lk.type === 'BUY' ? quote.bid : quote.ask;
      if (lk.type === 'BUY') {
        if (!lk.tp1Hit && px <= lk.sl) { closeActiveLock(key, 'SL HIT', true); return; }
        if (!lk.tp1Hit && px >= lk.tp1) {
          lk.tp1Hit = true;
          lk.sl = lk.entry;
          saveLocks();
          showToast(`${lk.asset} TP1 HIT — Move SL to BE`);
        }
        if (lk.tp1Hit && !lk.tp2Hit && px >= lk.tp2) {
          lk.tp2Hit = true;
          saveLocks();
          showToast(`${lk.asset} TP2 HIT!`);
        }
        if (lk.tp1Hit && px <= lk.sl) { closeActiveLock(key, 'BREAKEVEN CLOSED', false); return; }
        if (px >= lk.tp3) { closeActiveLock(key, 'TP3 COMPLETED', false); }
      } else {
        if (!lk.tp1Hit && px >= lk.sl) { closeActiveLock(key, 'SL HIT', true); return; }
        if (!lk.tp1Hit && px <= lk.tp1) {
          lk.tp1Hit = true;
          lk.sl = lk.entry;
          saveLocks();
          showToast(`${lk.asset} TP1 HIT — Move SL to BE`);
        }
        if (lk.tp1Hit && !lk.tp2Hit && px <= lk.tp2) {
          lk.tp2Hit = true;
          saveLocks();
          showToast(`${lk.asset} TP2 HIT!`);
        }
        if (lk.tp1Hit && px >= lk.sl) { closeActiveLock(key, 'BREAKEVEN CLOSED', false); return; }
        if (px <= lk.tp3) { closeActiveLock(key, 'TP3 COMPLETED', false); }
      }
    },
    [closeActiveLock, getLockKey, saveLocks, showToast]
  );

  const applyEvaluationToUI = useCallback(
    (
      sym: string,
      tf: TimeframeKey,
      ltf: CandleBundle,
      htfBars: CandleBar[] | null,
      d1Bars: CandleBar[] | null,
      h1Bars: CandleBar[] | null,
      isBarCloseOrLoad: boolean,
      latencyMs: number,
      scheduleBacktest: boolean
    ) => {
      const prov = stateRef.current.provider;
      const rCfg = stateRef.current.riskConfig;
      const prof = TF_PROFILES[tf];
      const liveQuote = quotesRef.current[prov]?.[sym] || null;
      const freshness = evaluateQuoteFreshness(liveQuote, tf);

      const fresh = evaluateSetup(sym, tf, ltf.closedBars, ltf.formingBar, htfBars, d1Bars, h1Bars, {
        provider: prov,
        riskConfig: rCfg,
        brokerSpecsOverride: brokerSpecsOverrideRef.current,
        liveQuote,
        freshness,
      });

      const lockKey = `${prov}:${sym}:${tf}`;
      let activeLock: ActiveLock | undefined = activeLocksRef.current[lockKey];

      if (activeLock && isBarCloseOrLoad && fresh.candleTime > activeLock.candleTime) {
        const opp =
          (activeLock.type === 'BUY' && (fresh.type === 'SELL' || fresh.diagSetup.startsWith('SELL'))) ||
          (activeLock.type === 'SELL' && (fresh.type === 'BUY' || fresh.diagSetup.startsWith('BUY')));
        if (opp && fresh.setupScore >= 60) {
          closeActiveLock(lockKey, 'OPPOSITE SIGNAL', false);
          activeLock = undefined;
        }
      }

      const wasDismissed = dismissedBarRef.current[lockKey] === fresh.candleTime;
      if (!activeLock && fresh.state === 'READY' && !wasDismissed && fresh.entry !== null && fresh.tp1 !== null && fresh.tp2 !== null && fresh.tp3 !== null && fresh.sl !== null) {
        activeLock = {
          id: `${sym}:${tf}:${fresh.candleTime}`,
          asset: sym,
          tf,
          provider: prov,
          type: fresh.type as 'BUY' | 'SELL',
          entryMode: fresh.entryMode,
          entry: fresh.entry,
          entryZone: fresh.entryZone,
          tp1: fresh.tp1,
          tp2: fresh.tp2,
          tp3: fresh.tp3,
          sl: fresh.sl,
          grossRR: fresh.grossRR,
          netRR: fresh.netRR,
          rrText: fresh.rrText,
          riskCalc: fresh.riskCalc,
          candleTime: fresh.candleTime,
          time: fresh.time,
          tp1Hit: false,
          tp2Hit: false,
        };
        activeLocksRef.current[lockKey] = activeLock;
        saveLocks();

        const bk = `${prov}:${sym}:${tf}:${fresh.candleTime}`;
        if (lastSignalBarKeyRef.current !== bk) {
          lastSignalBarKeyRef.current = bk;
          const entryRow: HistoryEntry = {
            time: fresh.time,
            date: new Date(fresh.candleTime).toLocaleDateString(),
            asset: sym,
            desk: SYMBOL_SPECS[sym].desk,
            tf: prof.label,
            source: prov,
            type: fresh.type as 'BUY' | 'SELL',
            entry: fmtPrice(fresh.entry, sym),
            tp1: fmtPrice(fresh.tp1, sym),
            sl: fmtPrice(fresh.sl, sym),
            status: `${fresh.entryMode} · ${fresh.setupScore}%`,
          };
          setSignalHistoryLog((prev) => {
            const next = [entryRow, ...prev].slice(0, 60);
            try {
              localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(next));
            } catch {
              // ignore
            }
            return next;
          });
          if (stateRef.current.alertEnabled) playSignalSound();
          showToast(`READY: ${sym} ${prof.label} ${fresh.type}`);
        }
      }

      let finalSig: SignalOutput;
      if (activeLock) {
        const px = liveQuote ? (activeLock.type === 'BUY' ? liveQuote.bid : liveQuote.ask) : null;
        const slDist = Math.abs(activeLock.entry - activeLock.sl);
        const adverseMove = px ? (activeLock.type === 'BUY' ? activeLock.entry - px : px - activeLock.entry) : 0;
        const revWarn =
          (slDist > 0 && adverseMove >= slDist * 0.55 && !activeLock.tp1Hit) ||
          (activeLock.type === 'BUY' && fresh.ema8 !== null && fresh.ema21 !== null && fresh.ema8 < fresh.ema21) ||
          (activeLock.type === 'SELL' && fresh.ema8 !== null && fresh.ema21 !== null && fresh.ema8 > fresh.ema21);

        finalSig = {
          ...fresh,
          state: 'READY',
          type: activeLock.type,
          entryMode: activeLock.tp2Hit
            ? 'TP2 HIT · RUNNER'
            : activeLock.tp1Hit
            ? 'TP1 HIT · SL AT BE'
            : activeLock.entryMode || 'LOCKED',
          entry: activeLock.entry,
          entryZone: activeLock.entryZone ?? fresh.entryZone,
          tp1: activeLock.tp1,
          tp2: activeLock.tp2,
          tp3: activeLock.tp3,
          sl: activeLock.sl,
          grossRR: activeLock.grossRR ?? fresh.grossRR,
          netRR: activeLock.netRR ?? fresh.netRR,
          rrText: activeLock.rrText ?? fresh.rrText,
          riskCalc: activeLock.riskCalc ?? fresh.riskCalc,
          locked: true,
          reversalWarning: revWarn,
          tp1Hit: activeLock.tp1Hit,
          tp2Hit: Boolean(activeLock.tp2Hit),
          watchNote: revWarn
            ? `⚠ Market pulling back against ${activeLock.type} (${fmtPrice(adverseMove, sym)} move) — watch SL or Close/Unlock`
            : null,
          reason: `LOCKED ${activeLock.type} (${activeLock.tp1Hit ? 'TP1 hit' : 'tracking TP1/SL'})`,
        };
      } else {
        finalSig = fresh;
      }

      setChartErrorMsg(null);
      setAnalysisLatencyMs(Math.max(0.1, latencyMs));
      setCurrentSignal(finalSig);

      if (scheduleBacktest) {
        if (pendingWfTimerRef.current) clearTimeout(pendingWfTimerRef.current);
        pendingWfTimerRef.current = setTimeout(() => {
          const wf = runWalkForwardForTimeframe(
            sym,
            tf,
            ltf.closedBars,
            htfBars,
            d1Bars,
            h1Bars,
            {
              provider: prov,
              riskConfig: stateRef.current.riskConfig,
              brokerSpecsOverride: brokerSpecsOverrideRef.current,
              liveQuote: quotesRef.current[prov]?.[sym] || null,
            },
            wfCacheRef.current
          );
          setWalkForwardStats(wf);
        }, 25);
      }
    },
    [closeActiveLock, saveLocks, showToast]
  );

  const analyzeActiveMarket = useCallback(
    async (
      isBarCloseOrLoad = true,
      forceFreshLtf = false,
      overrideSym?: string,
      overrideTf?: TimeframeKey,
      overrideProv?: ProviderType
    ): Promise<number> => {
      const myEp = ++analysisEpochRef.current;
      const t0 = performance.now();
      const sym = overrideSym ?? stateRef.current.activeSymbol;
      const tf = overrideTf ?? stateRef.current.currentTF;
      const prov = overrideProv ?? stateRef.current.provider;
      const prof = TF_PROFILES[tf];

      if (forceFreshLtf) {
        delete candlesCacheRef.current[`${prov}:${sym}:${tf}`];
      }

      const cachedLtf = candlesCacheRef.current[`${prov}:${sym}:${tf}`];
      if (cachedLtf && !forceFreshLtf) {
        const cHtf = candlesCacheRef.current[`${prov}:${sym}:${prof.htf}`];
        const cD1 = candlesCacheRef.current[`${prov}:${sym}:D1`];
        const cH1 = candlesCacheRef.current[`${prov}:${sym}:H1`];
        applyEvaluationToUI(
          sym,
          tf,
          cachedLtf,
          cHtf?.closedBars || null,
          cD1?.closedBars || null,
          cH1?.closedBars || null,
          isBarCloseOrLoad,
          performance.now() - t0,
          false
        );
      }

      try {
        const [ltfR, htfR, d1R, h1R] = await Promise.allSettled([
          fetchSymbolCandles(prov, sym, tf, candlesCacheRef.current, !forceFreshLtf && !isBarCloseOrLoad),
          prof.htf !== tf
            ? fetchSymbolCandles(prov, sym, prof.htf, candlesCacheRef.current, true)
            : Promise.resolve(null),
          tf !== 'D1' ? fetchSymbolCandles(prov, sym, 'D1', candlesCacheRef.current, true) : Promise.resolve(null),
          tf !== 'H1' ? fetchSymbolCandles(prov, sym, 'H1', candlesCacheRef.current, true) : Promise.resolve(null),
        ]);

        if (myEp !== analysisEpochRef.current) return 0;
        if (ltfR.status !== 'fulfilled') throw ltfR.reason;

        const ltf = ltfR.value;
        const htfBars = prof.htf === tf ? ltf.closedBars : htfR.status === 'fulfilled' ? htfR.value?.closedBars || null : null;
        const d1Bars = tf === 'D1' ? ltf.closedBars : d1R.status === 'fulfilled' ? d1R.value?.closedBars || null : null;
        const h1Bars = tf === 'H1' ? ltf.closedBars : h1R.status === 'fulfilled' ? h1R.value?.closedBars || null : null;

        applyEvaluationToUI(sym, tf, ltf, htfBars, d1Bars, h1Bars, isBarCloseOrLoad, performance.now() - t0, true);
        return ltf.closedBars.length ? ltf.closedBars[ltf.closedBars.length - 1].timeMs : 0;
      } catch (err: any) {
        if (myEp !== analysisEpochRef.current) return 0;
        const msg = err?.message || 'Feed unavailable';
        setAnalysisLatencyMs(Math.max(0.1, performance.now() - t0));
        setChartErrorMsg(msg);
        setCurrentSignal((prev) => ({
          ...createInitialSignal(sym, tf, prov),
          keyLevels: prev.keyLevels,
          state: 'NO TRADE',
          entryMode: 'ERROR',
          diagVeto: msg,
          reason: `NO TRADE: ${msg}`,
        }));
        return 0;
      }
    },
    [applyEvaluationToUI]
  );

  const scheduleTickEvaluation = useCallback(() => {
    if (queuedTickTimerRef.current) return;
    const tf = stateRef.current.currentTF;
    const delay = tf === 'M1' || tf === 'M5' ? 900 : 1800;
    queuedTickTimerRef.current = setTimeout(() => {
      queuedTickTimerRef.current = null;
      analyzeActiveMarket(false);
    }, delay);
  }, [analyzeActiveMarket]);

  const subscribeActiveBiquoteSymbols = useCallback(async (conn: signalR.HubConnection | null, force = false) => {
    if (!conn || conn.state !== signalR.HubConnectionState.Connected) return;
    const key = SUPPORTED_SYMBOLS.slice().sort().join(',');
    if (!force && subscribedKeyRef.current === key) return;
    try {
      await conn.invoke('Subscribe', SUPPORTED_SYMBOLS);
      subscribedKeyRef.current = key;
    } catch {
      // ignore
    }
  }, []);

  const connectBiquoteSignalR = useCallback(async () => {
    if (stateRef.current.provider !== 'BIQUOTE' || isConnectingSrRef.current) return;
    isConnectingSrRef.current = true;
    try {
      if (signalRConnRef.current) {
        try {
          await signalRConnRef.current.stop();
        } catch {
          // ignore
        }
        signalRConnRef.current = null;
      }
      subscribedKeyRef.current = '';
      signalRStateRef.current = 'CONNECTING';

      const conn = new signalR.HubConnectionBuilder()
        .withUrl(BIQUOTE_HUB, { withCredentials: false })
        .withAutomaticReconnect([0, 2000, 5000, 10000, 20000])
        .configureLogging(signalR.LogLevel.None)
        .build();

      conn.on('ReceiveTick', (tick: any) => {
        if (stateRef.current.provider !== 'BIQUOTE' || !tick) return;
        const sym = String(tick.symbol || '').toUpperCase();
        if (!SUPPORTED_SYMBOLS.includes(sym)) return;

        const prevMid = quotesRef.current.BIQUOTE?.[sym]?.mid || 0;
        const res = ingestQuoteUpdate(quotesRef.current, sym, tick, 'BIQUOTE', true);
        if (!res.accepted || !res.quote) return;

        if (sym === stateRef.current.activeSymbol) {
          if (prevMid && res.quote.mid > prevMid) setTickPulseDir('up');
          else if (prevMid && res.quote.mid < prevMid) setTickPulseDir('down');
          else setTickPulseDir('flat');

          evaluateActiveLockOnTick(res.quote);

          const c = candlesCacheRef.current[`BIQUOTE:${sym}:${stateRef.current.currentTF}`];
          if (c?.formingBar) {
            c.formingBar.close = res.quote.mid;
            c.formingBar.high = Math.max(c.formingBar.high, res.quote.mid);
            c.formingBar.low = Math.min(c.formingBar.low, res.quote.mid);
          }

          if (!activeLocksRef.current[getLockKey()]) {
            scheduleTickEvaluation();
          }
        }
        setQuoteRenderSeq((n) => (n + 1) % 1000000);
      });

      conn.onreconnecting(() => {
        signalRStateRef.current = 'RECONNECTING';
        subscribedKeyRef.current = '';
        setStatusMessage('Reconnecting…');
        setStatusLevel('warn');
      });
      conn.onreconnected(async () => {
        signalRStateRef.current = 'CONNECTED';
        await subscribeActiveBiquoteSymbols(conn, true);
        setStatusMessage('BIQUOTE · Live');
        setStatusLevel('ok');
      });
      conn.onclose(() => {
        signalRStateRef.current = 'DISCONNECTED';
        subscribedKeyRef.current = '';
        if (stateRef.current.provider === 'BIQUOTE') {
          setStatusMessage('SignalR off — polling');
          setStatusLevel('warn');
        }
      });

      signalRConnRef.current = conn;
      await conn.start();
      signalRStateRef.current = 'CONNECTED';
      await subscribeActiveBiquoteSymbols(conn, true);
      setStatusMessage('BIQUOTE · Live');
      setStatusLevel('ok');
    } catch {
      signalRStateRef.current = 'POLLING';
      setStatusMessage('BIQUOTE · Polling');
      setStatusLevel('ok');
    } finally {
      isConnectingSrRef.current = false;
    }
  }, [evaluateActiveLockOnTick, getLockKey, scheduleTickEvaluation, subscribeActiveBiquoteSymbols]);

  const checkExnessBridge = useCallback(
    async (runAnalysis = true) => {
      const sym = stateRef.current.activeSymbol;
      try {
        const res = await safeFetch(`/api/quote?symbol=${encodeURIComponent(sym)}`, {}, 2500);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (!d.connected) throw new Error(d.error || 'Disconnected');

        const s = String(d.symbol || sym).toUpperCase();
        if (Number(d.trade_contract_size) > 0 && Number(d.trade_tick_size) > 0) {
          brokerSpecsOverrideRef.current[s] = {
            digits: Number.isInteger(Number(d.digits)) ? Number(d.digits) : SYMBOL_SPECS[s]?.digits,
            pointSize: Number(d.point) > 0 ? Number(d.point) : SYMBOL_SPECS[s]?.pointSize,
            tickSize: Number(d.trade_tick_size),
            tickValueUsd: Number(d.trade_tick_value) > 0 ? Number(d.trade_tick_value) : undefined,
            contractSize: Number(d.trade_contract_size),
            volumeMin: Number(d.volume_min) > 0 ? Number(d.volume_min) : 0.01,
            volumeStep: Number(d.volume_step) > 0 ? Number(d.volume_step) : 0.01,
            verified: true,
          };
        }

        const ing = ingestQuoteUpdate(
          quotesRef.current,
          s,
          {
            bid: d.bid,
            ask: d.ask,
            high: d.high,
            low: d.low,
            dayDiffPercent: d.change_pct,
            timestamp: d.timestamp || d.time || d.time_msc,
            source: 'EXNESS MT5',
            marketState: d.market_state || 'open',
            stale: Boolean(d.stale),
          },
          'EXNESS',
          true
        );
        if (!ing.accepted && ing.reason !== 'Duplicate (age preserved)') {
          throw new Error(ing.reason);
        }

        const f = evaluateQuoteFreshness(quotesRef.current.EXNESS?.[s], stateRef.current.currentTF);
        setStatusMessage(f.fresh ? `EXNESS · Live (${s})` : `EXNESS: ${f.label}`);
        setStatusLevel(f.fresh ? 'ok' : 'warn');
        setQuoteRenderSeq((n) => (n + 1) % 1000000);
        if (runAnalysis) await analyzeActiveMarket(true);
      } catch (e: any) {
        setStatusMessage(`EXNESS unavailable — ${e?.message || 'Bridge off'}`);
        setStatusLevel('err');
        setQuoteRenderSeq((n) => (n + 1) % 1000000);
        if (runAnalysis) await analyzeActiveMarket(true);
      }
    },
    [analyzeActiveMarket]
  );

  // Candle-close auto-retry (+2.5s, +6s, +11s)
  const triggerCandleCloseRefresh = useCallback(() => {
    candleRetryTimersRef.current.forEach(clearTimeout);
    candleRetryTimersRef.current = [];
    const prevCt = stateRef.current.currentSignal.candleTime || 0;
    [2500, 6000, 11000].forEach((delay) => {
      candleRetryTimersRef.current.push(
        setTimeout(async () => {
          const latestCt = await analyzeActiveMarket(true, true);
          if (latestCt > prevCt) {
            candleRetryTimersRef.current.forEach(clearTimeout);
            candleRetryTimersRef.current = [];
          }
        }, delay)
      );
    });
  }, [analyzeActiveMarket]);

  // Provider bootstrap & polling timers
  useEffect(() => {
    let fallbackPollId: ReturnType<typeof setInterval> | null = null;
    let exnessPollId: ReturnType<typeof setInterval> | null = null;

    if (provider === 'BIQUOTE') {
      setStatusMessage('Connecting…');
      setStatusLevel('warn');
      checkBiquoteActiveSymbols().catch(() => {});
      fetchBiquoteLatestSnapshot(quotesRef.current)
        .then(() => {
          setQuoteRenderSeq((n) => (n + 1) % 1000000);
          analyzeActiveMarket(true, false, stateRef.current.activeSymbol, stateRef.current.currentTF, 'BIQUOTE');
        })
        .catch((e: any) => {
          setStatusMessage(`ERR — ${e?.message || 'Failed'}`);
          setStatusLevel('err');
        });
      connectBiquoteSignalR();
      analyzeActiveMarket(true, true, activeSymbol, currentTF, 'BIQUOTE');

      fallbackPollId = setInterval(() => {
        if (stateRef.current.provider === 'BIQUOTE' && signalRStateRef.current !== 'CONNECTED') {
          fetchBiquoteLatestSnapshot(quotesRef.current)
            .then(() => {
              setQuoteRenderSeq((n) => (n + 1) % 1000000);
              const q = quotesRef.current.BIQUOTE?.[stateRef.current.activeSymbol];
              if (q) evaluateActiveLockOnTick(q);
            })
            .catch(() => {});
        }
      }, 4000);
    } else {
      if (signalRConnRef.current) {
        signalRConnRef.current.stop().catch(() => {});
        signalRConnRef.current = null;
      }
      signalRStateRef.current = 'DISCONNECTED';
      subscribedKeyRef.current = '';
      checkExnessBridge(true);
      exnessPollId = setInterval(() => checkExnessBridge(false), 3000);
    }

    return () => {
      if (fallbackPollId) clearInterval(fallbackPollId);
      if (exnessPollId) clearInterval(exnessPollId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // 1-second wall clock, candle close detector, and 20-min reminder timer
  const prevBucketRef = useRef<number>(Math.floor(Date.now() / 1000 / (TF_PROFILES[currentTF]?.seconds || 900)));
  useEffect(() => {
    prevBucketRef.current = Math.floor(Date.now() / 1000 / (TF_PROFILES[currentTF]?.seconds || 900));
    const id = setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      const sec = TF_PROFILES[stateRef.current.currentTF]?.seconds || 900;
      const b = Math.floor(now / 1000 / sec);
      if (b !== prevBucketRef.current) {
        prevBucketRef.current = b;
        triggerCandleCloseRefresh();
      }
      const dt = new Date(now);
      if (dt.getMinutes() % 20 === 0 && dt.getSeconds() === 0 && stateRef.current.alertEnabled) {
        playSignalSound();
        showToast('20m review reminder');
      }
    }, 1000);
    return () => clearInterval(id);
  }, [currentTF, showToast, triggerCandleCloseRefresh]);

  useEffect(() => {
    return () => {
      candleRetryTimersRef.current.forEach(clearTimeout);
      if (queuedTickTimerRef.current) clearTimeout(queuedTickTimerRef.current);
      if (pendingWfTimerRef.current) clearTimeout(pendingWfTimerRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (signalRConnRef.current) signalRConnRef.current.stop().catch(() => {});
    };
  }, []);

  // Handlers
  const handleSetProvider = (p: ProviderType) => {
    if (p === provider) return;
    localStorage.setItem(STORAGE_KEYS.provider, p);
    setProvider(p);
  };

  const handleSetLang = (l: LangCode) => {
    localStorage.setItem(STORAGE_KEYS.language, l);
    setLang(l);
  };

  const handleToggleAlert = () => {
    const next = !alertEnabled;
    localStorage.setItem(STORAGE_KEYS.alerts, String(next));
    setAlertEnabled(next);
    showToast(next ? 'Reminder ON' : 'Reminder OFF');
  };

  const handleManualRefresh = async () => {
    setRefreshing(true);
    try {
      if (provider === 'BIQUOTE') {
        await checkBiquoteActiveSymbols().catch(() => {});
        await fetchBiquoteLatestSnapshot(quotesRef.current);
        setQuoteRenderSeq((n) => (n + 1) % 1000000);
        if (signalRStateRef.current !== 'CONNECTED') await connectBiquoteSignalR();
        await analyzeActiveMarket(true, true);
        showToast('Refreshed');
      } else {
        await checkExnessBridge(true);
        showToast('Exness checked');
      }
    } catch (e: any) {
      setStatusMessage(`Err: ${e?.message || 'Failed'}`);
      setStatusLevel('err');
      showToast(`Refresh failed: ${e?.message || 'Error'}`);
    } finally {
      setRefreshing(false);
    }
  };

  const handleSelectSymbol = (sym: string) => {
    if (!SUPPORTED_SYMBOLS.includes(sym)) return;
    const desk = SYMBOL_SPECS[sym].desk;
    localStorage.setItem(STORAGE_KEYS.symbol, sym);
    localStorage.setItem(STORAGE_KEYS.desk, desk);
    setActiveSymbol(sym);
    setActiveDesk(desk);
    stateRef.current.activeSymbol = sym;
    analyzeActiveMarket(true, false, sym, currentTF, provider);
  };

  const handleSetMarketDesk = (desk: MarketDesk) => {
    localStorage.setItem(STORAGE_KEYS.desk, desk);
    setActiveDesk(desk);
    if (SYMBOL_SPECS[activeSymbol].desk !== desk) {
      const nextSym = desk === 'CRYPTO' ? 'BTCUSD' : 'XAUUSD';
      localStorage.setItem(STORAGE_KEYS.symbol, nextSym);
      setActiveSymbol(nextSym);
      stateRef.current.activeSymbol = nextSym;
      analyzeActiveMarket(true, false, nextSym, currentTF, provider);
    }
  };

  const handleChangeTimeframe = (tf: TimeframeKey) => {
    setCurrentTF(tf);
    stateRef.current.currentTF = tf;
    analyzeActiveMarket(true, false, activeSymbol, tf, provider);
  };

  const handleRiskConfigUpdate = (patch: Partial<RiskConfig>) => {
    const next: RiskConfig = { ...riskConfig, ...patch };
    setRiskConfig(next);
    stateRef.current.riskConfig = next;
    localStorage.setItem(STORAGE_KEYS.riskBal, String(Math.max(5, next.balance)));
    localStorage.setItem(STORAGE_KEYS.riskPct, String(Math.max(0.1, Math.min(5.0, next.riskPercent))));
    localStorage.setItem(STORAGE_KEYS.dailyCap, String(Math.max(0.25, Math.min(5.0, next.dailyCap))));
    localStorage.setItem(STORAGE_KEYS.contractMode, next.contractMode);
    localStorage.setItem(STORAGE_KEYS.commission, String(Math.max(0, next.commission)));
    wfCacheRef.current = {};
    analyzeActiveMarket(true, false);
  };

  const handleToggleManualPosition = () => {
    const nextOpen = riskLedger.openPositions > 0 ? 0 : 1;
    saveRiskLedger({ ...riskLedger, openPositions: nextOpen });
    showToast(nextOpen ? 'Marked 1 open trade' : 'Marked 0 open trades');
  };

  const handleRecordSimulatedLoss = () => {
    const p = Math.max(0.1, Number(riskConfig.riskPercent || 0.5));
    const nextLosses = riskLedger.consecutiveLosses + 1;
    saveRiskLedger({
      ...riskLedger,
      dailyLossPct: Number((riskLedger.dailyLossPct + p).toFixed(2)),
      consecutiveLosses: nextLosses,
      pausedForReview: nextLosses >= 2 ? true : riskLedger.pausedForReview,
    });
    showToast(`Loss logged (${nextLosses}L)`);
  };

  const handleResetRiskPause = () => {
    saveRiskLedger({
      ...riskLedger,
      consecutiveLosses: 0,
      dailyLossPct: 0,
      openPositions: 0,
      pausedForReview: false,
    });
    showToast('Risk guard reset');
  };

  const handleManualUnlock = () => {
    const key = getLockKey();
    const lk = activeLocksRef.current[key];
    if (lk) {
      dismissedBarRef.current[key] = lk.candleTime;
      delete activeLocksRef.current[key];
      saveLocks();
    }
    setCurrentSignal((prev) => ({ ...prev, locked: false, reversalWarning: false }));
    showToast('Unlocked — refreshing live setup…');
    analyzeActiveMarket(false);
  };

  const handleCopySignal = () => {
    const s = currentSignal;
    const prof = TF_PROFILES[s.tf || currentTF];
    const sym = s.asset || activeSymbol;
    const kl = s.keyLevels;
    const eq = Math.max(5, Number(riskConfig.balance || 80));
    const rp = Math.max(0.1, Math.min(5.0, Number(riskConfig.riskPercent || 0.5)));
    const scale = s.danger?.riskScale || 1;
    const bud = eq * (rp / 100) * scale;
    const lotLabel = s.riskCalc
      ? s.riskCalc.valid
        ? `${s.riskCalc.lots.toFixed(2)} lots (${(scale * 100).toFixed(0)}%)`
        : `${s.riskCalc.lots.toFixed(2)} (WARN)`
      : `Budget $${bud.toFixed(2)}`;

    const txt = [
      `${APP_VERSION} (${RELEASE_DATE})`,
      `${s.source} | ${sym} (${SYMBOL_SPECS[sym].desk}) ${prof.label} | ${s.danger?.label}`,
      `State: ${s.state} | Type: ${s.type} (${s.entryMode}) | Score: ${s.setupScore}%`,
      `Entry: ${Number.isFinite(s.entry) ? fmtPrice(s.entry, sym) : '—'} | SL: ${Number.isFinite(s.sl) ? fmtPrice(s.sl, sym) : '—'}`,
      `TP1: ${Number.isFinite(s.tp1) ? fmtPrice(s.tp1, sym) : '—'} | TP2: ${Number.isFinite(s.tp2) ? fmtPrice(s.tp2, sym) : '—'} | TP3: ${Number.isFinite(s.tp3) ? fmtPrice(s.tp3, sym) : '—'}`,
      `S1: ${kl.s1 ? fmtPrice(kl.s1.price, sym) : '—'} | R1: ${kl.r1 ? fmtPrice(kl.r1.price, sym) : '—'} | Lot: ${lotLabel}`,
    ].join('\n');

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(txt).then(() => showToast('Analysis copied')).catch(() => showToast('Copy unavailable'));
    }
  };

  const handleToggleLayer = (k: keyof ChartLayers) => {
    const next = { ...chartLayers, [k]: !chartLayers[k] };
    setChartLayers(next);
    try {
      localStorage.setItem(STORAGE_KEYS.layers, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const handleRunQa = async () => {
    setQaLogs([]);
    setQaRunning(true);
    await executeFullQaSuite(signalRStateRef.current, (entry) => {
      setQaLogs((prev) => [...prev, entry]);
    });
    setQaRunning(false);
    await handleManualRefresh();
  };

  // Derived view values
  const activeQuote = quotesRef.current[provider]?.[activeSymbol] || null;
  const activeFreshness = evaluateQuoteFreshness(activeQuote, currentTF, nowMs);
  const activeSpec = getSymbolSpec(activeSymbol, provider, activeQuote?.mid, riskConfig, brokerSpecsOverrideRef.current, activeQuote?.mid);
  const pxPrefix = activeSpec.group === 'GOLD' || activeSpec.group === 'CRYPTO' ? '$' : '';

  const deskSymbols = useMemo(
    () => SUPPORTED_SYMBOLS.filter((s) => SYMBOL_SPECS[s].desk === activeDesk),
    [activeDesk]
  );

  const deskCounts = useMemo(() => {
    let avail = 0;
    let live = 0;
    deskSymbols.forEach((s) => {
      const f = evaluateQuoteFreshness(quotesRef.current[provider]?.[s], currentTF, nowMs);
      if (f.available) avail++;
      if (f.fresh) live++;
    });
    return { avail, live, total: deskSymbols.length };
  }, [deskSymbols, provider, currentTF, nowMs]);

  // Clocks
  const dtNow = new Date(nowMs);
  const utcClock = dtNow.toISOString().slice(11, 19) + ' UTC';
  const utcHour = dtNow.getUTCHours();
  const londonOpen = utcHour >= 7 && utcHour < 16;
  const nyOpen = utcHour >= 12 && utcHour < 21;
  const tokyoOpen = utcHour >= 0 && utcHour < 9;

  const tfDurationSec = TF_PROFILES[currentTF]?.seconds || 900;
  const candleLeftSec = Math.max(0, tfDurationSec - (Math.floor(nowMs / 1000) % tfDurationSec));
  const cH = Math.floor(candleLeftSec / 3600);
  const cM = Math.floor((candleLeftSec % 3600) / 60);
  const cS = candleLeftSec % 60;
  const candleTimerStr = cH
    ? `${String(cH).padStart(2, '0')}:${String(cM).padStart(2, '0')}:${String(cS).padStart(2, '0')}`
    : `${String(cM).padStart(2, '0')}:${String(cS).padStart(2, '0')}`;

  const raw20mLeft = 1200 - ((dtNow.getMinutes() % 20) * 60 + dtNow.getSeconds());
  const alert20mSec = raw20mLeft <= 0 ? 1200 : raw20mLeft;
  const alertCountdownStr = `${String(Math.floor(alert20mSec / 60)).padStart(2, '0')}:${String(alert20mSec % 60).padStart(2, '0')}`;

  // Live P/L
  const livePnl = useMemo(() => {
    if (!activeQuote || !activeFreshness.fresh || currentSignal.state !== 'READY' || !Number.isFinite(currentSignal.entry) || !activeSpec.verified) {
      return { text: activeFreshness.status !== 'LIVE' ? activeFreshness.status : 'Live P/L: —', cls: 'text-slate-400' };
    }
    const ex = currentSignal.type === 'BUY' ? activeQuote.bid : activeQuote.ask;
    const mv = currentSignal.type === 'BUY' ? ex - currentSignal.entry! : currentSignal.entry! - ex;
    const p = mv / activeSpec.pipSize;
    const text =
      activeSpec.group === 'GOLD' || activeSpec.group === 'CRYPTO'
        ? `Live: ${mv >= 0 ? '+' : '-'}$${Math.abs(mv).toFixed(activeSpec.digits)} (${p >= 0 ? '+' : ''}${p.toFixed(1)}p)`
        : `Live: ${p >= 0 ? '+' : ''}${p.toFixed(1)} pips`;
    return { text, cls: mv >= 0 ? 'text-emerald-400' : 'text-red-400' };
  }, [activeQuote, activeFreshness, currentSignal, activeSpec]);

  // Risk summary values
  const eq = Math.max(5, Number(riskConfig.balance || 80));
  const rp = Math.max(0.1, Math.min(5.0, Number(riskConfig.riskPercent || 0.5)));
  const riskScale = currentSignal.danger?.riskScale || 1;
  const scaledBudget = eq * (rp / 100) * riskScale;

  // Chart bars
  const activeBundle = candlesCacheRef.current[`${provider}:${activeSymbol}:${currentTF}`];
  const chartClosedBars = activeBundle?.closedBars || [];
  const chartFormingBar = activeBundle?.formingBar || null;

  // Signal Card styling
  const isReadyBuy = currentSignal.state === 'READY' && currentSignal.type === 'BUY';
  const isReadySell = currentSignal.state === 'READY' && currentSignal.type === 'SELL';
  const isWatch = currentSignal.state === 'WATCH';
  const isNoTrade = currentSignal.state === 'NO TRADE';

  const cardBorderClass = isReadyBuy
    ? 'border-emerald-500/65'
    : isReadySell
    ? 'border-red-500/65'
    : isWatch
    ? 'border-blue-500/65'
    : isNoTrade
    ? 'border-red-500/35'
    : 'border-amber-500/55';

  const badgeClass = isReadyBuy
    ? 'bg-emerald-500 text-slate-950 animate-pulse-buy'
    : isReadySell
    ? 'bg-red-500 text-white animate-pulse-sell'
    : isWatch
    ? 'bg-blue-500 text-white'
    : isNoTrade
    ? 'bg-red-900/75 text-red-200 border border-red-800'
    : 'bg-amber-500 text-slate-950';

  const badgeLabel = isReadyBuy
    ? 'READY · BUY'
    : isReadySell
    ? 'READY · SELL'
    : currentSignal.state;

  const filteredHistory = useMemo(
    () => signalHistoryLog.filter((it) => historyFilter === 'ALL' || (it.desk || SYMBOL_SPECS[it.asset]?.desk || 'FOREX') === historyFilter),
    [signalHistoryLog, historyFilter]
  );

  const kl = currentSignal.keyLevels;
  const r1Text = kl.r1 ? `${pxPrefix}${fmtPrice(kl.r1.price, activeSymbol)}` : 'R1';
  const r2Text = kl.r2 ? `${pxPrefix}${fmtPrice(kl.r2.price, activeSymbol)}` : 'R2';
  const s1Text = kl.s1 ? `${pxPrefix}${fmtPrice(kl.s1.price, activeSymbol)}` : 'S1';
  const s2Text = kl.s2 ? `${pxPrefix}${fmtPrice(kl.s2.price, activeSymbol)}` : 'S2';

  const prof = TF_PROFILES[currentSignal.tf || currentTF];

  return (
    <div className="flex min-h-screen flex-col justify-between">
      <HeaderBar
        subtitle={t.subtitle}
        provider={provider}
        statusMessage={statusMessage}
        statusLevel={statusLevel}
        refreshing={refreshing}
        refreshLabel={t.refreshBtn}
        alertEnabled={alertEnabled}
        alertLabel={alertEnabled ? t.alertOn : t.alertOff}
        alertCountdown={alertCountdownStr}
        lang={lang}
        qaLabel={t.apiBtn}
        onSetProvider={handleSetProvider}
        onRefresh={handleManualRefresh}
        onToggleAlert={handleToggleAlert}
        onSetLang={handleSetLang}
        onOpenQa={() => setQaModalOpen(true)}
      />

      <main className="mx-auto flex w-full max-w-7xl flex-grow flex-col gap-3.5 px-3.5 py-4">
        {/* Top 3 Summary Cards */}
        <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {/* Active Instrument */}
          <div className="rounded-2xl border border-[#1e2535] bg-gradient-to-br from-[#161c28] to-[#0d111a] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[11px] font-bold text-slate-400">{t.goldLabel}</div>
                <div className="text-xl font-extrabold text-white">{activeSymbol}</div>
              </div>
              <span
                className={`rounded-md border px-2 py-0.5 font-mono text-[10px] font-bold ${
                  activeFreshness.status === 'LIVE'
                    ? 'border-emerald-500/35 bg-emerald-500/15 text-emerald-400'
                    : activeFreshness.status === 'CLOSED'
                    ? 'border-amber-500/35 bg-amber-500/15 text-amber-400'
                    : activeFreshness.status === 'STALE'
                    ? 'border-orange-500/35 bg-orange-500/15 text-orange-400'
                    : 'border-red-500/35 bg-red-500/15 text-red-400'
                }`}
              >
                {activeFreshness.status}
              </span>
            </div>

            <div className="mt-2.5 flex items-center justify-between gap-2">
              <span
                className={`font-mono text-2xl font-extrabold ${
                  !activeQuote || !activeFreshness.available
                    ? 'text-red-400'
                    : tickPulseDir === 'up'
                    ? 'text-emerald-400'
                    : tickPulseDir === 'down'
                    ? 'text-red-400'
                    : 'text-amber-400'
                }`}
              >
                {activeQuote && activeFreshness.available ? `${pxPrefix}${fmtPrice(activeQuote.mid, activeSymbol)}` : 'DATA UNAVAILABLE'}
              </span>
              <span
                className={`rounded-md border px-2 py-0.5 font-mono text-[10px] font-bold ${
                  !activeQuote || !activeFreshness.available
                    ? 'border-red-500/35 bg-red-500/15 text-red-400'
                    : activeQuote.marketState === 'closed' || activeQuote.dayDiffPercent === null
                    ? 'border-amber-500/35 bg-amber-500/15 text-amber-400'
                    : activeQuote.dayDiffPercent >= 0
                    ? 'border-emerald-500/35 bg-emerald-500/15 text-emerald-400'
                    : 'border-red-500/35 bg-red-500/15 text-red-400'
                }`}
              >
                {!activeQuote || !activeFreshness.available
                  ? 'UNAVAILABLE'
                  : activeQuote.marketState === 'closed'
                  ? 'CLOSED'
                  : activeQuote.dayDiffPercent === null
                  ? '—'
                  : `${activeQuote.dayDiffPercent >= 0 ? '+' : ''}${activeQuote.dayDiffPercent.toFixed(2)}%`}
              </span>
            </div>

            <div className="mt-2.5 flex flex-col gap-0.5 font-mono text-[11px] text-slate-400">
              <div className="flex justify-between">
                <span>
                  Bid: <strong className="text-slate-200">{activeQuote && activeFreshness.available ? `${pxPrefix}${fmtPrice(activeQuote.bid, activeSymbol)}` : '—'}</strong>
                </span>
                <span>
                  Ask: <strong className="text-slate-200">{activeQuote && activeFreshness.available ? `${pxPrefix}${fmtPrice(activeQuote.ask, activeSymbol)}` : '—'}</strong>
                </span>
              </div>
              <div className="flex justify-between">
                <span>
                  Spread:{' '}
                  <strong className="text-slate-200">
                    {activeQuote && activeFreshness.available
                      ? `${pxPrefix}${activeQuote.spread.toFixed(activeSpec.digits || 2)} (${activeSpec.verified ? (activeQuote.spread / activeSpec.pipSize).toFixed(1) : '—'}p)`
                      : '—'}
                  </strong>
                </span>
                <span>
                  Age: <strong className="text-amber-400">{activeQuote && activeFreshness.available ? `${activeFreshness.ageSeconds}s` : '—'}</strong>
                </span>
              </div>
              <div className="flex justify-between">
                <span>
                  PDH: <strong className="text-emerald-400">{kl.pdh ? `${pxPrefix}${fmtPrice(kl.pdh, activeSymbol)}` : '—'}</strong>
                </span>
                <span>
                  PDL: <strong className="text-red-400">{kl.pdl ? `${pxPrefix}${fmtPrice(kl.pdl, activeSymbol)}` : '—'}</strong>
                </span>
              </div>
            </div>
          </div>

          {/* Market Quality & Squeeze */}
          <div className="flex flex-col justify-between rounded-2xl border border-[#1e2535] bg-gradient-to-br from-[#161c28] to-[#0d111a] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-extrabold text-amber-400">{t.profileTitle}</span>
              <span
                className={`rounded-md border px-2 py-0.5 font-mono text-[10px] font-bold ${
                  currentSignal.danger.pct >= 50
                    ? 'border-red-500/35 bg-red-500/15 text-red-400'
                    : currentSignal.danger.pct >= 25
                    ? 'border-orange-500/35 bg-orange-500/15 text-orange-400'
                    : 'border-emerald-500/35 bg-emerald-500/15 text-emerald-400'
                }`}
              >
                {currentSignal.danger.label}
              </span>
            </div>

            <div className="my-2 flex flex-col gap-1.5 font-mono text-[11px]">
              <div className="flex justify-between">
                <span className="text-slate-400">Regime:</span>
                <strong className="text-amber-400">{currentSignal.regime.regime || '—'}</strong>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">ADX(14) / Squeeze:</span>
                <strong className="text-slate-200">
                  {currentSignal.regime.adx
                    ? `ADX ${currentSignal.regime.adx.toFixed(1)} | ${currentSignal.regime.squeeze ? 'SQZ ON' : 'OPEN'}`
                    : '—'}
                </strong>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Adaptive Plan:</span>
                <strong className="text-emerald-400">
                  {(currentSignal.danger.riskScale * 100).toFixed(0)}% Risk | TP {currentSignal.danger.tp1R}R/{currentSignal.danger.tp2R}R
                </strong>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">HTF Bias:</span>
                <strong className="text-slate-200">{currentSignal.htfSummary}</strong>
              </div>
            </div>

            <div className="flex justify-between font-mono text-[10px] text-slate-500">
              <span>{prof.label}: {prof.role}</span>
              <span>
                Eval: <strong className="text-amber-400">{analysisLatencyMs.toFixed(1)} ms</strong>
              </span>
            </div>
          </div>

          {/* Market Hours */}
          <div className="flex flex-col justify-between rounded-2xl border border-[#1e2535] bg-gradient-to-br from-[#161c28] to-[#0d111a] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold text-slate-400">{t.marketSessions}</span>
              <span className="font-mono text-[11px] font-bold text-amber-400">{utcClock}</span>
            </div>

            <div className="my-2 grid grid-cols-2 gap-1.5 text-[11px]">
              <div className="flex items-center justify-between rounded-lg border border-[#1e2535] bg-[#080a0f] px-2.5 py-1.5">
                <span className="text-slate-400">London</span>
                <span className={`font-mono text-[10px] font-bold ${londonOpen ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {londonOpen ? 'OPEN' : 'CLOSED'}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-[#1e2535] bg-[#080a0f] px-2.5 py-1.5">
                <span className="text-slate-400">New York</span>
                <span className={`font-mono text-[10px] font-bold ${nyOpen ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {nyOpen ? 'OPEN' : 'CLOSED'}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-[#1e2535] bg-[#080a0f] px-2.5 py-1.5">
                <span className="text-slate-400">Tokyo</span>
                <span className={`font-mono text-[10px] font-bold ${tokyoOpen ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {tokyoOpen ? 'OPEN' : 'CLOSED'}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-[#1e2535] bg-[#080a0f] px-2.5 py-1.5">
                <span className="text-slate-400">Crypto</span>
                <span className="font-mono text-[10px] font-bold text-purple-400">24/7</span>
              </div>
            </div>

            <div className="flex justify-between font-mono text-[10px] text-slate-500">
              <span>
                Spec:{' '}
                <strong className={activeSpec.verified ? 'text-emerald-400' : 'text-red-400'}>
                  {activeSpec.verified ? `${riskConfig.contractMode} · ${activeSpec.specNote}` : 'UNVERIFIED'}
                </strong>
              </span>
              <span>{activeQuote ? activeQuote.timestamp.slice(11, 19) + 'Z' : '—'}</span>
            </div>
          </div>
        </section>

        {/* Separated Watchlist Tabs */}
        <section className="rounded-2xl border border-[#1e2535] bg-gradient-to-br from-[#161c28] to-[#0d111a] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="inline-flex rounded-lg border border-[#1e2535] bg-[#080a0f] p-0.5" role="tablist">
                <button
                  type="button"
                  onClick={() => handleSetMarketDesk('FOREX')}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-extrabold transition-colors ${
                    activeDesk === 'FOREX' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Coins className="h-3.5 w-3.5" />
                  <span>GOLD &amp; FOREX (8)</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSetMarketDesk('CRYPTO')}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-extrabold transition-colors ${
                    activeDesk === 'CRYPTO' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Bitcoin className="h-3.5 w-3.5" />
                  <span>CRYPTO 24/7 (6)</span>
                </button>
              </div>
              <span className="font-mono text-[11px] text-slate-400">
                {deskCounts.avail}/{deskCounts.total} Quotes ({deskCounts.live} Live)
              </span>
            </div>
            <span className="font-mono text-[10px] text-slate-500">
              {activeDesk === 'CRYPTO'
                ? 'Crypto 24/7 CFD Desk · Verify coin/lot contract'
                : 'Gold & Forex Major Desk · Mon–Fri UTC'}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {deskSymbols.map((sym) => {
              const q = quotesRef.current[provider]?.[sym];
              const f = evaluateQuoteFreshness(q, currentTF, nowMs);
              const spec = SYMBOL_SPECS[sym];
              const px = spec.group === 'GOLD' || spec.group === 'CRYPTO' ? '$' : '';
              const isActive = sym === activeSymbol;
              return (
                <button
                  key={sym}
                  type="button"
                  onClick={() => handleSelectSymbol(sym)}
                  className={`w-full cursor-pointer rounded-xl border p-2.5 text-left transition-colors ${
                    isActive
                      ? 'border-amber-500 bg-amber-500/10'
                      : 'border-[#1e2535] bg-[#080a0f] hover:border-amber-500/50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <strong className="font-mono text-xs text-white">{sym}</strong>
                    <span
                      className={`font-mono text-[10px] font-bold ${
                        f.status === 'LIVE'
                          ? 'text-emerald-400'
                          : f.status === 'CLOSED'
                          ? 'text-amber-400'
                          : f.status === 'STALE'
                          ? 'text-orange-400'
                          : 'text-red-400'
                      }`}
                    >
                      {f.status}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <strong className={`font-mono text-[13px] ${q && f.available ? 'text-amber-400' : 'text-red-400'}`}>
                      {q && f.available ? `${px}${fmtPrice(q.mid, sym)}` : 'UNAVAILABLE'}
                    </strong>
                    <span className="font-mono text-[10px] text-slate-400">
                      {q && f.available ? `${f.ageSeconds}s` : '—'}
                    </span>
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-slate-500">
                    {q && f.available ? `B: ${fmtPrice(q.bid, sym)} | A: ${fmtPrice(q.ask, sym)}` : spec.label}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Risk Supporter */}
        <section className="rounded-2xl border border-amber-500/40 bg-gradient-to-br from-[#161c28] to-[#0d111a] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-extrabold text-amber-400">
              <Shield className="h-4 w-4" />
              <span>{t.riskTitle}</span>
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={`rounded-md border px-2 py-0.5 font-mono text-[10px] font-bold ${
                  currentSignal.riskCalc && !currentSignal.riskCalc.valid
                    ? 'border-orange-500/35 bg-orange-500/15 text-orange-400'
                    : 'border-emerald-500/35 bg-emerald-500/15 text-emerald-400'
                }`}
              >
                {currentSignal.riskCalc
                  ? currentSignal.riskCalc.valid
                    ? `SAFE (${currentSignal.riskCalc.lots.toFixed(2)})`
                    : 'OVER BUDGET'
                  : 'READY'}
              </span>
              <button
                type="button"
                onClick={handleToggleManualPosition}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-emerald-600 bg-emerald-950/70 px-2 py-1 text-[10px] font-bold text-emerald-300 transition-colors hover:border-emerald-400"
              >
                <Check className="h-3 w-3" />
                <span>{riskLedger.openPositions ? 'Close (1/1)' : 'Enter (0/1)'}</span>
              </button>
              <button
                type="button"
                onClick={handleRecordSimulatedLoss}
                className="cursor-pointer rounded-md border border-[#1e2535] bg-[#080a0f] px-2 py-1 text-[10px] font-bold text-slate-200 hover:border-amber-500"
              >
                +1 Loss
              </button>
              <button
                type="button"
                onClick={handleResetRiskPause}
                className="cursor-pointer rounded-md border border-[#1e2535] bg-[#080a0f] px-2 py-1 text-[10px] font-bold text-amber-400 hover:border-amber-500"
              >
                Reset
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 items-end gap-2 md:grid-cols-5">
            <div>
              <label htmlFor="riskBalanceInput" className="mb-1 block text-[11px] text-slate-400">
                {t.lblBalance}
              </label>
              <input
                id="riskBalanceInput"
                type="number"
                min={5}
                step={5}
                value={riskConfig.balance}
                onChange={(e) => handleRiskConfigUpdate({ balance: Number(e.target.value) })}
                className="w-full rounded-lg border border-[#1e2535] bg-[#080a0f] px-2.5 py-1.5 font-mono text-xs font-bold text-white outline-none focus:border-amber-500"
              />
            </div>
            <div>
              <label htmlFor="riskPercentInput" className="mb-1 block text-[11px] text-slate-400">
                {t.lblRiskPct}
              </label>
              <input
                id="riskPercentInput"
                type="number"
                min={0.1}
                max={5.0}
                step={0.05}
                value={riskConfig.riskPercent}
                onChange={(e) => handleRiskConfigUpdate({ riskPercent: Number(e.target.value) })}
                className="w-full rounded-lg border border-[#1e2535] bg-[#080a0f] px-2.5 py-1.5 font-mono text-xs font-bold text-white outline-none focus:border-amber-500"
              />
            </div>
            <div>
              <label htmlFor="dailyLossLimitInput" className="mb-1 block text-[11px] text-slate-400">
                {t.lblDailyLimit}
              </label>
              <input
                id="dailyLossLimitInput"
                type="number"
                min={0.25}
                max={5.0}
                step={0.25}
                value={riskConfig.dailyCap}
                onChange={(e) => handleRiskConfigUpdate({ dailyCap: Number(e.target.value) })}
                className="w-full rounded-lg border border-[#1e2535] bg-[#080a0f] px-2.5 py-1.5 font-mono text-xs font-bold text-white outline-none focus:border-amber-500"
              />
            </div>
            <div>
              <label htmlFor="accountContractSelect" className="mb-1 block text-[11px] text-slate-400">
                {t.lblContractMode}
              </label>
              <select
                id="accountContractSelect"
                value={riskConfig.contractMode}
                onChange={(e) => handleRiskConfigUpdate({ contractMode: e.target.value as ContractMode })}
                className="w-full rounded-lg border border-[#1e2535] bg-[#080a0f] px-2.5 py-1.5 font-mono text-xs font-bold text-white outline-none focus:border-amber-500"
              >
                <option value="STANDARD">Standard (0.01 = 1x)</option>
                <option value="CENT">Cent (0.01 = 0.01x)</option>
              </select>
            </div>
            <div>
              <label htmlFor="commissionPerLotInput" className="mb-1 block text-[11px] text-slate-400">
                {t.lblCommission}
              </label>
              <input
                id="commissionPerLotInput"
                type="number"
                min={0}
                max={30}
                step={0.5}
                value={riskConfig.commission}
                onChange={(e) => handleRiskConfigUpdate({ commission: Number(e.target.value) })}
                className="w-full rounded-lg border border-[#1e2535] bg-[#080a0f] px-2.5 py-1.5 font-mono text-xs font-bold text-white outline-none focus:border-amber-500"
              />
            </div>
          </div>

          <div className="mt-2.5 grid grid-cols-2 gap-2 font-mono text-[11px] md:grid-cols-5">
            <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5">
              <span className="block text-[10px] text-slate-500">Adaptive Lot</span>
              <strong className="text-amber-400">
                {currentSignal.riskCalc
                  ? currentSignal.riskCalc.valid
                    ? `${currentSignal.riskCalc.lots.toFixed(2)} lots (${(riskScale * 100).toFixed(0)}%)`
                    : `${currentSignal.riskCalc.lots.toFixed(2)} (WARN)`
                  : `Budget $${scaledBudget.toFixed(2)}`}
              </strong>
            </div>
            <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5">
              <span className="block text-[10px] text-slate-500">Budget / Min Risk</span>
              <strong className="text-red-400">
                {currentSignal.riskCalc
                  ? currentSignal.riskCalc.valid
                    ? `$${(currentSignal.riskCalc.actualRiskUsd || 0).toFixed(2)} / $${scaledBudget.toFixed(2)}`
                    : `Min $${(currentSignal.riskCalc.minLotRiskUsd || 0).toFixed(2)} > $${scaledBudget.toFixed(2)}`
                  : `Min ${activeSpec.volumeMin} lot`}
              </strong>
            </div>
            <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5">
              <span className="block text-[10px] text-slate-500">Daily / Streak</span>
              <strong className="text-slate-200">
                {riskLedger.dailyLossPct.toFixed(2)}% / {riskLedger.consecutiveLosses}L
              </strong>
            </div>
            <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5">
              <span className="block text-[10px] text-slate-500">Tracked</span>
              <strong className="text-slate-200">{riskLedger.openPositions} / 1</strong>
            </div>
            <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5">
              <span className="block text-[10px] text-slate-500">Spec</span>
              <strong className={activeSpec.verified ? 'text-emerald-400' : 'text-red-400'}>
                {activeSpec.verified ? activeSpec.specNote : 'UNVERIFIED'}
              </strong>
            </div>
          </div>
        </section>

        {/* Timeframe Selector */}
        <section className="flex flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-[#1e2535] bg-gradient-to-br from-[#161c28] to-[#0d111a] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-400">
              <Clock className="h-3.5 w-3.5" />
              <span>{t.selectTF}</span>
            </span>
            {TIMEFRAME_ORDER.map((tfKey) => (
              <button
                key={tfKey}
                type="button"
                onClick={() => handleChangeTimeframe(tfKey)}
                className={`cursor-pointer rounded-lg border px-2.5 py-1.5 font-mono text-xs font-bold transition-colors active:scale-95 ${
                  currentTF === tfKey
                    ? 'border-amber-500 bg-amber-500/20 text-amber-400'
                    : 'border-[#1e2535] bg-[#080a0f] text-slate-200 hover:border-amber-500'
                }`}
              >
                {tfKey}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2.5 rounded-xl border border-[#1e2535] bg-[#080a0f] px-3 py-1.5">
            <div className="text-right">
              <div className="text-[10px] font-bold text-slate-400">{t.candleClose}</div>
              <div className="text-[11px] text-amber-400">{t.signalRule}</div>
            </div>
            <div className="rounded-lg border border-[#1e2535] bg-[#121620] px-2.5 py-1 font-mono text-lg font-extrabold text-amber-400">
              {candleTimerStr}
            </div>
          </div>
        </section>

        {/* Pre-Market Key-Level Map */}
        <section className="rounded-2xl border border-blue-500/35 bg-gradient-to-br from-[#161c28] to-[#0d111a] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-extrabold text-blue-400">
              <Layers className="h-4 w-4" />
              <span>{t.matrixTitle}</span>
            </span>
            <span className="font-mono text-[10px] text-slate-400">
              {kl.all?.length || 0} zones ({currentTF})
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 font-mono text-[11px] md:grid-cols-4">
            {[
              { lbl: 'R2', val: kl.r2, cls: 'text-red-400' },
              { lbl: 'R1', val: kl.r1, cls: 'text-red-400' },
              { lbl: 'S1', val: kl.s1, cls: 'text-emerald-400' },
              { lbl: 'S2', val: kl.s2, cls: 'text-emerald-400' },
            ].map((item) => (
              <div key={item.lbl} className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5">
                <span className="block text-[10px] text-slate-500">{item.lbl}</span>
                <strong className={item.cls}>{item.val ? `${pxPrefix}${fmtPrice(item.val.price, activeSymbol)}` : '—'}</strong>
                <div className="mt-0.5 text-[10px] text-slate-400">
                  {item.val ? `${item.val.touches}x · ${item.val.tags}` : '—'}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-2.5 grid grid-cols-1 gap-2.5 text-[11px] md:grid-cols-2">
            <div className="rounded-xl border border-red-500/30 bg-[#080a0f] p-2.5">
              <strong className="text-red-400">SCENARIO A (UP → R1):</strong>
              <div className="mt-1 font-mono text-slate-400">
                Reject at {r1Text} → SELL to {s1Text} | Break &amp; Retest &gt; {r1Text} → BUY to {r2Text}
              </div>
            </div>
            <div className="rounded-xl border border-emerald-500/30 bg-[#080a0f] p-2.5">
              <strong className="text-emerald-400">SCENARIO B (DOWN → S1):</strong>
              <div className="mt-1 font-mono text-slate-400">
                Bounce at {s1Text} → BUY to {r1Text} | Break &lt; {s1Text} → SELL to {s2Text}
              </div>
            </div>
          </div>
        </section>

        {/* Main 2-Column Workspace */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Left 2 cols */}
          <div className="flex flex-col gap-4 lg:col-span-2">
            {/* Signal Card */}
            <div
              className={`rounded-2xl border-2 bg-gradient-to-br from-[#161c28] to-[#0d111a] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)] ${cardBorderClass}`}
            >
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className={`inline-block rounded-full px-3.5 py-1 text-[13px] font-extrabold uppercase tracking-wide whitespace-nowrap ${badgeClass}`}>
                      {badgeLabel}
                    </span>
                    {currentSignal.locked && (
                      <span className="inline-flex items-center gap-1 rounded-md border border-blue-500/45 bg-blue-500/15 px-2 py-0.5 font-mono text-[10px] font-bold text-blue-300">
                        <Lock className="h-3 w-3" />
                        <span>LOCKED</span>
                      </span>
                    )}
                    {currentSignal.reversalWarning && (
                      <span className="inline-flex items-center gap-1 rounded-md border border-red-500/45 bg-red-500/15 px-2 py-0.5 font-mono text-[10px] font-bold text-red-400">
                        <AlertTriangle className="h-3 w-3" />
                        <span>REVERSAL PRESSURE</span>
                      </span>
                    )}
                  </div>

                  <div className="mb-1.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-slate-400">
                    <span className="font-bold text-amber-400">{currentSignal.entryMode || currentSignal.state}</span>
                    <span aria-hidden="true">·</span>
                    <span className={activeSpec.desk === 'CRYPTO' ? 'font-bold text-purple-400' : 'text-slate-300'}>
                      {activeSpec.desk === 'CRYPTO' ? 'CRYPTO 24/7' : 'FOREX/GOLD'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-bold text-amber-400">{prof.label}</span>
                  </div>

                  <h2 className="mt-1 flex flex-wrap items-baseline gap-2 text-2xl font-black text-white">
                    <span>{currentSignal.asset}</span>
                    <span className="font-mono text-xs font-normal text-slate-400">
                      {currentSignal.reason} ({currentSignal.time})
                    </span>
                  </h2>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-2">
                  <div className="flex items-center gap-2">
                    {currentSignal.locked && (
                      <button
                        type="button"
                        onClick={handleManualUnlock}
                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-red-800 bg-red-950/70 px-2.5 py-1.5 text-xs font-bold text-red-200 whitespace-nowrap transition-colors hover:border-red-500 active:scale-95"
                      >
                        <LockOpen className="h-3.5 w-3.5" />
                        <span>Close / Unlock</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleCopySignal}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-amber-400 bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-slate-950 whitespace-nowrap transition-colors hover:bg-amber-400 active:scale-95"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      <span>{t.copySignal}</span>
                    </button>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-bold uppercase text-slate-400">{t.winrate}</div>
                    <div className="font-mono text-lg font-extrabold text-amber-400">{currentSignal.setupScore}%</div>
                  </div>
                </div>
              </div>

              {/* 5 Price Level Boxes */}
              <div className="mt-3.5 grid grid-cols-2 gap-2 md:grid-cols-5">
                <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5">
                  <div className="text-[10px] font-bold text-slate-400">{t.entryPrice}</div>
                  <div className="mt-1 font-mono text-[15px] font-extrabold text-white">
                    {Number.isFinite(currentSignal.entry) ? `${pxPrefix}${fmtPrice(currentSignal.entry, activeSymbol)}` : '—'}
                  </div>
                  <div className={`mt-1 font-mono text-[10px] ${livePnl.cls}`}>{livePnl.text}</div>
                </div>

                <div className="rounded-xl border border-emerald-500/35 bg-[#080a0f] p-2.5">
                  <div className="text-[10px] font-bold text-emerald-400">
                    TP 1 ({currentSignal.danger.tp1R}R · BE)
                  </div>
                  <div className="mt-1 font-mono text-[15px] font-extrabold text-emerald-400">
                    {Number.isFinite(currentSignal.tp1) ? `${pxPrefix}${fmtPrice(currentSignal.tp1, activeSymbol)}` : '—'}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-slate-400">
                    {currentSignal.state === 'READY' && currentSignal.entry !== null && currentSignal.tp1 !== null && activeSpec.verified
                      ? `+${(Math.abs(currentSignal.tp1 - currentSignal.entry) / activeSpec.pipSize).toFixed(1)}p`
                      : currentSignal.state}
                  </div>
                </div>

                <div className="rounded-xl border border-emerald-500/35 bg-[#080a0f] p-2.5">
                  <div className="text-[10px] font-bold text-emerald-400">TP 2 ({currentSignal.danger.tp2R}R)</div>
                  <div className="mt-1 font-mono text-[15px] font-extrabold text-emerald-400">
                    {Number.isFinite(currentSignal.tp2) ? `${pxPrefix}${fmtPrice(currentSignal.tp2, activeSymbol)}` : '—'}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-slate-400">
                    {currentSignal.state === 'READY' && currentSignal.entry !== null && currentSignal.tp2 !== null && activeSpec.verified
                      ? `+${(Math.abs(currentSignal.tp2 - currentSignal.entry) / activeSpec.pipSize).toFixed(1)}p`
                      : currentSignal.state}
                  </div>
                </div>

                <div className="rounded-xl border border-emerald-500/35 bg-[#080a0f] p-2.5">
                  <div className="text-[10px] font-bold text-emerald-400">TP 3 (Key Lvl)</div>
                  <div className="mt-1 font-mono text-[15px] font-extrabold text-emerald-400">
                    {Number.isFinite(currentSignal.tp3) ? `${pxPrefix}${fmtPrice(currentSignal.tp3, activeSymbol)}` : '—'}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-slate-400">
                    {currentSignal.state === 'READY' && currentSignal.entry !== null && currentSignal.tp3 !== null && activeSpec.verified
                      ? `+${(Math.abs(currentSignal.tp3 - currentSignal.entry) / activeSpec.pipSize).toFixed(1)}p`
                      : currentSignal.state}
                  </div>
                </div>

                <div className="rounded-xl border border-red-500/35 bg-[#080a0f] p-2.5">
                  <div className="text-[10px] font-bold text-red-400">STOP LOSS</div>
                  <div className="mt-1 font-mono text-[15px] font-extrabold text-red-400">
                    {Number.isFinite(currentSignal.sl) ? `${pxPrefix}${fmtPrice(currentSignal.sl, activeSymbol)}` : '—'}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-slate-400">
                    {currentSignal.state === 'READY' && currentSignal.entry !== null && currentSignal.sl !== null && activeSpec.verified
                      ? `-${(Math.abs(currentSignal.entry - currentSignal.sl) / activeSpec.pipSize).toFixed(1)}p`
                      : currentSignal.state}
                  </div>
                </div>
              </div>

              {currentSignal.watchNote && (
                <div className="mt-2.5 flex items-center justify-between gap-2 rounded-xl border border-blue-500/45 bg-blue-500/15 px-3 py-2 text-[11px] text-blue-200">
                  <span className="font-mono">{currentSignal.watchNote}</span>
                  <span className="font-mono text-[10px] font-bold text-amber-400">Guide</span>
                </div>
              )}

              {/* Metrics Strip */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#1e2535] bg-[#080a0f] px-3 py-2 font-mono text-[11px] text-slate-300">
                <span>
                  Gross R:R:{' '}
                  <strong>
                    {Number.isFinite(currentSignal.grossRR)
                      ? `${currentSignal.grossRR!.toFixed(2)}R/${currentSignal.danger.tp2R}R`
                      : '—'}
                  </strong>
                </span>
                <span>
                  Net R:R:{' '}
                  <strong className="text-amber-400">
                    {Number.isFinite(currentSignal.netRR) ? `${currentSignal.netRR!.toFixed(2)}R` : '—'}
                  </strong>
                </span>
                <span>
                  EMA 8/21:{' '}
                  <strong>
                    {currentSignal.ema8 !== null && currentSignal.ema21 !== null
                      ? `${fmtPrice(currentSignal.ema8, activeSymbol)} / ${fmtPrice(currentSignal.ema21, activeSymbol)}`
                      : '—'}
                  </strong>
                </span>
                <span>
                  MACD Hist:{' '}
                  <strong>
                    {currentSignal.macdHist !== null ? currentSignal.macdHist.toFixed(activeSpec.digits) : '—'}
                  </strong>
                </span>
                <span>
                  RSI(14): <strong>{currentSignal.rsi14 !== null ? currentSignal.rsi14.toFixed(1) : '—'}</strong>
                </span>
                <span>
                  ATR(14):{' '}
                  <strong>{currentSignal.atr14 !== null ? `${pxPrefix}${fmtPrice(currentSignal.atr14, activeSymbol)}` : '—'}</strong>
                </span>
              </div>

              {/* 3 Diagnostics */}
              <div className="mt-2.5 grid grid-cols-1 gap-2 font-mono text-[11px] md:grid-cols-3">
                <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5">
                  <span className="block text-[10px] font-bold text-slate-400">1. DATA &amp; RISK</span>
                  <strong
                    className={
                      isNoTrade
                        ? 'text-red-400'
                        : currentSignal.diagVeto.startsWith('Advisory')
                        ? 'text-amber-400'
                        : 'text-emerald-400'
                    }
                  >
                    {currentSignal.diagVeto}
                  </strong>
                </div>
                <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5">
                  <span className="block text-[10px] font-bold text-slate-400">2. REGIME &amp; BIAS</span>
                  <strong className="text-amber-400">{currentSignal.diagSetup}</strong>
                </div>
                <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5">
                  <span className="block text-[10px] font-bold text-slate-400">3. FAST TRIGGER</span>
                  <strong className="text-slate-200">{currentSignal.diagTrigger}</strong>
                </div>
              </div>

              {/* 8-Rule Checklist */}
              <div className="mt-2.5 grid grid-cols-2 gap-2 font-mono text-[10px] md:grid-cols-4">
                {currentSignal.rules.map((r) => (
                  <div
                    key={r.name}
                    className={`flex flex-col gap-0.5 rounded-xl border bg-[#080a0f] p-2 ${
                      r.pass ? 'border-emerald-500/35 text-emerald-400' : 'border-[#1e2535] text-slate-400'
                    }`}
                  >
                    <div className="font-bold">
                      {r.pass ? '✓' : '·'} {r.name}
                    </div>
                    <div className="text-[10px] text-slate-400">{r.detail}</div>
                  </div>
                ))}
              </div>

              {/* Context Footer */}
              <div className="mt-2.5 grid grid-cols-1 gap-2 border-t border-[#1e2535] pt-2.5 text-[11px] md:grid-cols-3">
                <div className="rounded-xl border border-amber-500/30 bg-[#080a0f] p-2.5">
                  <span className="block font-bold text-slate-400">Momentum / Squeeze:</span>
                  <strong className="font-mono text-amber-400">
                    MACD {currentSignal.macdHist !== null ? (currentSignal.macdHist >= 0 ? 'Bull' : 'Bear') : '—'} |{' '}
                    {currentSignal.regime.squeeze ? 'Squeeze ON' : 'No Squeeze'}
                  </strong>
                </div>
                <div className="rounded-xl border border-blue-500/30 bg-[#080a0f] p-2.5">
                  <span className="block font-bold text-slate-400">Structure / Sweep:</span>
                  <strong className="font-mono text-emerald-400">{currentSignal.structure.label}</strong>
                </div>
                <div className="rounded-xl border border-purple-500/30 bg-[#080a0f] p-2.5">
                  <span className="block font-bold text-slate-400">FVG / OB (Bonus):</span>
                  <strong className="font-mono text-purple-400">
                    {currentSignal.fvg.label} | {currentSignal.ob.label}
                  </strong>
                </div>
              </div>
            </div>

            {/* Interactive SVG Chart */}
            <TradingChart
              symbol={activeSymbol}
              tf={currentTF}
              provider={provider}
              closedBars={chartClosedBars}
              formingBar={chartFormingBar}
              liveQuote={activeQuote}
              freshness={activeFreshness}
              signal={currentSignal}
              layers={chartLayers}
              chartTitle={t.chartTitle}
              errorMsg={chartErrorMsg}
              onToggleLayer={handleToggleLayer}
            />

            {/* Zero-Lookahead Walk-Forward Validation */}
            <section className="rounded-2xl border border-amber-500/40 bg-gradient-to-br from-[#161c28] to-[#0d111a] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
              <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-[#1e2535] pb-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] font-bold text-amber-400">ZERO-LOOKAHEAD WALK-FORWARD</span>
                  <strong className="text-xs text-white">Fast Multi-Strategy Validation</strong>
                </div>
                <span className="font-mono text-[10px] text-slate-400">
                  Latency: {analysisLatencyMs.toFixed(0)}ms · Age: {Number.isFinite(activeFreshness.ageSeconds) ? `${activeFreshness.ageSeconds}s` : '—'}
                </span>
              </div>

              {!walkForwardStats || walkForwardStats.insufficient ? (
                <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5 font-mono text-[11px] text-amber-400">
                  {walkForwardStats?.reason || 'Calculating walk-forward stats…'}
                </div>
              ) : (
                <>
                  <div className="mb-2 grid grid-cols-2 gap-2 font-mono text-[11px] md:grid-cols-5">
                    <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2">
                      <span className="block text-[10px] text-slate-500">Trades / Win Rate</span>
                      <strong className={(walkForwardStats.winRate ?? 0) >= 50 ? 'text-emerald-400' : 'text-amber-400'}>
                        {walkForwardStats.totalTrades} (
                        {walkForwardStats.winRate !== null && walkForwardStats.winRate !== undefined
                          ? `${walkForwardStats.winRate.toFixed(1)}%`
                          : 'N/A'}
                        )
                      </strong>
                    </div>
                    <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2">
                      <span className="block text-[10px] text-slate-500">Profit Factor</span>
                      <strong className={(walkForwardStats.profitFactor ?? 0) >= 1.2 ? 'text-emerald-400' : 'text-amber-400'}>
                        {(walkForwardStats.profitFactor ?? 0).toFixed(2)}
                      </strong>
                    </div>
                    <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2">
                      <span className="block text-[10px] text-slate-500">Net R:R / Expect.</span>
                      <strong className={(walkForwardStats.expectancyR ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                        {(walkForwardStats.netRR ?? 0).toFixed(2)}R / {(walkForwardStats.expectancyR ?? 0) >= 0 ? '+' : ''}
                        {(walkForwardStats.expectancyR ?? 0).toFixed(2)}R
                      </strong>
                    </div>
                    <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2">
                      <span className="block text-[10px] text-slate-500">Max DD / Streak</span>
                      <strong className="text-red-400">
                        -{(walkForwardStats.maxDrawdownR ?? 0).toFixed(1)}R / {walkForwardStats.maxLossStreak ?? 0}L
                      </strong>
                    </div>
                    <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2">
                      <span className="block text-[10px] text-slate-500">Avg W/L / Skipped</span>
                      <strong className="text-slate-200">
                        +{(walkForwardStats.avgWinR ?? 0).toFixed(2)}/-{(walkForwardStats.avgLossR ?? 0).toFixed(2)} |{' '}
                        {walkForwardStats.skippedSetups ?? 0}
                      </strong>
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5 font-mono text-[11px] text-slate-400">
                    {activeSymbol} ({TF_PROFILES[currentTF].label}) · {walkForwardStats.wins}W/{walkForwardStats.losses}L · Zero-lookahead fast
                    Momentum/Squeeze/S-R validation, next-bar open, costs deducted, SL-first. Past stats do not guarantee future returns.
                  </div>
                </>
              )}
            </section>
          </div>

          {/* Right 1 col */}
          <div className="flex flex-col gap-4">
            {/* Signal History */}
            <section className="flex h-[480px] flex-col rounded-2xl border border-[#1e2535] bg-gradient-to-br from-[#161c28] to-[#0d111a] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
              <div className="mb-2 flex items-center justify-between gap-2">
                <strong className="inline-flex items-center gap-1.5 text-[13px] text-white">
                  <ListChecks className="h-4 w-4 text-amber-400" />
                  <span>{t.signalHistory}</span>
                </strong>
                <div className="flex items-center gap-1.5">
                  <select
                    value={historyFilter}
                    onChange={(e) => setHistoryFilter(e.target.value as 'ALL' | 'FOREX' | 'CRYPTO')}
                    className="rounded-lg border border-[#1e2535] bg-[#080a0f] px-2 py-1 font-mono text-[10px] font-bold text-slate-200 outline-none"
                  >
                    <option value="ALL">All</option>
                    <option value="FOREX">Forex/Gold</option>
                    <option value="CRYPTO">Crypto</option>
                  </select>
                  {confirmClearHistory ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setSignalHistoryLog([]);
                          localStorage.removeItem(STORAGE_KEYS.history);
                          setConfirmClearHistory(false);
                          showToast('History cleared');
                        }}
                        className="cursor-pointer rounded-md border border-red-700 bg-red-950 px-2 py-1 text-[10px] font-bold text-red-200"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmClearHistory(false)}
                        className="cursor-pointer rounded-md border border-[#1e2535] bg-[#080a0f] px-2 py-1 text-[10px] font-bold text-slate-300"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmClearHistory(true)}
                      className="cursor-pointer rounded-md border border-[#1e2535] bg-[#080a0f] px-2 py-1 text-[10px] font-bold text-slate-300 hover:border-amber-500"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              <div className="flex flex-grow flex-col gap-2 overflow-y-auto pr-1">
                {filteredHistory.length === 0 ? (
                  <div className="py-10 text-center font-mono text-[11px] text-slate-500">
                    No saved READY setups ({historyFilter}).
                  </div>
                ) : (
                  filteredHistory.map((it, idx) => {
                    const isBuy = it.type === 'BUY';
                    const dk = it.desk || SYMBOL_SPECS[it.asset]?.desk || 'FOREX';
                    return (
                      <div
                        key={`${it.asset}-${it.time}-${idx}`}
                        className="flex items-center justify-between gap-2 rounded-xl border border-[#1e2535] bg-[#080a0f] p-2.5 text-[11px]"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <strong className="text-white">{it.asset}</strong>
                            <span className={`font-mono text-[10px] font-bold ${dk === 'CRYPTO' ? 'text-purple-400' : 'text-amber-400'}`}>
                              {dk}
                            </span>
                            <span className="font-mono text-[10px] text-slate-400">{it.tf}</span>
                            <span className={`font-mono text-[10px] font-bold ${isBuy ? 'text-emerald-400' : 'text-red-400'}`}>
                              {it.type}
                            </span>
                          </div>
                          <div className="mt-1 font-mono text-[10px] text-slate-400">
                            E: {it.entry} | TP1: {it.tp1} | SL: {it.sl}
                          </div>
                        </div>
                        <div className="shrink-0 text-right font-mono text-[10px]">
                          <div className="text-slate-500">
                            {it.date} {it.time}
                          </div>
                          <div className="text-amber-400">{it.status || 'READY'}</div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            {/* 3 Fast Strategies */}
            <section className="rounded-2xl border border-amber-500/30 bg-gradient-to-br from-[#161c28] to-[#0d111a] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
              <div className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase text-amber-400">
                <Zap className="h-3.5 w-3.5" />
                <span>{t.traderTipTitle}</span>
              </div>
              <ul className="flex list-disc flex-col gap-1.5 pl-4 text-xs leading-relaxed text-slate-400">
                <li>
                  <strong className="text-slate-200">{t.rule1Title}</strong> {t.rule1Desc}
                </li>
                <li>
                  <strong className="text-slate-200">{t.rule2Title}</strong> {t.rule2Desc}
                </li>
                <li>
                  <strong className="text-slate-200">{t.rule3Title}</strong> {t.rule3Desc}
                </li>
                <li>
                  <strong className="text-slate-200">{t.rule4Title}</strong> {t.rule4Desc}
                </li>
              </ul>
            </section>
          </div>
        </div>
      </main>

      <footer className="mt-5 border-t border-[#1e2535] bg-[#121620] py-3.5">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2 px-3.5 text-[11px] text-slate-500">
          <span>&copy; 2026 NETHAGA Pro Trading Hub · Fast Multi-Strategy Edition. Not financial advice.</span>
          <span>100% Real BIQUOTE / EXNESS Quotes · Verify broker specs</span>
        </div>
      </footer>

      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 max-w-[90vw] rounded-xl border border-yellow-300 bg-amber-500 px-4 py-2.5 text-xs font-extrabold text-slate-950 shadow-2xl">
          {toastMessage}
        </div>
      )}

      <QaModal
        open={qaModalOpen}
        title={t.modalTitle}
        desc={t.modalDesc}
        logs={qaLogs}
        running={qaRunning}
        onClose={() => setQaModalOpen(false)}
        onRunQa={handleRunQa}
      />
    </div>
  );
}
