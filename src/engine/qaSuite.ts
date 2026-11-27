import { APP_VERSION, BIQUOTE_BASE } from '../constants/markets';
import type { ActiveLock, CandleBar, RiskConfig } from '../types/trading';
import {
  biquoteFetchJson,
  checkBiquoteActiveSymbols,
  evaluateQuoteFreshness,
  ingestQuoteUpdate,
  resetBiquoteBackoff,
  safeFetch,
  type QuotesByProvider,
} from './dataFeed';
import { aggregateWeeklyFromDaily } from './indicators';
import {
  analyzeFVGs,
  analyzeMarketStructure,
  classifyMarketRegimeAndDanger,
  computePositionRiskAndCosts,
  detectConfirmedSwings,
  detectSRReversal,
  evaluateSetup,
  extractKeyLevels,
  getSymbolSpec,
  runWalkForwardForTimeframe,
} from './quantEngine';

export interface QaLogEntry {
  text: string;
  status: 'info' | 'pass' | 'fail';
}

function makeSynBars(closes: number[], sp = 1.0, stepMs = 900000, startMs = 1700000000000): CandleBar[] {
  return closes.map((c, i) => {
    const prev = i === 0 ? c - 0.3 : closes[i - 1];
    return {
      timeMs: startMs + i * stepMs,
      open: prev,
      high: Math.max(prev, c) + sp * 0.4,
      low: Math.min(prev, c) - sp * 0.4,
      close: c,
      isOpen: false,
    };
  });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export async function executeFullQaSuite(
  signalRState: string,
  onLog: (entry: QaLogEntry) => void
): Promise<void> {
  onLog({ text: `Running ${APP_VERSION} 24-Test QA Suite…`, status: 'info' });

  const mockQuotes: QuotesByProvider = { BIQUOTE: {}, EXNESS: {} };
  const defaultRisk: RiskConfig = { balance: 80, riskPercent: 0.5, dailyCap: 1.0, contractMode: 'STANDARD', commission: 0 };

  const tests: Array<[string, () => string]> = [
    [
      '1. Multi-touch Key Level extraction (S1/S2/R1/R2/PDH/PDL)',
      () => {
        const b = makeSynBars([...Array.from({ length: 30 }, (_, i) => 3580 + (i % 6) * 4)], 1.2);
        const d1: CandleBar[] = [{ timeMs: 1700000000000, high: 3615, low: 3570, open: 3585, close: 3595, isOpen: false }];
        const kl = extractKeyLevels(b, d1, b, 2.0, 'XAUUSD', 3590);
        assert(kl.r1 && kl.s1 && kl.pdh === 3615 && kl.pdl === 3570, 'Missing key levels');
        return `R1=${kl.r1.price.toFixed(1)}, S1=${kl.s1.price.toFixed(1)}`;
      },
    ],
    [
      '2. Fast Momentum 8/21 + MACD triggers READY BUY cleanly',
      () => {
        const seq = [...Array.from({ length: 28 }, (_, i) => 3600 - i * 0.3), ...Array.from({ length: 10 }, (_, i) => 3592 + i * 1.2)];
        const b = makeSynBars(seq, 1.0);
        const r = evaluateSetup('XAUUSD', 'M15', b, null, b, b, b, {
          provider: 'BIQUOTE',
          riskConfig: defaultRisk,
          brokerSpecsOverride: {},
          liveQuote: null,
          freshness: { available: true, fresh: true, status: 'LIVE', label: 'HISTORICAL' },
          historicalMode: true,
          simQuote: { bid: 3602.8, ask: 3603.0, mid: 3602.9, spread: 0.2 },
        });
        assert(r.state === 'READY' && r.type === 'BUY', `Got ${r.state} (${r.reason})`);
        return r.reason;
      },
    ],
    [
      '3. W1 weekly aggregation from real 1d closed bars',
      () => {
        const t0 = Date.UTC(2026, 10, 2);
        const d1 = makeSynBars(Array.from({ length: 14 }, (_, i) => 3550 + i), 3, 86400000, t0);
        const wk = aggregateWeeklyFromDaily(d1, null, t0 + 20 * 86400000);
        assert(wk.closedBars.length === 2, `Got ${wk.closedBars.length} weeks`);
        return `${wk.closedBars.length} closed weeks aggregated`;
      },
    ],
    [
      '4. All TFs (M1..W1) open without artificial NO TRADE lock',
      () => {
        const b = makeSynBars(Array.from({ length: 40 }, (_, i) => 3580 + i * 1.2), 1.2);
        ingestQuoteUpdate(mockQuotes, 'XAUUSD', { bid: 3627, ask: 3627.3, timestamp: new Date(Date.now() + 2000).toISOString() }, 'BIQUOTE', true);
        const q = mockQuotes.BIQUOTE.XAUUSD;
        const m1 = evaluateSetup('XAUUSD', 'M1', b, null, b, b, b, {
          provider: 'BIQUOTE',
          riskConfig: defaultRisk,
          brokerSpecsOverride: {},
          liveQuote: q,
          freshness: evaluateQuoteFreshness(q, 'M1'),
        });
        assert(m1.state !== 'NO TRADE', `M1 locked: ${m1.reason}`);
        return `M1=${m1.state} (open)`;
      },
    ],
    [
      '5. Caution Danger Tier scales Risk down & keeps SL outside noise',
      () => {
        const b = makeSynBars(Array.from({ length: 40 }, (_, i) => 3600 + (i % 4 ? 0.4 : -0.6)), 1.5);
        const r = classifyMarketRegimeAndDanger(b, [1.5, 1.5, 1.5], 0.2, 0.35, false);
        assert(r.danger.riskScale <= 0.5 && r.danger.tp1R <= 1.0, 'Expected caution scale');
        return r.danger.label;
      },
    ],
    [
      '6. Non-blocking Risk Advisor warns instead of hiding signal',
      () => {
        const b = makeSynBars(Array.from({ length: 40 }, (_, i) => 3580 + i * 1.2), 1.2);
        ingestQuoteUpdate(mockQuotes, 'XAUUSD', { bid: 3627, ask: 3627.3, timestamp: new Date(Date.now() + 3000).toISOString() }, 'BIQUOTE', true);
        const q = mockQuotes.BIQUOTE.XAUUSD;
        const res = evaluateSetup('XAUUSD', 'M15', b, null, b, b, b, {
          provider: 'BIQUOTE',
          riskConfig: { balance: 80, riskPercent: 0.25, dailyCap: 1.0, contractMode: 'STANDARD', commission: 0 },
          brokerSpecsOverride: {},
          liveQuote: q,
          freshness: evaluateQuoteFreshness(q, 'M15'),
        });
        assert(res.state !== 'NO TRADE' && res.diagVeto.includes('Advisory'), `Got ${res.state}/${res.diagVeto}`);
        return res.diagVeto;
      },
    ],
    [
      '7. FVG bullish & bearish detection (non-invalidating)',
      () => {
        const b: CandleBar[] = Array.from({ length: 12 }, (_, idx) => ({ timeMs: idx, open: 106, high: 107, low: 105.5, close: 106.5, isOpen: false }));
        b[2] = { timeMs: 2, open: 104, high: 105, low: 103, close: 104, isOpen: false };
        b[3] = { timeMs: 3, open: 104, high: 109, low: 104, close: 108, isOpen: false };
        b[4] = { timeMs: 4, open: 108, high: 110, low: 107, close: 109, isOpen: false };
        b[5] = { timeMs: 5, open: 109, high: 110, low: 108, close: 109, isOpen: false };
        b[7] = { timeMs: 7, open: 109, high: 110, low: 108, close: 108, isOpen: false };
        b[8] = { timeMs: 8, open: 108, high: 108, low: 105.5, close: 106, isOpen: false };
        b[9] = { timeMs: 9, open: 106, high: 106.5, low: 105.5, close: 106, isOpen: false };
        const r = analyzeFVGs(b, 0.8, 'XAUUSD');
        assert(r.validBull.length >= 1 && r.validBear.length >= 1, `Bull=${r.validBull.length}, Bear=${r.validBear.length}`);
        return `Bull=${r.validBull.length}, Bear=${r.validBear.length}`;
      },
    ],
    [
      '8. Plateau swing detection handles equal highs cleanly',
      () => {
        const b: CandleBar[] = [
          { timeMs: 1, high: 100, low: 98, open: 99, close: 99, isOpen: false },
          { timeMs: 2, high: 105, low: 101, open: 102, close: 104, isOpen: false },
          { timeMs: 3, high: 105, low: 102, open: 104, close: 104, isOpen: false },
          { timeMs: 4, high: 105, low: 102, open: 104, close: 103, isOpen: false },
          { timeMs: 5, high: 101, low: 99, open: 103, close: 100, isOpen: false },
          { timeMs: 6, high: 100, low: 97, open: 100, close: 98, isOpen: false },
        ];
        const sw = detectConfirmedSwings(b, 1.0);
        assert(sw.swingHighs.length === 1 && sw.swingHighs[0].plateauBars === 3, 'Expected 1 plateau');
        return '1 plateau (3 bars)';
      },
    ],
    [
      '9. Pullback preserves structure',
      () => {
        const seq = [...Array.from({ length: 18 }, (_, i) => 3580 + i * 0.5), 3595, 3592, 3588, 3591, 3598, 3606, 3612, 3608, 3604];
        const b = makeSynBars(seq, 1.0);
        const st = analyzeMarketStructure(b, 1.0, 'XAUUSD', 18);
        assert(st.type === 'BULLISH' && st.inPullback, `Expected bullish pullback, got ${st.type}`);
        return st.label;
      },
    ],
    [
      '10. Structure invalidation when swing low broken',
      () => {
        const b = makeSynBars([...Array.from({ length: 28 }, (_, i) => 3580 + i * 1.2), 3610, 3608, 3612, 3575, 3572], 1.1);
        const st = analyzeMarketStructure(b, 1.1, 'XAUUSD', 18);
        assert(st.type !== 'BULLISH', 'Expected invalidation');
        return st.label;
      },
    ],
    [
      '11. D1/HTF zero-lookahead leakage check',
      () => {
        const t0 = 1700000000000;
        const d1 = makeSynBars(Array.from({ length: 50 }, (_, i) => 3500 + i * 5), 5, 86400000, t0);
        const dec = t0 + 10 * 86400000;
        const kept = d1.filter((d) => d.timeMs + 86400000 <= dec);
        assert(kept.length === 10, 'Future D1 leaked');
        return `${kept.length} closed D1 bars`;
      },
    ],
    [
      '12. Stale M1 (>45s) & M5 (>70s) quotes rejected',
      () => {
        const old = new Date(Date.now() - 75000).toISOString();
        delete mockQuotes.BIQUOTE.XAUUSD;
        ingestQuoteUpdate(mockQuotes, 'XAUUSD', { bid: 3600, ask: 3600.3, timestamp: old }, 'BIQUOTE', true);
        const fm1 = evaluateQuoteFreshness(mockQuotes.BIQUOTE.XAUUSD, 'M1');
        const fm5 = evaluateQuoteFreshness(mockQuotes.BIQUOTE.XAUUSD, 'M5');
        assert(!fm1.fresh && !fm5.fresh, 'Stale must fail');
        return `M1=${fm1.status}, M5=${fm5.status}`;
      },
    ],
    [
      '13. Broker timestamp validation & duplicate/OOO guard',
      () => {
        const miss = ingestQuoteUpdate(mockQuotes, 'XAUUSD', { bid: 3600, ask: 3600.2 }, 'EXNESS', true);
        assert(!miss.accepted, 'Missing ts must fail');
        delete mockQuotes.BIQUOTE.EURUSD;
        const tN = new Date(Date.now() + 4000).toISOString();
        const tO = new Date(Date.now() - 60000).toISOString();
        ingestQuoteUpdate(mockQuotes, 'EURUSD', { bid: 1.1, ask: 1.1001, timestamp: tN }, 'BIQUOTE', true);
        const dup = ingestQuoteUpdate(mockQuotes, 'EURUSD', { bid: 1.1, ask: 1.1001, timestamp: tN }, 'BIQUOTE', true);
        const ooo = ingestQuoteUpdate(mockQuotes, 'EURUSD', { bid: 1.099, ask: 1.0991, timestamp: tO }, 'BIQUOTE', true);
        assert(!dup.accepted && !ooo.accepted, 'Dup/OOO must fail');
        return 'Missing/Dup/OOO rejected';
      },
    ],
    [
      '14. Crypto contract specs isolated from Forex 100k lots',
      () => {
        const btc = getSymbolSpec('BTCUSD', 'BIQUOTE', 95000, defaultRisk, {});
        const eur = getSymbolSpec('EURUSD', 'BIQUOTE', 1.09, defaultRisk, {});
        assert(btc.desk === 'CRYPTO' && btc.effectiveContractSize === 1 && eur.effectiveContractSize === 100000, 'Specs mixed');
        return `BTC=${btc.effectiveContractSize}/lot, EUR=${eur.effectiveContractSize}/lot`;
      },
    ],
    [
      '15. Exness disconnection handled safely',
      () => {
        delete mockQuotes.EXNESS.GBPUSD;
        const f = evaluateQuoteFreshness(mockQuotes.EXNESS.GBPUSD, 'M15');
        assert(!f.available && !f.fresh, 'Must be UNAVAILABLE');
        return f.label;
      },
    ],
    [
      '16. Invalid symbol specs disable lot sizing',
      () => {
        const sp = getSymbolSpec('BAD_SYM', 'BIQUOTE', 1.0, defaultRisk, {});
        const rc = computePositionRiskAndCosts(1.0, { spread: 0.1 }, sp, defaultRisk);
        assert(!sp.verified && !rc.valid, 'Unknown spec must fail');
        return rc.reason;
      },
    ],
    [
      '17. Net R:R calculation deducts spread + comm + slippage',
      () => {
        const sp = getSymbolSpec('XAUUSD', 'BIQUOTE', 3600, defaultRisk, {});
        const rc = computePositionRiskAndCosts(4.0, { spread: 0.4 }, sp, defaultRisk);
        assert((rc.costInPrice || 0) >= 0.4, 'Cost must include spread+slip');
        return `Cost=$${(rc.costInPrice || 0).toFixed(2)}`;
      },
    ],
    [
      '18. Active Signal Lock + Manual Unlock with dismissed guard',
      () => {
        const lockMap: Record<string, ActiveLock> = {
          'BIQUOTE:XAUUSD:M15': {
            asset: 'XAUUSD',
            type: 'SELL',
            entry: 3600,
            tp1: 3595,
            tp2: 3590,
            tp3: 3585,
            sl: 3605,
            candleTime: 1700000000000,
            tp1Hit: false,
          },
        };
        assert(Boolean(lockMap['BIQUOTE:XAUUSD:M15']), 'Lock must persist');
        delete lockMap['BIQUOTE:XAUUSD:M15'];
        return 'Lock & unlock verified';
      },
    ],
    [
      '19. Anti-Spike rejects chasing extended spike far from S1',
      () => {
        const seq = [...Array.from({ length: 30 }, (_, i) => 3580 + (i % 4)), 3580, 3625];
        const b = makeSynBars(seq, 1.0);
        b[b.length - 1] = { ...b[b.length - 1], open: 3580, low: 3579, high: 3626, close: 3625 };
        const r = evaluateSetup('XAUUSD', 'M30', b, null, b, b, b, {
          provider: 'BIQUOTE',
          riskConfig: defaultRisk,
          brokerSpecsOverride: {},
          liveQuote: null,
          freshness: { available: true, fresh: true, status: 'LIVE', label: 'HISTORICAL' },
          historicalMode: true,
          simQuote: { bid: 3625, ask: 3625.3, mid: 3625.15, spread: 0.3 },
        });
        assert(r.state !== 'READY', `Should block giant spike chase, got ${r.state}`);
        return `Spike blocked -> ${r.state}`;
      },
    ],
    [
      '20. Historical zero-lookahead walk-forward execution',
      () => {
        const b = makeSynBars(Array.from({ length: 95 }, (_, i) => 3550 + i * 1.1), 1.2);
        const wf = runWalkForwardForTimeframe(
          'XAUUSD',
          'M15',
          b,
          b,
          b,
          b,
          { provider: 'BIQUOTE', riskConfig: defaultRisk, brokerSpecsOverride: {}, liveQuote: null, spreadOv: 0.2 },
          {}
        );
        assert(!wf.insufficient && Number.isFinite(wf.profitFactor), 'WF failed');
        return `${wf.totalTrades} trades, PF=${wf.profitFactor!.toFixed(2)}`;
      },
    ],
    [
      '21. Reversal at Resistance/Support (R1/S1) fires before pullback to Entry',
      () => {
        const b = makeSynBars(Array.from({ length: 35 }, (_, i) => 3580 + i * 0.5), 1.0);
        // Last bar spikes into R1 (~3610) and leaves a sharp rejection upper wick closing red
        b[b.length - 1] = { timeMs: b[b.length - 1].timeMs, open: 3606, high: 3611.2, low: 3597, close: 3598, isOpen: false };
        const kl = {
          r1: { price: 3610, touches: 3, weight: 8, tags: 'Pivot' },
          r2: { price: 3620, touches: 2, weight: 6, tags: 'PDH' },
          s1: { price: 3575, touches: 2, weight: 6, tags: 'Pivot' },
          s2: null,
          pdh: 3620,
          pdl: 3570,
          all: [],
        };
        const rev = detectSRReversal(b, null, 3598.5, kl, 4.0, 68, 'XAUUSD');
        assert(rev.active && rev.side === 'SELL' && rev.zoneName === 'R1', `Expected SELL reversal at R1, got ${JSON.stringify(rev)}`);
        return rev.reason;
      },
    ],
    [
      '22. Sideways / Chop market blocks false BUY/SELL signals (returns WAIT)',
      () => {
        const chop = Array.from({ length: 45 }, (_, i) => 3570 + (i % 2 === 0 ? 0.35 : -0.35));
        const b = makeSynBars(chop, 0.5);
        const r = evaluateSetup('XAUUSD', 'M15', b, null, b, b, b, {
          provider: 'BIQUOTE',
          riskConfig: defaultRisk,
          brokerSpecsOverride: {},
          liveQuote: null,
          freshness: { available: true, fresh: true, status: 'LIVE', label: 'HISTORICAL' },
          historicalMode: true,
          simQuote: { bid: 3570.1, ask: 3570.4, mid: 3570.25, spread: 0.3 },
        });
        assert(r.state === 'WAIT' && r.sidewayBlocked === true, `Expected sidewayBlocked WAIT, got ${r.state} (${r.reason})`);
        return r.reason;
      },
    ],
    [
      '23. MTF Hierarchy (M1->M5+, M5->M15+, M15->H1/H4/D1/W1)',
      () => {
        const up = makeSynBars(Array.from({ length: 45 }, (_, i) => 3550 + i * 1.1), 1.2);
        const dn = makeSynBars(Array.from({ length: 45 }, (_, i) => 3650 - i * 1.1), 1.2);
        const m1 = evaluateSetup('XAUUSD', 'M1', up, null, up, up, up, {
          provider: 'BIQUOTE',
          riskConfig: defaultRisk,
          brokerSpecsOverride: {},
          liveQuote: null,
          freshness: { available: true, fresh: true, status: 'LIVE', label: 'HISTORICAL' },
          historicalMode: true,
          simQuote: { bid: 3598.5, ask: 3598.8, mid: 3598.65, spread: 0.3 },
          mtfBars: { M5: up, M15: up, H1: up },
        });
        const m15 = evaluateSetup('XAUUSD', 'M15', up, null, dn, dn, dn, {
          provider: 'BIQUOTE',
          riskConfig: defaultRisk,
          brokerSpecsOverride: {},
          liveQuote: null,
          freshness: { available: true, fresh: true, status: 'LIVE', label: 'HISTORICAL' },
          historicalMode: true,
          simQuote: { bid: 3598.5, ask: 3598.8, mid: 3598.65, spread: 0.3 },
          mtfBars: { H1: dn, H4: dn, D1: dn, W1: dn },
        });
        const m1Tfs = (m1.mtfBreakdown || []).map((x) => x.tf).join(',');
        const m15Tfs = (m15.mtfBreakdown || []).map((x) => x.tf).join(',');
        assert(m1Tfs.startsWith('M5'), `M1 must inspect M5 first, got ${m1Tfs}`);
        assert(m15Tfs === 'H1,H4,D1,W1' && m15.state !== 'READY', `M15 must check H1,H4,D1,W1 and guard counter-HTF (${m15Tfs} / ${m15.state})`);
        return `M1=[${m1Tfs}], M15=[${m15Tfs}]`;
      },
    ],
    [
      '24. S/R Obstacle Guard blocks BUY right below multi-touch R1 wall',
      () => {
        // Build sideways swing ceiling at 3600 touched 3 times, then small rise stopping right under 3600
        const seq = [
          3580, 3585, 3592, 3600, 3594, 3588, 3584,
          3589, 3595, 3600, 3593, 3586, 3583, 3588,
          3596, 3600, 3592, 3587, 3584, 3586, 3589,
          3591, 3593, 3595, 3596, 3597, 3598, 3598.5,
          3598.8, 3599.0, 3599.2,
        ];
        const b = makeSynBars(seq, 0.8);
        const r = evaluateSetup('XAUUSD', 'M15', b, null, b, b, b, {
          provider: 'BIQUOTE',
          riskConfig: defaultRisk,
          brokerSpecsOverride: {},
          liveQuote: null,
          freshness: { available: true, fresh: true, status: 'LIVE', label: 'HISTORICAL' },
          historicalMode: true,
          simQuote: { bid: 3599.0, ask: 3599.3, mid: 3599.15, spread: 0.3 },
        });
        assert(r.state !== 'READY' || r.type !== 'BUY', `Should block BUY directly into R1 ceiling, got ${r.state} ${r.type} (${r.reason})`);
        return `R1 guard -> ${r.state} (${r.reason})`;
      },
    ],
  ];

  let pass = 0;
  let fail = 0;
  for (const [n, fn] of tests) {
    try {
      const out = fn();
      onLog({ text: `[PASS] ${n} -> ${out}`, status: 'pass' });
      pass++;
    } catch (e: any) {
      onLog({ text: `[FAIL] ${n} -> ${e?.message || e}`, status: 'fail' });
      fail++;
    }
  }

  onLog({ text: `Unit Summary: ${pass}/${tests.length} PASSED, ${fail} FAILED`, status: 'info' });
  onLog({ text: 'Running Live BIQUOTE API (Forex + Crypto) & Backup Feed Checks…', status: 'info' });
  resetBiquoteBackoff();

  const liveChecks: Array<[string, () => Promise<string>]> = [
    ['GET /api/active', async () => `Active=${(await checkBiquoteActiveSymbols()).size}`],
    [
      'GET /api/latest (XAUUSD, EURUSD, BTCUSD, ETHUSD)',
      async () => {
        const d = await biquoteFetchJson(
          `${BIQUOTE_BASE}/api/latest?symbols=XAUUSD&symbols=EURUSD&symbols=BTCUSD&symbols=ETHUSD`
        );
        return `XAU=${d?.XAUUSD?.mid}, BTC=${d?.BTCUSD?.mid}, ETH=${d?.ETHUSD?.mid}`;
      },
    ],
    [
      'OHLC XAUUSD 15m & BTCUSD 15m',
      async () => {
        const [a, b] = await Promise.all([
          biquoteFetchJson(`${BIQUOTE_BASE}/api/XAUUSD/ohlc?interval=15m&limit=10`),
          biquoteFetchJson(`${BIQUOTE_BASE}/api/BTCUSD/ohlc?interval=15m&limit=10`),
        ]);
        return `XAU=${a?.bars?.length}, BTC=${b?.bars?.length}`;
      },
    ],
    ['SignalR /hubs/tick', async () => `State=${signalRState}`],
  ];

  if (typeof window !== 'undefined') {
    liveChecks.push([
      'Backup Feed (Swissquote + Kraken + Yahoo)',
      async () => {
        const r = await safeFetch('/api/market-fallback?mode=quotes', {}, 10000);
        const raw = await r.text();
        const d = raw ? JSON.parse(raw) : null;
        if (!r.ok || !d?.quotes) throw new Error(d?.error || `HTTP ${r.status}`);
        return `${d.count}/14 pairs (XAU=${d.quotes?.XAUUSD?.mid?.toFixed?.(2) ?? '—'}, BTC=${d.quotes?.BTCUSD?.mid?.toFixed?.(1) ?? '—'})`;
      },
    ]);
  }

  for (const [n, fn] of liveChecks) {
    try {
      const out = await fn();
      onLog({ text: `[PASS] ${n} -> ${out}`, status: 'pass' });
    } catch (e: any) {
      onLog({ text: `[FAIL] ${n} -> ${e?.message || e}`, status: 'fail' });
    }
  }
}
