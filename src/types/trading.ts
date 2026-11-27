export type ProviderType = 'BIQUOTE' | 'EXNESS';
export type MarketDesk = 'FOREX' | 'CRYPTO';
export type SymbolGroup = 'GOLD' | 'FX' | 'CRYPTO';
export type TimeframeKey = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1' | 'W1';
export type LangCode = 'en' | 'kh';
export type ContractMode = 'STANDARD' | 'CENT';

export interface SymbolSpec {
  desk: MarketDesk;
  group: SymbolGroup;
  label: string;
  digits: number;
  pointSize: number;
  pipSize: number;
  tickSize: number;
  contractSize: number;
  quoteCcy: string;
  volumeMin: number;
  volumeStep: number;
  slippagePoints: number;
  roundStep: number;
  specNote: string;
  verified: boolean;
  tickValueUsd?: number;
}

export interface ComputedSymbolSpec extends Partial<SymbolSpec> {
  verified: boolean;
  reason?: string;
  contractMultiplier?: number;
  effectiveContractSize?: number;
  tickValueUsd?: number;
  commissionPerLotUsd?: number;
  digits: number;
  pointSize: number;
  pipSize: number;
  tickSize: number;
  volumeMin: number;
  volumeStep: number;
  slippagePoints: number;
  desk: MarketDesk;
  group: SymbolGroup;
  specNote: string;
}

export interface TimeframeProfile {
  biquote: string;
  seconds: number;
  label: TimeframeKey;
  role: string;
  htf: TimeframeKey;
  mtfChain: TimeframeKey[];
  cooldownBars: number;
  maxSpreadRatioAtr: number;
  bosLookback: number;
}

export interface MtfSnapshot {
  tf: TimeframeKey;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  regime: string;
  structure: string;
  emaTrend: 'BULL' | 'BEAR' | 'FLAT';
  rsi14: number | null;
  r1: number | null;
  s1: number | null;
  ictNote: string;
}

export interface QuoteData {
  symbol: string;
  provider: ProviderType;
  source: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  high: number | null;
  low: number | null;
  dayDiffPercent: number | null;
  timestamp: string;
  providerTsMs: number;
  localReceiptMs: number;
  serverQuoteAgeSeconds: number | null;
  marketState: string;
  staleFlag: boolean;
  digits: number;
}

export interface FreshnessResult {
  available: boolean;
  fresh: boolean;
  status: 'LIVE' | 'CLOSED' | 'STALE' | 'UNAVAILABLE';
  ageSeconds: number;
  limitSec: number;
  label: string;
}

export interface CandleBar {
  openTime?: string;
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  isOpen: boolean;
}

export interface CandleBundle {
  closedBars: CandleBar[];
  formingBar: CandleBar | null;
  fetchedAt: number;
}

export interface KeyLevelPoint {
  price: number;
  touches: number;
  weight: number;
  tags: string;
}

export interface KeyLevels {
  r1: KeyLevelPoint | null;
  r2: KeyLevelPoint | null;
  s1: KeyLevelPoint | null;
  s2: KeyLevelPoint | null;
  pdh: number | null;
  pdl: number | null;
  eqHigh?: number | null;
  eqLow?: number | null;
  all: Array<{ price: number; touches: number; weight: number; tags: Set<string> }>;
}

export interface FVGZone {
  type: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  index: number;
  mitigated: boolean;
  invalidated: boolean;
}

export interface FVGAnalysis {
  validBull: FVGZone[];
  validBear: FVGZone[];
  latestBull: FVGZone | null;
  latestBear: FVGZone | null;
  retestedBullFvg?: boolean;
  retestedBearFvg?: boolean;
  label: string;
}

export interface MarketStructure {
  type: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  kind: string;
  swingSequence?: string;
  swingHigh?: number | null;
  swingLow?: number | null;
  eqHigh: number | null;
  eqLow: number | null;
  sweep: { type: string; level: number; label: string } | null;
  inPullback?: boolean;
  label: string;
}

export interface BlockZone {
  type: 'BULLISH' | 'BEARISH' | 'NONE';
  high: number;
  low: number;
  index: number;
  retested?: boolean;
  label: string;
}

export interface RegimeInfo {
  regime: string;
  adx: number;
  atrRatio: number;
  er: number;
  squeeze: boolean;
  label: string;
}

export interface DangerInfo {
  tier: 'CLEAN' | 'CAUTION' | 'HIGH DANGER';
  pct: number;
  riskScale: number;
  tp1R: number;
  tp2R: number;
  label: string;
}

export interface RiskCalcResult {
  valid: boolean;
  minLotExceeds?: boolean;
  riskBudgetUsd?: number;
  minLotRiskUsd?: number;
  lots: number;
  actualRiskUsd?: number;
  costInPrice?: number;
  reason: string;
}

export interface RuleCheckItem {
  name: string;
  pass: boolean;
  detail: string;
}

export interface SRReversalInfo {
  active: boolean;
  side: 'BUY' | 'SELL' | 'NONE';
  zoneName: string;
  zonePrice: number | null;
  reason: string;
}

export interface AiAnalysisResult {
  symbol: string;
  tf: TimeframeKey;
  bias: 'BUY' | 'SELL' | 'WAIT';
  confidence: number;
  setupType: string;
  srVerdict: string;
  reversalAlert: string;
  entryPlan: string;
  riskNote: string;
  summary: string;
  analyzedAt: string;
  modelUsed?: string;
}

export interface SignalOutput {
  asset: string;
  tf: TimeframeKey;
  source: ProviderType;
  state: 'READY' | 'WATCH' | 'WAIT' | 'NO TRADE';
  type: 'BUY' | 'SELL' | 'WAIT';
  entryMode: string;
  entry: number | null;
  entryZone: string | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  sl: number | null;
  grossRR: number | null;
  netRR: number | null;
  rrText: string;
  danger: DangerInfo;
  regime: RegimeInfo;
  keyLevels: KeyLevels;
  watchNote: string | null;
  htfSummary: string;
  mtfBreakdown?: MtfSnapshot[];
  sidewayBlocked?: boolean;
  setupScore: number;
  rules: RuleCheckItem[];
  diagVeto: string;
  diagSetup: string;
  diagTrigger: string;
  ema8: number | null;
  ema21: number | null;
  macdHist: number | null;
  rsi14: number | null;
  atr14: number | null;
  fvg: FVGAnalysis;
  structure: MarketStructure;
  ob: BlockZone;
  breaker: BlockZone;
  riskCalc: RiskCalcResult | null;
  locked: boolean;
  reversalWarning: boolean;
  reversalInfo?: SRReversalInfo;
  tp1Hit: boolean;
  tp2Hit: boolean;
  closedCount: number;
  formingBar: CandleBar | null;
  candleTime: number;
  time: string;
  reason: string;
}

export interface ActiveLock {
  id?: string;
  asset: string;
  tf?: TimeframeKey;
  provider?: ProviderType;
  type: 'BUY' | 'SELL';
  entryMode?: string;
  entry: number;
  entryZone?: string | null;
  tp1: number;
  tp2: number;
  tp3: number;
  sl: number;
  grossRR?: number | null;
  netRR?: number | null;
  rrText?: string;
  riskCalc?: RiskCalcResult | null;
  candleTime: number;
  time?: string;
  tp1Hit: boolean;
  tp2Hit?: boolean;
}

export interface WalkForwardStats {
  insufficient: boolean;
  reason?: string;
  symbol?: string;
  tf?: TimeframeKey;
  totalTrades?: number;
  wins?: number;
  losses?: number;
  openOrExpired?: number;
  skippedSetups?: number;
  winRate?: number | null;
  profitFactor?: number;
  netRR?: number;
  maxDrawdownR?: number;
  avgWinR?: number;
  avgLossR?: number;
  expectancyR?: number;
  maxLossStreak?: number;
}

export interface HistoryEntry {
  time: string;
  date: string;
  asset: string;
  desk: MarketDesk;
  tf: TimeframeKey;
  source: ProviderType;
  type: 'BUY' | 'SELL';
  entry: string;
  tp1: string;
  sl: string;
  status: string;
}

export interface RiskLedger {
  dateUtc: string;
  dailyLossPct: number;
  consecutiveLosses: number;
  openPositions: number;
  pausedForReview: boolean;
}

export interface ChartLayers {
  sr: boolean;
  liq: boolean;
  ict: boolean;
}

export interface RiskConfig {
  balance: number;
  riskPercent: number;
  dailyCap: number;
  contractMode: ContractMode;
  commission: number;
}
