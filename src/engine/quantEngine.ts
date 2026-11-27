import { SYMBOL_SPECS, TF_PROFILES } from '../constants/markets';
import type {
  BlockZone,
  CandleBar,
  ComputedSymbolSpec,
  DangerInfo,
  FVGAnalysis,
  FVGZone,
  KeyLevelPoint,
  KeyLevels,
  MarketStructure,
  MtfSnapshot,
  ProviderType,
  QuoteData,
  RegimeInfo,
  RiskCalcResult,
  RiskConfig,
  SignalOutput,
  SRReversalInfo,
  SymbolSpec,
  TimeframeKey,
  WalkForwardStats,
} from '../types/trading';
import {
  calculateADX,
  calculateATRSeries,
  calculateEfficiencyRatio,
  calculateEMASeries,
  calculateMACD,
  calculateRSI,
  calculateSqueezeAndBands,
  fmtPrice,
} from './indicators';

export type BrokerSpecOverrideMap = Record<string, Partial<SymbolSpec>>;

export function getSymbolSpec(
  sym: string,
  prov: ProviderType,
  midOv: number | null | undefined,
  riskConfig: RiskConfig,
  brokerSpecsOverride: BrokerSpecOverrideMap,
  liveQuoteMid?: number | null
): ComputedSymbolSpec {
  const b = SYMBOL_SPECS[sym];
  if (!b) {
    return {
      verified: false,
      reason: `Unknown ${sym}`,
      digits: 2,
      pointSize: 0.01,
      pipSize: 0.1,
      tickSize: 0.01,
      volumeMin: 0.01,
      volumeStep: 0.01,
      slippagePoints: 10,
      desk: 'FOREX',
      group: 'FX',
      specNote: 'UNVERIFIED',
    };
  }
  const br = prov === 'EXNESS' ? brokerSpecsOverride[sym] : null;
  const m: SymbolSpec = br ? { ...b, ...br } : { ...b };
  const mult = riskConfig.contractMode === 'CENT' ? 0.01 : 1.0;
  const effC = m.contractSize * mult;

  if (
    !m.verified ||
    ![m.digits, m.pointSize, m.pipSize, m.tickSize, effC, m.volumeMin, m.volumeStep].every(
      (v) => Number.isFinite(v) && v > 0
    )
  ) {
    return { ...m, verified: false, reason: 'Invalid spec' };
  }

  const refM = Number.isFinite(midOv) && (midOv as number) > 0 ? (midOv as number) : liveQuoteMid ?? null;
  let tv = m.tickValueUsd;
  if (!Number.isFinite(tv) || (tv as number) <= 0) {
    if (m.quoteCcy === 'USD') {
      tv = effC * m.tickSize;
    } else {
      if (!(refM && refM > 0)) {
        return { ...m, effectiveContractSize: effC, verified: false, reason: `Need ${sym} rate` };
      }
      tv = (effC * m.tickSize) / refM;
    }
  } else {
    tv = (tv as number) * mult;
  }

  return {
    ...m,
    contractMultiplier: mult,
    effectiveContractSize: effC,
    tickValueUsd: tv,
    commissionPerLotUsd: Math.max(0, Number(riskConfig.commission ?? 0)) * mult,
    verified: true,
  };
}

export function computePositionRiskAndCosts(
  slDist: number,
  quote: { spread?: number } | null,
  spec: ComputedSymbolSpec,
  riskConfig: RiskConfig,
  riskScale = 1.0
): RiskCalcResult {
  if (!spec || !spec.verified || !spec.tickValueUsd) {
    return { valid: false, lots: spec?.volumeMin || 0.01, reason: spec?.reason || 'UNVERIFIED spec' };
  }
  if (!(slDist > 0) || !Number.isFinite(slDist)) {
    return { valid: false, lots: spec.volumeMin, reason: 'Invalid SL' };
  }
  const eq = Math.max(5, Number(riskConfig.balance || 80));
  const rp = Math.max(0.1, Math.min(5.0, Number(riskConfig.riskPercent || 0.5)));
  const scaledBudget = eq * (rp / 100) * riskScale;
  const slTicks = slDist / spec.tickSize;
  const loss1 = slTicks * spec.tickValueUsd;
  const comm1 = spec.commissionPerLotUsd || 0;
  const slipPx = spec.slippagePoints * spec.pointSize * 2;
  const slip1 = (slipPx / spec.tickSize) * spec.tickValueUsd;
  const tot1 = loss1 + comm1 + slip1;
  const minRisk = tot1 * spec.volumeMin;
  const costInPrice = (quote?.spread || 0) + slipPx + comm1 / (spec.tickValueUsd / spec.tickSize);

  if (minRisk > scaledBudget) {
    return {
      valid: false,
      minLotExceeds: true,
      riskBudgetUsd: scaledBudget,
      minLotRiskUsd: minRisk,
      lots: spec.volumeMin,
      actualRiskUsd: minRisk,
      costInPrice,
      reason: `0.01 lot risks $${minRisk.toFixed(2)} > $${scaledBudget.toFixed(2)}`,
    };
  }
  const lots = Number(
    Math.max(spec.volumeMin, Math.floor(scaledBudget / tot1 / spec.volumeStep) * spec.volumeStep).toFixed(2)
  );
  return {
    valid: true,
    minLotExceeds: false,
    riskBudgetUsd: scaledBudget,
    minLotRiskUsd: minRisk,
    lots,
    actualRiskUsd: lots * tot1,
    costInPrice,
    reason: `Lot ${lots.toFixed(2)} risks $${(lots * tot1).toFixed(2)}`,
  };
}

export function classifyMarketRegimeAndDanger(
  bars: CandleBar[],
  atrS: number[],
  spread: number,
  maxSpreadRatio: number,
  squeezeOn: boolean
): { regime: RegimeInfo; danger: DangerInfo } {
  const a14 = atrS.length ? atrS[atrS.length - 1] : 0;
  const a50 = atrS.length >= 20 ? atrS.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, atrS.length) : a14;
  const atrR = a50 > 0 ? a14 / a50 : 1;
  const adx = calculateADX(bars, 14) ?? 20;
  const er = calculateEfficiencyRatio(bars, 12);

  let regime = 'RANGING';
  if (atrR >= 1.65) regime = 'HIGH_VOL';
  else if (squeezeOn) regime = 'SQUEEZE';
  else if (adx >= 18 || er >= 0.24) regime = 'TRENDING';
  else if (atrR <= 0.50 && adx < 16) regime = 'LOW_VOL';

  let dangerPct = 15;
  if (adx < 16) dangerPct += 15;
  if (er < 0.16) dangerPct += 12;
  if (atrR >= 1.65 || atrR <= 0.50) dangerPct += 15;
  if (a14 > 0 && spread > a14 * maxSpreadRatio) dangerPct += 20;
  dangerPct = Math.min(95, dangerPct);

  let tier: DangerInfo['tier'] = 'CLEAN';
  let riskScale = 1.0;
  let tp1R = 0.90;
  let tp2R = 1.65;
  if (dangerPct >= 50) {
    tier = 'HIGH DANGER';
    riskScale = 0.35;
    tp1R = 0.80;
    tp2R = 1.35;
  } else if (dangerPct >= 25) {
    tier = 'CAUTION';
    riskScale = 0.50;
    tp1R = 0.85;
    tp2R = 1.50;
  }

  return {
    regime: {
      regime,
      adx,
      atrRatio: atrR,
      er,
      squeeze: squeezeOn,
      label: `${regime} (ADX ${adx.toFixed(1)}, ATRx ${atrR.toFixed(2)})`,
    },
    danger: {
      tier,
      pct: dangerPct,
      riskScale,
      tp1R,
      tp2R,
      label: `${tier} (${dangerPct}%)`,
    },
  };
}

export function detectConfirmedSwings(c: CandleBar[], atr = 0) {
  const swingHighs: Array<{ index: number; price: number; plateauBars: number }> = [];
  const swingLows: Array<{ index: number; price: number; plateauBars: number }> = [];
  const n = c.length;
  if (n < 5) return { swingHighs, swingLows, eqHigh: null as number | null, eqLow: null as number | null };

  const eps = Math.max(1e-9, (atr || 0) * 0.01);
  let i = 1;
  while (i < n - 1) {
    const h = c[i].high;
    let end = i;
    while (end + 1 < n - 1 && Math.abs(c[end + 1].high - h) <= eps) end++;
    if (h > c[i - 1].high + eps && (i < 2 || h >= c[i - 2].high - eps) && end + 1 < n && h > c[end + 1].high + eps) {
      swingHighs.push({
        index: end,
        price: Math.max(...c.slice(i, end + 1).map((x) => x.high)),
        plateauBars: end - i + 1,
      });
    }
    i = end + 1;
  }

  let j = 1;
  while (j < n - 1) {
    const l = c[j].low;
    let end = j;
    while (end + 1 < n - 1 && Math.abs(c[end + 1].low - l) <= eps) end++;
    if (l < c[j - 1].low - eps && (j < 2 || l <= c[j - 2].low + eps) && end + 1 < n && l < c[end + 1].low - eps) {
      swingLows.push({
        index: end,
        price: Math.min(...c.slice(j, end + 1).map((x) => x.low)),
        plateauBars: end - j + 1,
      });
    }
    j = end + 1;
  }

  const eqT = Math.max(1e-9, (atr || 0) * 0.15);
  let eqHigh: number | null = null;
  let eqLow: number | null = null;
  for (let a = swingHighs.length - 1; a >= 1; a--) {
    if (swingHighs[a].index - swingHighs[a - 1].index >= 2 && Math.abs(swingHighs[a].price - swingHighs[a - 1].price) <= eqT) {
      eqHigh = (swingHighs[a].price + swingHighs[a - 1].price) / 2;
      break;
    }
  }
  for (let a = swingLows.length - 1; a >= 1; a--) {
    if (swingLows[a].index - swingLows[a - 1].index >= 2 && Math.abs(swingLows[a].price - swingLows[a - 1].price) <= eqT) {
      eqLow = (swingLows[a].price + swingLows[a - 1].price) / 2;
      break;
    }
  }
  return { swingHighs, swingLows, eqHigh, eqLow };
}

export function extractKeyLevels(
  closedBars: CandleBar[],
  d1Bars: CandleBar[] | null,
  h1Bars: CandleBar[] | null,
  atr: number,
  sym: string,
  refPrice: number,
  h4Bars: CandleBar[] | null = null
): KeyLevels {
  const spec = SYMBOL_SPECS[sym] || { roundStep: 10 };
  const bars = closedBars.slice(-140);
  const tol = Math.max(refPrice * 0.0009, (atr || refPrice * 0.002) * 0.40);
  const minGap = Math.max(tol * 1.4, refPrice * 0.0008);

  type RawCand = { price: number; side: 'R' | 'S' | 'BOTH'; tag: string; weight: number };
  const rawLevels: RawCand[] = [];
  const add = (price: number | null | undefined, side: 'R' | 'S' | 'BOTH', tag: string, weight: number) => {
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
      rawLevels.push({ price, side, tag, weight });
    }
  };

  // 1. Confirmed 3-bar left/right fractal pivots on current timeframe (true structural peaks/valleys)
  for (let i = 3; i < bars.length - 3; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    const isPeak =
      h >= bars[i - 1].high && h >= bars[i - 2].high && h > bars[i - 3].high &&
      h >= bars[i + 1].high && h >= bars[i + 2].high && h > bars[i + 3].high;
    const isTrough =
      l <= bars[i - 1].low && l <= bars[i - 2].low && l < bars[i - 3].low &&
      l <= bars[i + 1].low && l <= bars[i + 2].low && l < bars[i + 3].low;
    if (isPeak) add(h, h > refPrice ? 'R' : 'S', 'Pivot', 3);
    if (isTrough) add(l, l < refPrice ? 'S' : 'R', 'Pivot', 3);
  }

  // Fallback to 1-bar confirmed swings if bars are short or sawtooth (e.g. unit test fixtures)
  const { swingHighs, swingLows, eqHigh, eqLow } = detectConfirmedSwings(bars, atr);
  swingHighs.slice(-8).forEach((s) => add(s.price, s.price > refPrice ? 'R' : 'S', 'Swing', 2));
  swingLows.slice(-8).forEach((s) => add(s.price, s.price < refPrice ? 'S' : 'R', 'Swing', 2));
  if (eqHigh) add(eqHigh, eqHigh > refPrice ? 'R' : 'S', 'EQH', 4);
  if (eqLow) add(eqLow, eqLow < refPrice ? 'S' : 'R', 'EQL', 4);

  // 2. Previous Day High / Low (major institutional liquidity magnets)
  let pdh: number | null = null;
  let pdl: number | null = null;
  if (d1Bars && d1Bars.length >= 1) {
    const prevD = d1Bars[d1Bars.length - 1];
    pdh = prevD.high;
    pdl = prevD.low;
    add(pdh, pdh >= refPrice ? 'R' : 'S', 'PDH', 5);
    add(pdl, pdl <= refPrice ? 'S' : 'R', 'PDL', 5);
  }

  // 3. H1 & H4 Major Fractal Swings
  if (h1Bars && h1Bars.length >= 20) {
    const hSw = detectConfirmedSwings(h1Bars.slice(-80), atr);
    hSw.swingHighs.slice(-6).forEach((s) => add(s.price, s.price > refPrice ? 'R' : 'S', 'H1', 4));
    hSw.swingLows.slice(-6).forEach((s) => add(s.price, s.price < refPrice ? 'S' : 'R', 'H1', 4));
  }
  if (h4Bars && h4Bars.length >= 16) {
    const h4Sw = detectConfirmedSwings(h4Bars.slice(-60), atr);
    h4Sw.swingHighs.slice(-4).forEach((s) => add(s.price, s.price > refPrice ? 'R' : 'S', 'H4', 4.5));
    h4Sw.swingLows.slice(-4).forEach((s) => add(s.price, s.price < refPrice ? 'S' : 'R', 'H4', 4.5));
  }

  // Cluster WITHOUT diluting exact structural anchor price by round numbers
  const clusters: Array<{ price: number; anchorWeight: number; touches: number; weight: number; tags: Set<string>; side: 'R' | 'S' | 'BOTH' }> = [];
  for (const lvl of rawLevels.sort((a, b) => b.weight - a.weight)) {
    const match = clusters.find((c) => Math.abs(c.price - lvl.price) <= tol);
    if (match) {
      match.weight += lvl.weight;
      match.tags.add(lvl.tag);
      if (lvl.weight > match.anchorWeight) {
        match.price = lvl.price;
        match.anchorWeight = lvl.weight;
      }
      if (match.side !== lvl.side) match.side = 'BOTH';
    } else {
      clusters.push({
        price: lvl.price,
        anchorWeight: lvl.weight,
        touches: 0,
        weight: lvl.weight,
        tags: new Set([lvl.tag]),
        side: lvl.side,
      });
    }
  }

  // Count real historical bar reaction touches near each cluster
  const touchTol = Math.max(tol * 0.65, refPrice * 0.0004);
  for (const c of clusters) {
    let reactions = 0;
    let lastTouchIdx = -3;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const testedHigh = Math.abs(b.high - c.price) <= touchTol;
      const testedLow = Math.abs(b.low - c.price) <= touchTol;
      if ((testedHigh || testedLow) && i - lastTouchIdx >= 2) {
        reactions++;
        lastTouchIdx = i;
      }
    }
    c.touches = Math.max(1, reactions);
    c.weight += Math.min(6, reactions);
  }

  // Add psychological round numbers ONLY if structural levels above/below are sparse
  const aboveStruct = clusters.filter((c) => c.price > refPrice + minGap * 0.25);
  const belowStruct = clusters.filter((c) => c.price < refPrice - minGap * 0.25);
  if (aboveStruct.length < 2 || belowStruct.length < 2) {
    const step = spec.roundStep || 10;
    const baseR = Math.round(refPrice / step) * step;
    [-2, -1, 1, 2].forEach((k) => {
      const p = baseR + k * step;
      if (!clusters.some((c) => Math.abs(c.price - p) <= tol)) {
        clusters.push({
          price: p,
          anchorWeight: 1,
          touches: 1,
          weight: 1,
          tags: new Set(['Round']),
          side: p > refPrice ? 'R' : 'S',
        });
      }
    });
  }

  const above = clusters
    .filter((c) => {
      const isStructural = c.touches >= 2 || !c.tags.has('Round');
      return c.price > refPrice + (isStructural ? atr * 0.05 : minGap * 0.20);
    })
    .sort((a, b) => a.price - b.price);
  const below = clusters
    .filter((c) => {
      const isStructural = c.touches >= 2 || !c.tags.has('Round');
      return c.price < refPrice - (isStructural ? atr * 0.05 : minGap * 0.20);
    })
    .sort((a, b) => b.price - a.price);

  const r1 = above[0] || null;
  const r2 = above.find((c) => !r1 || c.price - r1.price >= minGap) || above[1] || null;
  const s1 = below[0] || null;
  const s2 = below.find((c) => !s1 || s1.price - c.price >= minGap) || below[1] || null;

  const fmtC = (c: typeof clusters[number] | null): KeyLevelPoint | null =>
    c ? { price: c.price, touches: c.touches, weight: c.weight, tags: [...c.tags].slice(0, 2).join('+') } : null;

  return {
    r1: fmtC(r1),
    r2: fmtC(r2),
    s1: fmtC(s1),
    s2: fmtC(s2),
    pdh,
    pdl,
    eqHigh,
    eqLow,
    all: clusters.sort((a, b) => b.weight - a.weight).slice(0, 10),
  };
}

export function detectSRReversal(
  closedBars: CandleBar[],
  formingBar: CandleBar | null,
  liveMid: number,
  keyLevels: KeyLevels,
  atr: number,
  rsi14: number | null,
  sym: string
): SRReversalInfo {
  const empty: SRReversalInfo = { active: false, side: 'NONE', zoneName: '', zonePrice: null, reason: '' };
  if (closedBars.length < 3 || !(atr > 0)) return empty;

  const last = closedBars[closedBars.length - 1];
  const prev = closedBars[closedBars.length - 2];
  const curBar = formingBar || last;
  const tol = Math.max(atr * 0.60, liveMid * 0.0005);

  const checkBearReject = (bar: CandleBar, prior: CandleBar) => {
    const rng = Math.max(1e-9, bar.high - bar.low);
    const body = Math.abs(bar.close - bar.open);
    const upperWick = bar.high - Math.max(bar.open, bar.close);
    const bearEngulf = bar.close < bar.open && prior.close > prior.open && bar.close <= prior.open;
    const upperReject = upperWick >= Math.max(body * 1.15, rng * 0.36);
    const bearTurn = bar.close < bar.open && body >= rng * 0.28;
    return bearEngulf || upperReject || (bearTurn && (rsi14 === null || rsi14 >= 56));
  };

  const checkBullBounce = (bar: CandleBar, prior: CandleBar) => {
    const rng = Math.max(1e-9, bar.high - bar.low);
    const body = Math.abs(bar.close - bar.open);
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    const bullEngulf = bar.close > bar.open && prior.close < prior.open && bar.close >= prior.open;
    const lowerReject = lowerWick >= Math.max(body * 1.15, rng * 0.36);
    const bullTurn = bar.close > bar.open && body >= rng * 0.28;
    return bullEngulf || lowerReject || (bullTurn && (rsi14 === null || rsi14 <= 44));
  };

  const resZones: Array<{ name: string; price: number }> = [];
  if (keyLevels.r1) resZones.push({ name: 'R1', price: keyLevels.r1.price });
  if (keyLevels.pdh) resZones.push({ name: 'PDH', price: keyLevels.pdh });
  if (keyLevels.r2) resZones.push({ name: 'R2', price: keyLevels.r2.price });

  for (const rz of resZones) {
    const touchedRes = Math.max(last.high, curBar.high) >= rz.price - tol && liveMid <= rz.price + tol * 0.6;
    if (touchedRes && (checkBearReject(last, prev) || (formingBar && checkBearReject(formingBar, last)))) {
      return {
        active: true,
        side: 'SELL',
        zoneName: rz.name,
        zonePrice: rz.price,
        reason: `Reversal at ${rz.name} (${fmtPrice(rz.price, sym)})`,
      };
    }
  }

  const supZones: Array<{ name: string; price: number }> = [];
  if (keyLevels.s1) supZones.push({ name: 'S1', price: keyLevels.s1.price });
  if (keyLevels.pdl) supZones.push({ name: 'PDL', price: keyLevels.pdl });
  if (keyLevels.s2) supZones.push({ name: 'S2', price: keyLevels.s2.price });

  for (const sz of supZones) {
    const touchedSup = Math.min(last.low, curBar.low) <= sz.price + tol && liveMid >= sz.price - tol * 0.6;
    if (touchedSup && (checkBullBounce(last, prev) || (formingBar && checkBullBounce(formingBar, last)))) {
      return {
        active: true,
        side: 'BUY',
        zoneName: sz.name,
        zonePrice: sz.price,
        reason: `Reversal at ${sz.name} (${fmtPrice(sz.price, sym)})`,
      };
    }
  }

  return empty;
}

export function analyzeMarketStructure(c: CandleBar[], atr: number, sym: string, bosLookback = 18): MarketStructure {
  if (c.length < 25) {
    return {
      type: 'NEUTRAL',
      kind: 'NONE',
      swingSequence: 'MIXED',
      swingHigh: null,
      swingLow: null,
      eqHigh: null,
      eqLow: null,
      sweep: null,
      inPullback: false,
      label: 'Insufficient bars',
    };
  }
  const { swingHighs, swingLows, eqHigh, eqLow } = detectConfirmedSwings(c, atr);
  const rH = swingHighs.length
    ? swingHighs[swingHighs.length - 1]
    : { index: c.length - 4, price: Math.max(...c.slice(-15, -1).map((x) => x.high)) };
  const rL = swingLows.length
    ? swingLows[swingLows.length - 1]
    : { index: c.length - 4, price: Math.min(...c.slice(-15, -1).map((x) => x.low)) };

  let seq = 'MIXED';
  let pb: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const hh = swingHighs[swingHighs.length - 1].price > swingHighs[swingHighs.length - 2].price;
    const hl = swingLows[swingLows.length - 1].price > swingLows[swingLows.length - 2].price;
    const lh = swingHighs[swingHighs.length - 1].price < swingHighs[swingHighs.length - 2].price;
    const ll = swingLows[swingLows.length - 1].price < swingLows[swingLows.length - 2].price;
    if (hh && hl) {
      pb = 'BULLISH';
      seq = 'HH/HL';
    } else if (lh && ll) {
      pb = 'BEARISH';
      seq = 'LH/LL';
    }
  }

  const last = c[c.length - 1];
  const prev = c[c.length - 2];
  let sweep: MarketStructure['sweep'] = null;
  for (const b of [prev, last]) {
    if (b.low < rL.price && b.close > rL.price) sweep = { type: 'BULLISH', level: rL.price, label: 'Bull Sweep' };
    if (b.high > rH.price && b.close < rH.price) sweep = { type: 'BEARISH', level: rH.price, label: 'Bear Sweep' };
  }

  const mm = (atr || 0) * 0.04;
  let brk: { type: 'BULLISH' | 'BEARISH'; kind: string; level: number; idx: number } | null = null;
  for (let idx = Math.max(2, c.length - bosLookback); idx < c.length; idx++) {
    const b = c[idx];
    const sh = swingHighs.filter((s) => s.index < idx).pop();
    const sl = swingLows.filter((s) => s.index < idx).pop();
    if (sh && b.close > sh.price + mm) brk = { type: 'BULLISH', kind: pb === 'BEARISH' ? 'CHoCH' : 'BOS', level: sh.price, idx };
    if (sl && b.close < sl.price - mm) brk = { type: 'BEARISH', kind: pb === 'BULLISH' ? 'CHoCH' : 'BOS', level: sl.price, idx };
  }

  if (brk?.type === 'BULLISH' && last.close >= rL.price) {
    const peak = Math.max(...c.slice(brk.idx).map((x) => x.high));
    const inPullback = last.close < peak - (atr || 0) * 0.15;
    return { type: 'BULLISH', kind: brk.kind, swingSequence: seq, swingHigh: rH.price, swingLow: rL.price, eqHigh, eqLow, sweep, inPullback, label: `Bull ${brk.kind} (${seq})${inPullback ? ' · Pullback' : ''}` };
  }
  if (brk?.type === 'BEARISH' && last.close <= rH.price) {
    const tr = Math.min(...c.slice(brk.idx).map((x) => x.low));
    const inPullback = last.close > tr + (atr || 0) * 0.15;
    return { type: 'BEARISH', kind: brk.kind, swingSequence: seq, swingHigh: rH.price, swingLow: rL.price, eqHigh, eqLow, sweep, inPullback, label: `Bear ${brk.kind} (${seq})${inPullback ? ' · Pullback' : ''}` };
  }
  if (pb === 'BULLISH' && last.close >= rL.price) {
    return { type: 'BULLISH', kind: 'BOS', swingSequence: seq, swingHigh: rH.price, swingLow: rL.price, eqHigh, eqLow, sweep, inPullback: true, label: `Bull HH/HL > ${fmtPrice(rL.price, sym)}` };
  }
  if (pb === 'BEARISH' && last.close <= rH.price) {
    return { type: 'BEARISH', kind: 'BOS', swingSequence: seq, swingHigh: rH.price, swingLow: rL.price, eqHigh, eqLow, sweep, inPullback: true, label: `Bear LH/LL < ${fmtPrice(rH.price, sym)}` };
  }
  return { type: 'NEUTRAL', kind: 'NONE', swingSequence: seq, swingHigh: rH.price, swingLow: rL.price, eqHigh, eqLow, sweep, inPullback: false, label: `Range ${fmtPrice(rL.price, sym)}–${fmtPrice(rH.price, sym)}` };
}

export function detectOrderAndBreakerBlocks(c: CandleBar[], st: MarketStructure, sym: string): { ob: BlockZone; breaker: BlockZone } {
  let ob: BlockZone = { type: 'NONE', high: 0, low: 0, index: -1, retested: false, label: 'None' };
  let breaker: BlockZone = { type: 'NONE', high: 0, low: 0, index: -1, label: 'None' };
  if (st.type === 'NEUTRAL') return { ob, breaker };
  const last = c[c.length - 1];
  for (let i = c.length - 2; i >= Math.max(1, c.length - 28); i--) {
    const x = c[i];
    const isBullO = x.close < x.open;
    const isBearO = x.close > x.open;
    if (st.type === 'BULLISH' && isBullO && ob.type === 'NONE') {
      let br = false;
      for (let j = i + 1; j < c.length; j++) {
        if (c[j].close < x.low) { br = true; break; }
      }
      if (!br) ob = { type: 'BULLISH', high: x.high, low: x.low, index: i, retested: last.low <= x.high && last.close >= x.low, label: `Demand OB ${fmtPrice(x.low, sym)}` };
    }
    if (st.type === 'BEARISH' && isBearO && ob.type === 'NONE') {
      let br = false;
      for (let j = i + 1; j < c.length; j++) {
        if (c[j].close > x.high) { br = true; break; }
      }
      if (!br) ob = { type: 'BEARISH', high: x.high, low: x.low, index: i, retested: last.high >= x.low && last.close <= x.high, label: `Supply OB ${fmtPrice(x.high, sym)}` };
    }
    if (st.type === 'BULLISH' && isBearO && breaker.type === 'NONE') {
      let ca = false;
      for (let j = i + 1; j < c.length; j++) {
        if (c[j].close > x.high) { ca = true; break; }
      }
      if (ca && last.close >= x.low) breaker = { type: 'BULLISH', high: x.high, low: x.low, index: i, label: 'Bull Breaker' };
    }
    if (st.type === 'BEARISH' && isBullO && breaker.type === 'NONE') {
      let cb = false;
      for (let j = i + 1; j < c.length; j++) {
        if (c[j].close < x.low) { cb = true; break; }
      }
      if (cb && last.close <= x.high) breaker = { type: 'BEARISH', high: x.high, low: x.low, index: i, label: 'Bear Breaker' };
    }
  }
  return { ob, breaker };
}

export function analyzeFVGs(c: CandleBar[], atr: number, sym = 'XAUUSD'): FVGAnalysis {
  const all: FVGZone[] = [];
  for (let i = Math.max(2, c.length - 60); i < c.length; i++) {
    const f = c[i - 2];
    const t = c[i];
    if (t.low > f.high) all.push({ type: 'BULLISH', top: t.low, bottom: f.high, index: i - 1, mitigated: false, invalidated: false });
    else if (t.high < f.low) all.push({ type: 'BEARISH', top: f.low, bottom: t.high, index: i - 1, mitigated: false, invalidated: false });
  }
  for (const z of all) {
    for (let j = z.index + 2; j < c.length; j++) {
      const b = c[j];
      if (z.type === 'BULLISH') {
        if (b.low <= z.top) z.mitigated = true;
        if (b.close < z.bottom) { z.invalidated = true; break; }
      } else {
        if (b.high >= z.bottom) z.mitigated = true;
        if (b.close > z.top) { z.invalidated = true; break; }
      }
    }
  }
  const vB = all.filter((z) => z.type === 'BULLISH' && !z.invalidated);
  const vS = all.filter((z) => z.type === 'BEARISH' && !z.invalidated);
  const lB = vB.length ? vB[vB.length - 1] : null;
  const lS = vS.length ? vS[vS.length - 1] : null;
  const last = c[c.length - 1];
  const prev = c[c.length - 2];
  const tol = (atr || 0) * 0.25;
  const retB = Boolean(lB && Math.min(last.low, prev.low) <= lB.top + tol && last.close >= lB.bottom && last.close > last.open);
  const retS = Boolean(lS && Math.max(last.high, prev.high) >= lS.bottom - tol && last.close <= lS.top && last.close < last.open);
  const parts: string[] = [];
  if (lB) parts.push(`Bull ${fmtPrice(lB.bottom, sym)}`);
  if (lS) parts.push(`Bear ${fmtPrice(lS.top, sym)}`);
  return { validBull: vB, validBear: vS, latestBull: lB, latestBear: lS, retestedBullFvg: retB, retestedBearFvg: retS, label: parts.length ? parts.join(' | ') : 'None active' };
}

export function detectFastAndKeyTriggers(
  closedBars: CandleBar[],
  keyLevels: KeyLevels,
  atr: number,
  e8: number,
  e21: number,
  macd: { hist: number; prevHist: number },
  sq: { squeezePopUp: boolean; squeezePopDown: boolean },
  st: MarketStructure
) {
  const last = closedBars[closedBars.length - 1];
  const prev = closedBars[closedBars.length - 2];
  const rng = Math.max(1e-9, last.high - last.low);
  const body = Math.abs(last.close - last.open);
  const lw = Math.min(last.open, last.close) - last.low;
  const uw = last.high - Math.max(last.open, last.close);

  const bullEngulf = last.close > last.open && prev.close < prev.open && last.close >= prev.open && last.open <= prev.close;
  const bearEngulf = last.close < last.open && prev.close > prev.open && last.close <= prev.open && last.open >= prev.close;
  const bullPin = lw >= body * 1.2 && lw >= rng * 0.35 && uw <= rng * 0.35;
  const bearPin = uw >= body * 1.2 && uw >= rng * 0.35 && lw <= rng * 0.35;
  const bullClose = last.close > last.open && body >= rng * 0.22;
  const bearClose = last.close < last.open && body >= rng * 0.22;

  // Anti-Spike Guard: only block extreme blow-off spikes (> 3.2 * ATR from EMA8 OR huge single spike bar > 2.8 * ATR)
  const distFromE8 = Math.abs(last.close - e8);
  const extremeSpike = distFromE8 > atr * 3.2 || body > atr * 2.8;
  const notChasedBull = !extremeSpike;
  const notChasedBear = !extremeSpike;

  // S/R Bounce & S/R Breakout
  const zoneTol = Math.max(atr * 0.75, last.close * 0.0005);
  const s1 = keyLevels.s1?.price;
  const r1 = keyLevels.r1?.price;
  const srBullBounce = Boolean(s1 && last.low <= s1 + zoneTol && last.close > s1 && (bullPin || bullEngulf || bullClose));
  const srBearReject = Boolean(r1 && last.high >= r1 - zoneTol && last.close < r1 && (bearPin || bearEngulf || bearClose));
  const srBreakoutBull = Boolean(r1 && prev.close <= r1 && last.close > r1 && bullClose);
  const srBreakoutBear = Boolean(s1 && prev.close >= s1 && last.close < s1 && bearClose);

  // Fast Strategy 1: Confirmed Trend Momentum (requires true EMA separation & directional expansion — never bare candle above entry in chop)
  const emaGap = Math.abs(e8 - e21);
  const macdBull = macd.hist > 0 && macd.hist >= macd.prevHist * 0.85;
  const macdBear = macd.hist < 0 && macd.hist <= macd.prevHist * 0.85;
  const fastMomentumBull = e8 > e21 && emaGap >= atr * 0.16 && bullClose && macdBull && last.close > e8;
  const fastMomentumBear = e8 < e21 && emaGap >= atr * 0.16 && bearClose && macdBear && last.close < e8;

  // Fast Strategy 2: Squeeze Breakout
  const squeezeBreakBull = sq.squeezePopUp && e8 >= e21 && bullClose;
  const squeezeBreakBear = sq.squeezePopDown && e8 <= e21 && bearClose;

  // Strategy 3: Break & Retest
  const bullBreakRetest = Boolean(keyLevels.all.some((k) => prev.close > k.price && last.low <= k.price + zoneTol && last.close > k.price && bullClose));
  const bearBreakRetest = Boolean(keyLevels.all.some((k) => prev.close < k.price && last.high >= k.price - zoneTol && last.close < k.price && bearClose));

  // Strategy 4: Structure / Price Action Impulse
  const paBull = bullEngulf || bullPin || (st.type === 'BULLISH' && bullClose && last.close > e21);
  const paBear = bearEngulf || bearPin || (st.type === 'BEARISH' && bearClose && last.close < e21);

  return {
    bullClose,
    bearClose,
    srBullBounce,
    srBearReject,
    srBreakoutBull,
    srBreakoutBear,
    fastMomentumBull,
    fastMomentumBear,
    squeezeBreakBull,
    squeezeBreakBear,
    bullBreakRetest,
    bearBreakRetest,
    paBull,
    paBear,
    notChasedBull,
    notChasedBear,
    extremeSpike,
  };
}

export function evaluateHTFContext(bars: CandleBar[] | null, lbl: string, sym: string) {
  if (!bars || bars.length < 25) return { bias: 'NEUTRAL' as const, wB: 5, wS: 5, label: `${lbl}: Neutral`, snapshot: null as MtfSnapshot | null };
  const cl = bars.map((x) => x.close);
  const e8 = calculateEMASeries(cl, 8).pop()!;
  const e21 = calculateEMASeries(cl, 21).pop()!;
  const atrS = calculateATRSeries(bars, 14);
  const atr = atrS.length ? atrS[atrS.length - 1] : cl[cl.length - 1] * 0.002;
  const adx = calculateADX(bars, 14) ?? 18;
  const rsi14 = calculateRSI(cl, 14);
  const st = analyzeMarketStructure(bars, atr, sym, 14);
  const fvg = analyzeFVGs(bars, atr, sym);
  const kl = extractKeyLevels(bars, null, null, atr, sym, cl[cl.length - 1]);
  const emaGapAtr = atr > 0 ? Math.abs(e8 - e21) / atr : 0;
  const emaTrend: 'BULL' | 'BEAR' | 'FLAT' = emaGapAtr < 0.14 ? 'FLAT' : e8 > e21 ? 'BULL' : 'BEAR';

  let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (st.type === 'BULLISH' && e8 >= e21) bias = 'BULLISH';
  else if (st.type === 'BEARISH' && e8 <= e21) bias = 'BEARISH';
  else if (st.type === 'BULLISH' || (emaTrend === 'BULL' && adx >= 18 && st.type !== 'BEARISH')) bias = 'BULLISH';
  else if (st.type === 'BEARISH' || (emaTrend === 'BEAR' && adx >= 18)) bias = 'BEARISH';

  const snapshot: MtfSnapshot = {
    tf: lbl as TimeframeKey,
    bias,
    regime: adx < 18 ? 'RANGE' : 'TREND',
    structure: st.label,
    emaTrend,
    rsi14: rsi14 !== null ? Number(rsi14.toFixed(1)) : null,
    r1: kl.r1?.price ?? null,
    s1: kl.s1?.price ?? null,
    ictNote: fvg.label,
  };

  return {
    bias,
    wB: bias === 'BULLISH' ? 15 : bias === 'NEUTRAL' ? 5 : 0,
    wS: bias === 'BEARISH' ? 15 : bias === 'NEUTRAL' ? 5 : 0,
    label: `${lbl}: ${bias}`,
    snapshot,
  };
}

export function evaluateMultiTimeframeContext(
  activeTf: TimeframeKey,
  mtfMap: Partial<Record<TimeframeKey, CandleBar[] | null>> | undefined,
  htfBars: CandleBar[] | null,
  h1Bars: CandleBar[] | null,
  d1Bars: CandleBar[] | null,
  sym: string
) {
  const prof = TF_PROFILES[activeTf] || TF_PROFILES.M15;
  const chain = prof.mtfChain || (prof.htf !== activeTf ? [prof.htf] : []);
  const snapshots: MtfSnapshot[] = [];
  let bullWeight = 0;
  let bearWeight = 0;
  let totalWeight = 0;
  let primaryBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';

  chain.forEach((tfKey, idx) => {
    const bars =
      mtfMap?.[tfKey] ??
      (tfKey === prof.htf ? htfBars : tfKey === 'H1' ? h1Bars : tfKey === 'D1' ? d1Bars : null);
    if (!bars || bars.length < 25) return;
    const res = evaluateHTFContext(bars, tfKey, sym);
    if (res.snapshot) snapshots.push(res.snapshot);
    const weight = idx === 0 ? 10 : idx === 1 ? 7 : 5;
    totalWeight += weight;
    if (res.bias === 'BULLISH') bullWeight += weight;
    else if (res.bias === 'BEARISH') bearWeight += weight;
    if (tfKey === prof.htf || idx === 0) primaryBias = res.bias;
  });

  if (snapshots.length === 0 && htfBars && htfBars.length >= 25 && prof.htf !== activeTf) {
    const fallback = evaluateHTFContext(htfBars, prof.htf, sym);
    if (fallback.snapshot) snapshots.push(fallback.snapshot);
    primaryBias = fallback.bias;
    totalWeight = 10;
    if (fallback.bias === 'BULLISH') bullWeight = 10;
    else if (fallback.bias === 'BEARISH') bearWeight = 10;
  }

  const bullRatio = totalWeight > 0 ? bullWeight / totalWeight : 0;
  const bearRatio = totalWeight > 0 ? bearWeight / totalWeight : 0;
  const macroBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
    bullRatio >= 0.55 ? 'BULLISH' : bearRatio >= 0.55 ? 'BEARISH' : primaryBias;

  const wB = totalWeight > 0 ? Math.round(bullRatio * 22) : 6;
  const wS = totalWeight > 0 ? Math.round(bearRatio * 22) : 6;
  const label = snapshots.length
    ? snapshots.map((s) => `${s.tf}:${s.bias === 'BULLISH' ? 'BULL' : s.bias === 'BEARISH' ? 'BEAR' : 'FLAT'}`).join(' · ')
    : `${prof.htf}: SELF`;

  return {
    snapshots,
    primaryBias,
    macroBias,
    wB,
    wS,
    label,
  };
}

export interface EvaluateSetupContext {
  provider: ProviderType;
  riskConfig: RiskConfig;
  brokerSpecsOverride: BrokerSpecOverrideMap;
  liveQuote: QuoteData | null;
  freshness: { available: boolean; fresh: boolean; status: string; label: string };
  historicalMode?: boolean;
  simQuote?: { bid: number; ask: number; mid: number; spread: number } | null;
  mtfBars?: Partial<Record<TimeframeKey, CandleBar[] | null>>;
}

export function evaluateSetup(
  symbol: string,
  tf: TimeframeKey,
  closedBars: CandleBar[],
  formingBar: CandleBar | null,
  htfBars: CandleBar[] | null,
  d1Bars: CandleBar[] | null,
  h1Bars: CandleBar[] | null,
  ctx: EvaluateSetupContext
): SignalOutput {
  const { provider, riskConfig, brokerSpecsOverride, historicalMode = false, simQuote = null } = ctx;
  const prof = TF_PROFILES[tf] || TF_PROFILES.M15;
  const freshness = historicalMode
    ? { available: true, fresh: true, status: 'LIVE', label: 'HISTORICAL' }
    : ctx.freshness;
  const quote = historicalMode ? simQuote : ctx.liveQuote;
  const spec = getSymbolSpec(symbol, provider, quote?.mid, riskConfig, brokerSpecsOverride, ctx.liveQuote?.mid);
  const htfLabel = TF_PROFILES[prof.htf]?.label || prof.htf;

  const mk = (ov: Partial<SignalOutput>): SignalOutput => ({
    asset: symbol,
    tf,
    source: provider,
    state: 'WAIT',
    type: 'WAIT',
    entryMode: 'NONE',
    entry: null,
    entryZone: null,
    tp1: null,
    tp2: null,
    tp3: null,
    sl: null,
    grossRR: null,
    netRR: null,
    rrText: '—',
    danger: { tier: 'CLEAN', pct: 15, riskScale: 1.0, tp1R: 0.90, tp2R: 1.65, label: 'CLEAN' },
    regime: { regime: 'UNKNOWN', adx: 0, atrRatio: 1, er: 0, squeeze: false, label: '—' },
    keyLevels: { r1: null, r2: null, s1: null, s2: null, pdh: null, pdl: null, all: [] },
    watchNote: null,
    htfSummary: htfLabel,
    setupScore: 0,
    rules: [],
    diagVeto: 'None',
    diagSetup: '—',
    diagTrigger: '—',
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
    closedCount: closedBars?.length || 0,
    formingBar,
    candleTime: closedBars?.length ? closedBars[closedBars.length - 1].timeMs : 0,
    time: new Date().toLocaleTimeString('en-US', { hour12: false }),
    reason: '—',
    ...ov,
  });

  if (!freshness.available || !freshness.fresh || !quote || !(quote.bid > 0) || !(quote.ask >= quote.bid)) {
    return mk({ state: 'NO TRADE', diagVeto: freshness.label, reason: `NO TRADE: ${freshness.label}` });
  }
  if (!closedBars || closedBars.length < 30) {
    return mk({ state: 'NO TRADE', diagVeto: `Need 30 bars (${closedBars?.length || 0})`, reason: 'NO TRADE: Insufficient candles' });
  }

  const closes = closedBars.map((c) => c.close);
  const e8S = calculateEMASeries(closes, 8);
  const e21S = calculateEMASeries(closes, 21);
  const e8 = e8S[e8S.length - 1];
  const e21 = e21S[e21S.length - 1];
  const rsi14 = calculateRSI(closes, 14);
  const atrS = calculateATRSeries(closedBars, 14);
  const atr14 = atrS.length ? atrS[atrS.length - 1] : quote.mid * 0.002;
  const macd = calculateMACD(closes);
  const sq = calculateSqueezeAndBands(closes, atr14);
  const { regime, danger } = classifyMarketRegimeAndDanger(closedBars, atrS, quote.spread, prof.maxSpreadRatioAtr, sq.squeezeOn);
  const h4Bars = ctx.mtfBars?.H4 || null;
  const keyLevels = extractKeyLevels(closedBars, d1Bars, h1Bars, atr14, symbol, quote.mid, h4Bars);
  const st = analyzeMarketStructure(closedBars, atr14, symbol, prof.bosLookback);
  const { ob, breaker } = detectOrderAndBreakerBlocks(closedBars, st, symbol);
  const fvg = analyzeFVGs(closedBars, atr14, symbol);
  const tr = detectFastAndKeyTriggers(closedBars, keyLevels, atr14, e8, e21, macd, sq, st);
  const srRev = detectSRReversal(closedBars, formingBar, quote.mid, keyLevels, atr14, rsi14, symbol);
  const mtf = evaluateMultiTimeframeContext(tf, ctx.mtfBars, htfBars, h1Bars, d1Bars, symbol);

  // Sideways / Chop detection: flat tangled EMA 8/21, tight overlapping range box, or low ADX+ER
  const e21Prev4 = e21S[Math.max(0, e21S.length - 5)];
  const emaGapAtr = atr14 > 0 ? Math.abs(e8 - e21) / atr14 : 0;
  const emaSlopeAtr = atr14 > 0 ? Math.abs(e21 - e21Prev4) / atr14 : 0;
  const recent12 = closedBars.slice(-12);
  const boxSpanAtr =
    atr14 > 0
      ? (Math.max(...recent12.map((b) => b.high)) - Math.min(...recent12.map((b) => b.low))) / atr14
      : 3;
  const isTangledEma = emaGapAtr < 0.20 && emaSlopeAtr < 0.15 && (regime.adx < 22 || regime.er < 0.20);
  const isTightBox = boxSpanAtr < 2.6 && st.type === 'NEUTRAL' && (regime.adx < 22 || regime.er < 0.20);
  const isLowQualityChop = (regime.adx < 18.5 && regime.er < 0.22) || (regime.er < 0.12 && emaGapAtr < 0.22);
  const hasBoundaryBreakout =
    (srRev.active && boxSpanAtr >= 2.2) ||
    tr.squeezeBreakBull ||
    tr.squeezeBreakBear ||
    tr.srBreakoutBull ||
    tr.srBreakoutBear ||
    Boolean(st.sweep && st.kind === 'CHoCH');
  const sidewayBlocked = (isLowQualityChop || isTangledEma || isTightBox) && !hasBoundaryBreakout;

  // Strategy Conviction Scoring: anchored to S/R, ICT (FVG/OB/Breaker/Sweep/BOS), Squeeze, and MTF Confluence
  let bScore = 0;
  let bStrat = '';
  if (srRev.active && srRev.side === 'BUY') { bScore += 32; bStrat = `REVERSAL AT ${srRev.zoneName}`; }
  if (tr.squeezeBreakBull) { bScore += 30; bStrat = bStrat || 'SQUEEZE BREAK'; }
  if (tr.srBullBounce) { bScore += 28; bStrat = bStrat || 'S/R BOUNCE'; }
  if (tr.srBreakoutBull || tr.bullBreakRetest) { bScore += 26; bStrat = bStrat || 'S/R BREAKOUT'; }
  if (st.sweep?.type === 'BULLISH') { bScore += 22; bStrat = bStrat || 'ICT SWEEP'; }
  if (fvg.retestedBullFvg || (ob.type === 'BULLISH' && ob.retested) || breaker.type === 'BULLISH') {
    bScore += 20;
    bStrat = bStrat || (fvg.retestedBullFvg ? 'ICT FVG RETEST' : ob.retested ? 'ICT OB RETEST' : 'ICT BREAKER');
  }
  if (tr.fastMomentumBull && regime.adx >= 20 && regime.er >= 0.24) { bScore += 20; bStrat = bStrat || 'TREND MOMENTUM'; }
  if (st.type === 'BULLISH') { bScore += 15; bStrat = bStrat || `ICT ${st.kind}`; }
  if (e8 > e21 && emaGapAtr >= 0.18) bScore += 10;
  bScore += mtf.wB;
  if (rsi14 !== null && rsi14 >= 42 && rsi14 < 76) bScore += 8;
  if (mtf.primaryBias === 'BEARISH') bScore -= 16;
  bScore = Math.max(0, Math.min(100, bScore));

  let sScore = 0;
  let sStrat = '';
  if (srRev.active && srRev.side === 'SELL') { sScore += 32; sStrat = `REVERSAL AT ${srRev.zoneName}`; }
  if (tr.squeezeBreakBear) { sScore += 30; sStrat = sStrat || 'SQUEEZE BREAK'; }
  if (tr.srBearReject) { sScore += 28; sStrat = sStrat || 'S/R REJECT'; }
  if (tr.srBreakoutBear || tr.bearBreakRetest) { sScore += 26; sStrat = sStrat || 'S/R BREAKOUT'; }
  if (st.sweep?.type === 'BEARISH') { sScore += 22; sStrat = sStrat || 'ICT SWEEP'; }
  if (fvg.retestedBearFvg || (ob.type === 'BEARISH' && ob.retested) || breaker.type === 'BEARISH') {
    sScore += 20;
    sStrat = sStrat || (fvg.retestedBearFvg ? 'ICT FVG RETEST' : ob.retested ? 'ICT OB RETEST' : 'ICT BREAKER');
  }
  if (tr.fastMomentumBear && regime.adx >= 20 && regime.er >= 0.24) { sScore += 20; sStrat = sStrat || 'TREND MOMENTUM'; }
  if (st.type === 'BEARISH') { sScore += 15; sStrat = sStrat || `ICT ${st.kind}`; }
  if (e8 < e21 && emaGapAtr >= 0.18) sScore += 10;
  sScore += mtf.wS;
  if (rsi14 !== null && rsi14 <= 58 && rsi14 > 24) sScore += 8;
  if (mtf.primaryBias === 'BULLISH') sScore -= 16;
  sScore = Math.max(0, Math.min(100, sScore));

  const dom: 'BUY' | 'SELL' = bScore >= sScore ? 'BUY' : 'SELL';
  const score = Math.max(bScore, sScore);
  const stratName = (dom === 'BUY' ? bStrat : sStrat) || 'S/R + ICT';
  const r3H = Math.max(...closedBars.slice(-3).map((c) => c.high));
  const r3L = Math.min(...closedBars.slice(-3).map((c) => c.low));

  const buildLvl = (side: 'BUY' | 'SELL') => {
    const entry = side === 'BUY' ? quote.ask : quote.bid;
    const minD = Math.max(atr14 * 1.1, spec.tickSize * 5);
    const maxReasonableSL = atr14 * 2.1;
    if (side === 'BUY') {
      const nearS1 = keyLevels.s1 && entry - keyLevels.s1.price <= maxReasonableSL ? keyLevels.s1.price : null;
      const base = nearS1 || (st.swingLow && entry - st.swingLow <= maxReasonableSL ? st.swingLow : r3L);
      const dist = Math.min(maxReasonableSL, Math.max(minD, entry - (base - atr14 * 0.25)));
      const sl = entry - dist;
      const tp1 = entry + dist * danger.tp1R;
      const tp2 = entry + dist * danger.tp2R;
      const tp3 =
        keyLevels.r1 && keyLevels.r1.price > tp2
          ? keyLevels.r1.price
          : keyLevels.r2 && keyLevels.r2.price > tp2
          ? keyLevels.r2.price
          : entry + dist * 2.4;
      return { entry, sl, tp1, tp2, tp3, dist, entryZone: `${fmtPrice(Math.min(entry, e8), symbol)}–${fmtPrice(entry, symbol)}` };
    }
    const nearR1 = keyLevels.r1 && keyLevels.r1.price - entry <= maxReasonableSL ? keyLevels.r1.price : null;
    const base = nearR1 || (st.swingHigh && st.swingHigh - entry <= maxReasonableSL ? st.swingHigh : r3H);
    const dist = Math.min(maxReasonableSL, Math.max(minD, base + atr14 * 0.25 - entry));
    const sl = entry + dist;
    const tp1 = entry - dist * danger.tp1R;
    const tp2 = entry - dist * danger.tp2R;
    const tp3 =
      keyLevels.s1 && keyLevels.s1.price < tp2
        ? keyLevels.s1.price
        : keyLevels.s2 && keyLevels.s2.price < tp2
        ? keyLevels.s2.price
        : entry - dist * 2.4;
    return { entry, sl, tp1, tp2, tp3, dist, entryZone: `${fmtPrice(entry, symbol)}–${fmtPrice(Math.max(entry, e8), symbol)}` };
  };

  const lv = buildLvl(dom);
  const rc = computePositionRiskAndCosts(lv.dist, quote, spec, riskConfig, danger.riskScale);
  const cost = rc.costInPrice || quote.spread;
  const netR1 = lv.dist + cost > 0 ? Math.max(0, lv.dist * danger.tp1R - cost) / (lv.dist + cost) : 0;
  const netR2 = lv.dist + cost > 0 ? Math.max(0, lv.dist * danger.tp2R - cost) / (lv.dist + cost) : 0;
  const riskAdv = !spec.verified
    ? 'Spec UNVERIFIED'
    : !rc.valid
    ? `Advisory: ${rc.reason}`
    : `Lot ${rc.lots.toFixed(2)} (${(danger.riskScale * 100).toFixed(0)}%)`;

  const hasStrategyTrigger =
    dom === 'BUY'
      ? (srRev.active && srRev.side === 'BUY') ||
        tr.squeezeBreakBull ||
        tr.srBullBounce ||
        tr.srBreakoutBull ||
        tr.bullBreakRetest ||
        fvg.retestedBullFvg ||
        (ob.type === 'BULLISH' && ob.retested) ||
        breaker.type === 'BULLISH' ||
        st.sweep?.type === 'BULLISH' ||
        (st.type === 'BULLISH' && tr.paBull) ||
        (tr.fastMomentumBull && regime.adx >= 20 && regime.er >= 0.24)
      : (srRev.active && srRev.side === 'SELL') ||
        tr.squeezeBreakBear ||
        tr.srBearReject ||
        tr.srBreakoutBear ||
        tr.bearBreakRetest ||
        fvg.retestedBearFvg ||
        (ob.type === 'BEARISH' && ob.retested) ||
        breaker.type === 'BEARISH' ||
        st.sweep?.type === 'BEARISH' ||
        (st.type === 'BEARISH' && tr.paBear) ||
        (tr.fastMomentumBear && regime.adx >= 20 && regime.er >= 0.24);

  const notChased = dom === 'BUY' ? tr.notChasedBull : tr.notChasedBear;

  // Room-to-S/R obstacle guard (avoid buying right under multi-touch R1/structural ceiling or selling right onto S1)
  const nearUpperWall = keyLevels.all.find(
    (c) =>
      (c.touches >= 2 || !c.tags.has('Round')) &&
      c.price >= lv.entry - atr14 * 0.15 &&
      c.price - lv.entry < lv.dist * 0.65
  );
  const nearLowerWall = keyLevels.all.find(
    (c) =>
      (c.touches >= 2 || !c.tags.has('Round')) &&
      c.price <= lv.entry + atr14 * 0.15 &&
      lv.entry - c.price < lv.dist * 0.65
  );
  const r1IsStructural = Boolean(keyLevels.r1 && (keyLevels.r1.touches >= 2 || !keyLevels.r1.tags.includes('Round')));
  const s1IsStructural = Boolean(keyLevels.s1 && (keyLevels.s1.touches >= 2 || !keyLevels.s1.tags.includes('Round')));
  const blockedIntoR1 =
    dom === 'BUY' &&
    !tr.srBreakoutBull &&
    !tr.squeezeBreakBull &&
    ((r1IsStructural && keyLevels.r1 !== null && keyLevels.r1.price - lv.entry < lv.dist * 0.65) ||
      Boolean(nearUpperWall));
  const blockedIntoS1 =
    dom === 'SELL' &&
    !tr.srBreakoutBear &&
    !tr.squeezeBreakBear &&
    ((s1IsStructural && keyLevels.s1 !== null && lv.entry - keyLevels.s1.price < lv.dist * 0.65) ||
      Boolean(nearLowerWall));
  const obstaclePriceR = keyLevels.r1 && r1IsStructural && keyLevels.r1.price - lv.entry < lv.dist * 0.65 ? keyLevels.r1.price : nearUpperWall?.price;
  const obstaclePriceS = keyLevels.s1 && s1IsStructural && lv.entry - keyLevels.s1.price < lv.dist * 0.65 ? keyLevels.s1.price : nearLowerWall?.price;
  const srObstacleMsg = blockedIntoR1 && obstaclePriceR
    ? `Blocked near R1 (${fmtPrice(obstaclePriceR, symbol)}) — wait break > R1 or pullback S1`
    : blockedIntoS1 && obstaclePriceS
    ? `Blocked near S1 (${fmtPrice(obstaclePriceS, symbol)}) — wait break < S1 or rally R1`
    : null;

  // Counter-HTF guard: don't trade against primary HTF unless explicit S/R Reversal or ICT CHoCH/Sweep + strong score
  const htfOpposite =
    (dom === 'BUY' && mtf.primaryBias === 'BEARISH') ||
    (dom === 'SELL' && mtf.primaryBias === 'BULLISH');
  const hasCounterHtfReversal =
    (srRev.active && srRev.side === dom) ||
    st.kind === 'CHoCH' ||
    Boolean(st.sweep && st.sweep.type === (dom === 'BUY' ? 'BULLISH' : 'BEARISH'));
  const blockedByHtf = htfOpposite && (!hasCounterHtfReversal || score < 60);

  const rules = [
    { name: 'S/R + ICT Setup', pass: hasStrategyTrigger && !srObstacleMsg, detail: srObstacleMsg ? 'Near S/R Wall' : stratName },
    { name: 'EMA 8/21 + MACD', pass: dom === 'BUY' ? e8 > e21 && macd.hist >= 0 : e8 < e21 && macd.hist <= 0, detail: emaGapAtr < 0.20 ? 'EMA Flat' : macd.hist >= 0 ? 'Bull Mom' : 'Bear Mom' },
    { name: 'No Sideways Chop', pass: !sidewayBlocked, detail: sidewayBlocked ? `Sideway (ADX ${regime.adx.toFixed(0)})` : sq.squeezeOn ? 'Squeeze ON' : regime.regime },
    { name: 'Anti-Spike Guard', pass: notChased, detail: notChased ? 'Clear' : 'Extreme Spike' },
    { name: `MTF (${prof.htf}+)`, pass: !blockedByHtf && mtf.macroBias !== (dom === 'BUY' ? 'BEARISH' : 'BULLISH'), detail: mtf.label },
    { name: 'S/R Key Levels', pass: Boolean(keyLevels.s1 || keyLevels.r1), detail: srRev.active ? srRev.reason : keyLevels.s1 && keyLevels.r1 ? 'S1/R1 OK' : 'Partial' },
    { name: 'Danger Tier', pass: danger.pct < 65, detail: `${danger.pct}%` },
    { name: 'Net R:R', pass: netR1 >= 0.5, detail: `${netR1.toFixed(2)}R` },
  ];

  // Hard WAIT on Sideways / Choppy Market so signals never fire in dead range
  if (sidewayBlocked) {
    return mk({
      state: 'WAIT',
      type: 'WAIT',
      sidewayBlocked: true,
      danger,
      regime,
      keyLevels,
      setupScore: Math.min(score, 44),
      rules,
      htfSummary: mtf.label,
      mtfBreakdown: mtf.snapshots,
      ema8: e8,
      ema21: e21,
      macdHist: macd.hist,
      rsi14,
      atr14,
      fvg,
      structure: st,
      ob,
      breaker,
      riskCalc: rc,
      reversalInfo: srRev,
      reversalWarning: srRev.active,
      diagVeto: riskAdv,
      diagSetup: `Sideway / Chop (ADX ${regime.adx.toFixed(1)})`,
      diagTrigger: 'Wait S1/R1 breakout or ICT FVG/OB bounce',
      reason: `WAIT: Sideways Range (ADX ${regime.adx.toFixed(1)} · Wait S1/R1)`,
    });
  }

  if (score >= 52 && hasStrategyTrigger && notChased && !srObstacleMsg && !blockedByHtf && netR1 >= 0.5) {
    const mode = `${stratName}${danger.tier !== 'CLEAN' ? ` (${Math.round(danger.riskScale * 100)}% RISK)` : ''}`;
    return mk({
      state: 'READY',
      type: dom,
      sidewayBlocked: false,
      entryMode: mode,
      entry: lv.entry,
      entryZone: lv.entryZone,
      tp1: lv.tp1,
      tp2: lv.tp2,
      tp3: lv.tp3,
      sl: lv.sl,
      grossRR: danger.tp1R,
      netRR: netR1,
      rrText: `Gross ${danger.tp1R}R/${danger.tp2R}R | Net ${netR1.toFixed(2)}R/${netR2.toFixed(2)}R`,
      danger,
      regime,
      keyLevels,
      htfSummary: mtf.label,
      mtfBreakdown: mtf.snapshots,
      setupScore: score,
      rules,
      riskCalc: rc,
      reversalInfo: srRev,
      reversalWarning: srRev.active && srRev.side !== dom,
      diagVeto: riskAdv,
      diagSetup: `${dom} ${score}% · ${regime.regime}`,
      diagTrigger: `${stratName} confirmed`,
      ema8: e8,
      ema21: e21,
      macdHist: macd.hist,
      rsi14,
      atr14,
      fvg,
      structure: st,
      ob,
      breaker,
      reason: `READY ${dom} (${stratName} · ${score}%)`,
    });
  }

  const tgtLvl =
    dom === 'BUY'
      ? keyLevels.s1
        ? fmtPrice(keyLevels.s1.price, symbol)
        : fmtPrice(e8, symbol)
      : keyLevels.r1
      ? fmtPrice(keyLevels.r1.price, symbol)
      : fmtPrice(e8, symbol);

  const reasonWait = !notChased
    ? 'Extreme blow-off spike — wait pullback'
    : srObstacleMsg
    ? srObstacleMsg
    : blockedByHtf
    ? `Counter-${prof.htf} (${mtf.primaryBias}) — wait HTF alignment or S/R Reversal`
    : !hasStrategyTrigger
    ? `Bias ${dom} (${score}%) — awaiting S/R or ICT confirmation`
    : `Score ${score}% < 52% or low R:R (${netR1.toFixed(2)}R)`;

  return mk({
    state: score >= 45 ? 'WATCH' : 'WAIT',
    type: 'WAIT',
    sidewayBlocked: false,
    entryMode: `${dom} BIAS ${score}%`,
    entryZone: tgtLvl,
    watchNote: srRev.active ? srRev.reason : `${dom} BIAS (${score}%) · ${reasonWait}`,
    danger,
    regime,
    keyLevels,
    htfSummary: mtf.label,
    mtfBreakdown: mtf.snapshots,
    setupScore: score,
    rules,
    riskCalc: rc,
    reversalInfo: srRev,
    reversalWarning: srRev.active,
    grossRR: danger.tp1R,
    netRR: netR1,
    rrText: `Est. Net ${netR1.toFixed(2)}R`,
    diagVeto: riskAdv,
    diagSetup: `${dom} ${score}% · ${regime.regime}`,
    diagTrigger: reasonWait,
    ema8: e8,
    ema21: e21,
    macdHist: macd.hist,
    rsi14,
    atr14,
    fvg,
    structure: st,
    ob,
    breaker,
    reason: `${score >= 45 ? 'WATCH' : 'WAIT'}: ${reasonWait}`,
  });
}

export function runWalkForwardForTimeframe(
  sym: string,
  tf: TimeframeKey,
  closedBars: CandleBar[],
  htfBars: CandleBar[] | null,
  d1Bars: CandleBar[] | null,
  h1Bars: CandleBar[] | null,
  ctx: {
    provider: ProviderType;
    riskConfig: RiskConfig;
    brokerSpecsOverride: BrokerSpecOverrideMap;
    liveQuote: QuoteData | null;
    spreadOv?: number | null;
  },
  wfCache: Record<string, WalkForwardStats>
): WalkForwardStats {
  if (!closedBars || closedBars.length < 75) {
    return { insufficient: true, reason: `Insufficient data (${closedBars?.length || 0}/75 bars)` };
  }
  const lastCt = closedBars[closedBars.length - 1].timeMs;
  const ck = `${sym}:${tf}:${lastCt}:${ctx.spreadOv ?? 'live'}`;
  if (wfCache[ck]) return wfCache[ck];

  const prof = TF_PROFILES[tf] || TF_PROFILES.M15;
  const spec = getSymbolSpec(
    sym,
    ctx.provider,
    closedBars[closedBars.length - 1].close,
    ctx.riskConfig,
    ctx.brokerSpecsOverride,
    ctx.liveQuote?.mid
  );
  const tfMs = prof.seconds * 1000;
  const htfMs = (TF_PROFILES[prof.htf]?.seconds || 3600) * 1000;
  const d1Ms = 86400 * 1000;
  const h1Ms = 3600 * 1000;
  const simSp = ctx.spreadOv != null ? ctx.spreadOv : ctx.liveQuote?.spread || spec.pipSize * 1.5;
  const slip = spec.slippagePoints * spec.pointSize * 2;
  const comm = spec.verified && spec.tickValueUsd ? (spec.commissionPerLotUsd || 0) / (spec.tickValueUsd / spec.tickSize) : 0;

  let w = 0,
    l = 0,
    open = 0,
    skip = 0,
    sW = 0,
    sL = 0,
    eq = 0,
    pk = 0,
    dd = 0,
    cs = 0,
    ms = 0,
    cd = -1;
  const startI = Math.max(45, closedBars.length - 155);

  for (let i = startI; i < closedBars.length - 2; i++) {
    if (i <= cd) continue;
    const decMs = closedBars[i].timeMs + tfMs;
    const sLtf = closedBars.slice(Math.max(0, i - 110), i + 1);
    const sHtf = htfBars ? htfBars.filter((h) => h.timeMs + htfMs <= decMs).slice(-90) : null;
    const sD1 = d1Bars ? d1Bars.filter((d) => d.timeMs + d1Ms <= decMs).slice(-40) : null;
    const sH1 = h1Bars ? h1Bars.filter((h) => h.timeMs + h1Ms <= decMs).slice(-80) : null;
    const exec = closedBars[i + 1].open;

    const stp = evaluateSetup(sym, tf, sLtf, null, sHtf, sD1, sH1, {
      provider: ctx.provider,
      riskConfig: ctx.riskConfig,
      brokerSpecsOverride: ctx.brokerSpecsOverride,
      liveQuote: ctx.liveQuote,
      freshness: { available: true, fresh: true, status: 'LIVE', label: 'HISTORICAL' },
      historicalMode: true,
      simQuote: { bid: exec - simSp * 0.5, ask: exec + simSp * 0.5, mid: exec, spread: simSp },
    });

    if (stp.state !== 'READY' || !Number.isFinite(stp.tp1) || !Number.isFinite(stp.sl) || !Number.isFinite(stp.entry) || !Number.isFinite(stp.tp2)) {
      skip++;
      continue;
    }

    const rsk = Math.abs(stp.entry! - stp.sl!) + slip + comm;
    const r1 = Math.max(0, Math.abs(stp.tp1! - stp.entry!) - slip - comm);
    const r2 = Math.max(0, Math.abs(stp.tp2! - stp.entry!) - slip - comm);
    let out: 'WIN' | 'LOSS' | 'OPEN' = 'OPEN';
    let rr = 0;
    let ri = i + 1;

    for (let k = i + 1; k < Math.min(closedBars.length, i + 45); k++) {
      const b = closedBars[k];
      ri = k;
      if (stp.type === 'BUY') {
        if (b.low <= stp.sl!) { out = 'LOSS'; rr = -1; break; }
        if (b.high >= stp.tp2!) { out = 'WIN'; rr = r2 / rsk; break; }
        if (b.high >= stp.tp1!) { out = 'WIN'; rr = r1 / rsk; break; }
      } else {
        if (b.high >= stp.sl!) { out = 'LOSS'; rr = -1; break; }
        if (b.low <= stp.tp2!) { out = 'WIN'; rr = r2 / rsk; break; }
        if (b.low <= stp.tp1!) { out = 'WIN'; rr = r1 / rsk; break; }
      }
    }

    cd = ri + prof.cooldownBars;
    if (out === 'WIN') {
      w++;
      sW += rr;
      eq += rr;
      cs = 0;
    } else if (out === 'LOSS') {
      l++;
      sL += 1;
      eq -= 1;
      cs++;
      ms = Math.max(ms, cs);
    } else {
      open++;
    }
    pk = Math.max(pk, eq);
    dd = Math.max(dd, pk - eq);
  }

  const tot = w + l;
  const res: WalkForwardStats = {
    insufficient: false,
    symbol: sym,
    tf,
    totalTrades: tot,
    wins: w,
    losses: l,
    openOrExpired: open,
    skippedSetups: skip,
    winRate: tot > 0 ? (w / tot) * 100 : null,
    profitFactor: sL > 0 ? sW / sL : sW > 0 ? 9.99 : 0,
    netRR: l > 0 && w > 0 ? sW / w / (sL / l) : w > 0 ? sW / w : 0,
    maxDrawdownR: dd,
    avgWinR: w > 0 ? sW / w : 0,
    avgLossR: l > 0 ? sL / l : 0,
    expectancyR: tot > 0 ? eq / tot : 0,
    maxLossStreak: ms,
  };
  wfCache[ck] = res;
  return res;
}
