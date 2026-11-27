import type { LangCode, SymbolSpec, TimeframeKey, TimeframeProfile } from '../types/trading';

export const APP_VERSION = 'NETHAGA_FAST_FX_CRYPTO_v7.1';
export const RELEASE_DATE = '2026-11-23';

export const STORAGE_KEYS = {
  history: 'nethaga_signal_history_v6',
  language: 'nethaga_language_v6',
  alerts: 'nethaga_alerts_v6',
  provider: 'nethaga_provider_v6',
  symbol: 'nethaga_active_symbol_v6',
  desk: 'nethaga_market_desk_v70',
  riskBal: 'nethaga_risk_balance_v70',
  riskPct: 'nethaga_risk_pct_v70',
  dailyCap: 'nethaga_risk_dailycap_v70',
  contractMode: 'nethaga_contract_mode_v70',
  commission: 'nethaga_commission_v70',
  riskState: 'nethaga_risk_ledger_v70',
  lock: 'nethaga_active_lock_v70',
  layers: 'nethaga_chart_layers_v70',
} as const;

export const BIQUOTE_BASE = 'https://biquote.io';
export const BIQUOTE_HUB = 'https://biquote.io/hubs/tick';

export const FRESHNESS_LIMITS_SEC: Record<TimeframeKey, number> = {
  M1: 45,
  M5: 70,
  M15: 150,
  M30: 240,
  H1: 360,
  H4: 600,
  D1: 900,
  W1: 1800,
};

export const SYMBOL_SPECS: Record<string, SymbolSpec> = {
  XAUUSD: { desk: 'FOREX', group: 'GOLD', label: 'Gold / USD', digits: 2, pointSize: 0.01, pipSize: 0.10, tickSize: 0.01, contractSize: 100, quoteCcy: 'USD', volumeMin: 0.01, volumeStep: 0.01, slippagePoints: 15, roundStep: 10, specNote: '100 oz/lot', verified: true },
  EURUSD: { desk: 'FOREX', group: 'FX', label: 'EUR / USD', digits: 5, pointSize: 0.00001, pipSize: 0.0001, tickSize: 0.00001, contractSize: 100000, quoteCcy: 'USD', volumeMin: 0.01, volumeStep: 0.01, slippagePoints: 5, roundStep: 0.005, specNote: '100k/lot', verified: true },
  GBPUSD: { desk: 'FOREX', group: 'FX', label: 'GBP / USD', digits: 5, pointSize: 0.00001, pipSize: 0.0001, tickSize: 0.00001, contractSize: 100000, quoteCcy: 'USD', volumeMin: 0.01, volumeStep: 0.01, slippagePoints: 6, roundStep: 0.005, specNote: '100k/lot', verified: true },
  USDJPY: { desk: 'FOREX', group: 'FX', label: 'USD / JPY', digits: 3, pointSize: 0.001, pipSize: 0.01, tickSize: 0.001, contractSize: 100000, quoteCcy: 'JPY', volumeMin: 0.01, volumeStep: 0.01, slippagePoints: 5, roundStep: 0.50, specNote: '100k/lot', verified: true },
  AUDUSD: { desk: 'FOREX', group: 'FX', label: 'AUD / USD', digits: 5, pointSize: 0.00001, pipSize: 0.0001, tickSize: 0.00001, contractSize: 100000, quoteCcy: 'USD', volumeMin: 0.01, volumeStep: 0.01, slippagePoints: 5, roundStep: 0.005, specNote: '100k/lot', verified: true },
  USDCAD: { desk: 'FOREX', group: 'FX', label: 'USD / CAD', digits: 5, pointSize: 0.00001, pipSize: 0.0001, tickSize: 0.00001, contractSize: 100000, quoteCcy: 'CAD', volumeMin: 0.01, volumeStep: 0.01, slippagePoints: 6, roundStep: 0.005, specNote: '100k/lot', verified: true },
  USDCHF: { desk: 'FOREX', group: 'FX', label: 'USD / CHF', digits: 5, pointSize: 0.00001, pipSize: 0.0001, tickSize: 0.00001, contractSize: 100000, quoteCcy: 'CHF', volumeMin: 0.01, volumeStep: 0.01, slippagePoints: 6, roundStep: 0.005, specNote: '100k/lot', verified: true },
  NZDUSD: { desk: 'FOREX', group: 'FX', label: 'NZD / USD', digits: 5, pointSize: 0.00001, pipSize: 0.0001, tickSize: 0.00001, contractSize: 100000, quoteCcy: 'USD', volumeMin: 0.01, volumeStep: 0.01, slippagePoints: 6, roundStep: 0.005, specNote: '100k/lot', verified: true },
  BTCUSD: { desk: 'CRYPTO', group: 'CRYPTO', label: 'Bitcoin / USD', digits: 2, pointSize: 0.01, pipSize: 1.00, tickSize: 0.01, contractSize: 1, quoteCcy: 'USD', volumeMin: 0.01, volumeStep: 0.01, slippagePoints: 50, roundStep: 500, specNote: '1 BTC/lot (verify)', verified: true },
  ETHUSD: { desk: 'CRYPTO', group: 'CRYPTO', label: 'Ethereum / USD', digits: 2, pointSize: 0.01, pipSize: 1.00, tickSize: 0.01, contractSize: 1, quoteCcy: 'USD', volumeMin: 0.01, volumeStep: 0.01, slippagePoints: 25, roundStep: 50, specNote: '1 ETH/lot (verify)', verified: true },
  SOLUSD: { desk: 'CRYPTO', group: 'CRYPTO', label: 'Solana / USD', digits: 2, pointSize: 0.01, pipSize: 0.10, tickSize: 0.01, contractSize: 1, quoteCcy: 'USD', volumeMin: 0.01, volumeStep: 0.01, slippagePoints: 10, roundStep: 5, specNote: '1 SOL/lot (verify)', verified: true },
  XRPUSD: { desk: 'CRYPTO', group: 'CRYPTO', label: 'Ripple / USD', digits: 4, pointSize: 0.0001, pipSize: 0.001, tickSize: 0.0001, contractSize: 100, quoteCcy: 'USD', volumeMin: 0.01, volumeStep: 0.01, slippagePoints: 10, roundStep: 0.05, specNote: '100 XRP/lot (verify)', verified: true },
  BNBUSD: { desk: 'CRYPTO', group: 'CRYPTO', label: 'BNB / USD', digits: 2, pointSize: 0.01, pipSize: 0.10, tickSize: 0.01, contractSize: 1, quoteCcy: 'USD', volumeMin: 0.01, volumeStep: 0.01, slippagePoints: 15, roundStep: 10, specNote: '1 BNB/lot (verify)', verified: true },
  LTCUSD: { desk: 'CRYPTO', group: 'CRYPTO', label: 'Litecoin / USD', digits: 2, pointSize: 0.01, pipSize: 0.10, tickSize: 0.01, contractSize: 1, quoteCcy: 'USD', volumeMin: 0.01, volumeStep: 0.01, slippagePoints: 10, roundStep: 5, specNote: '1 LTC/lot (verify)', verified: true },
};

export const SUPPORTED_SYMBOLS = Object.keys(SYMBOL_SPECS);

export const TIMEFRAME_ORDER: TimeframeKey[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];

export const TF_PROFILES: Record<TimeframeKey, TimeframeProfile> = {
  M1: { biquote: '1m', seconds: 60, label: 'M1', role: 'Fast Scalp', htf: 'M5', mtfChain: ['M5', 'M15', 'H1'], cooldownBars: 3, maxSpreadRatioAtr: 0.45, bosLookback: 22 },
  M5: { biquote: '5m', seconds: 300, label: 'M5', role: 'Scalp Momentum', htf: 'M15', mtfChain: ['M15', 'H1', 'H4'], cooldownBars: 2, maxSpreadRatioAtr: 0.40, bosLookback: 20 },
  M15: { biquote: '15m', seconds: 900, label: 'M15', role: 'Intraday Setup', htf: 'H1', mtfChain: ['H1', 'H4', 'D1', 'W1'], cooldownBars: 2, maxSpreadRatioAtr: 0.35, bosLookback: 18 },
  M30: { biquote: '30m', seconds: 1800, label: 'M30', role: 'Intraday Swing', htf: 'H4', mtfChain: ['H1', 'H4', 'D1', 'W1'], cooldownBars: 2, maxSpreadRatioAtr: 0.35, bosLookback: 16 },
  H1: { biquote: '1h', seconds: 3600, label: 'H1', role: 'HTF Structure', htf: 'H4', mtfChain: ['H4', 'D1', 'W1'], cooldownBars: 1, maxSpreadRatioAtr: 0.35, bosLookback: 16 },
  H4: { biquote: '4h', seconds: 14400, label: 'H4', role: 'Major Key Levels', htf: 'D1', mtfChain: ['D1', 'W1'], cooldownBars: 1, maxSpreadRatioAtr: 0.35, bosLookback: 14 },
  D1: { biquote: '1d', seconds: 86400, label: 'D1', role: 'Macro Bias', htf: 'W1', mtfChain: ['W1'], cooldownBars: 1, maxSpreadRatioAtr: 0.35, bosLookback: 14 },
  W1: { biquote: '1d', seconds: 604800, label: 'W1', role: 'Weekly Macro', htf: 'W1', mtfChain: [], cooldownBars: 1, maxSpreadRatioAtr: 0.35, bosLookback: 12 },
};

export interface TranslationSet {
  subtitle: string;
  goldLabel: string;
  profileTitle: string;
  marketSessions: string;
  riskTitle: string;
  lblBalance: string;
  lblRiskPct: string;
  lblDailyLimit: string;
  lblContractMode: string;
  lblCommission: string;
  selectTF: string;
  candleClose: string;
  signalRule: string;
  matrixTitle: string;
  winrate: string;
  entryPrice: string;
  chartTitle: string;
  signalHistory: string;
  traderTipTitle: string;
  rule1Title: string;
  rule1Desc: string;
  rule2Title: string;
  rule2Desc: string;
  rule3Title: string;
  rule3Desc: string;
  rule4Title: string;
  rule4Desc: string;
  modalTitle: string;
  modalDesc: string;
  apiBtn: string;
  refreshBtn: string;
  alertOn: string;
  alertOff: string;
  copySignal: string;
}

export const TRANSLATIONS: Record<LangCode, TranslationSet> = {
  en: {
    subtitle: 'Momentum + Squeeze Breakout + Key Levels · Zero Lag',
    goldLabel: 'Active Instrument',
    profileTitle: 'Market Quality & Squeeze',
    marketSessions: 'Market Hours (UTC)',
    riskTitle: 'Risk Supporter (Non-Blocking Lot & Cost Advisor)',
    lblBalance: 'Equity ($ USD)',
    lblRiskPct: 'Base Risk (%)',
    lblDailyLimit: 'Daily Cap (%)',
    lblContractMode: 'Contract',
    lblCommission: 'Comm ($/lot)',
    selectTF: 'Timeframe:',
    candleClose: 'Next Bar Close (UTC)',
    signalRule: 'Auto-syncs on candle close',
    matrixTitle: 'Pre-Market Key-Level Map & If–Then Scenarios',
    winrate: 'Confluence',
    entryPrice: 'ENTRY',
    chartTitle: 'Key Levels + Fast EMA 8/21 + ICT',
    signalHistory: 'Signal History',
    traderTipTitle: '3 Fast Strategies Included',
    rule1Title: 'Momentum Impulse:',
    rule1Desc: 'EMA 8/21 + MACD Histogram cross catches early trend moves quickly.',
    rule2Title: 'Squeeze Breakout:',
    rule2Desc: 'Detects Bollinger-inside-Keltner compression popping with impulse.',
    rule3Title: 'Key-Level S/R + Anti-Spike:',
    rule3Desc: 'Bounces or breaks S1/R1 directly (only blocks extreme >3.2x ATR blow-off spikes).',
    rule4Title: 'TP1 = 0.85R–0.90R Quick BE:',
    rule4Desc: 'High hit-rate TP1 so you secure profit & move SL to Breakeven fast before TP2/TP3.',
    modalTitle: 'NETHAGA QA Suite & Diagnostics',
    modalDesc: 'Verifies Momentum, Squeeze, Anti-Spike, Key Levels, W1 aggregation, Freshness, and Live BIQUOTE Forex + Crypto.',
    apiBtn: 'QA',
    refreshBtn: 'Refresh',
    alertOn: '20m: ON',
    alertOff: '20m: OFF',
    copySignal: 'Copy',
  },
  kh: {
    subtitle: 'យុទ្ធសាស្ត្រលឿន Momentum + Squeeze + Key Levels · គ្មាន Lag',
    goldLabel: 'គូកំពុងវិភាគ',
    profileTitle: 'គុណភាពទីផ្សារ & SQUEEZE',
    marketSessions: 'ម៉ោងទីផ្សារ (UTC)',
    riskTitle: 'ជំនួយការគណនា Lot & ថ្លៃដើម (មិនបិទ Signal ទេ)',
    lblBalance: 'ដើមទុន ($)',
    lblRiskPct: 'Risk (%)',
    lblDailyLimit: 'កម្រិតថ្ងៃ (%)',
    lblContractMode: 'Contract',
    lblCommission: 'កម្រៃ ($/lot)',
    selectTF: 'Timeframe:',
    candleClose: 'ទៀនបន្ទាប់បិទ (UTC)',
    signalRule: 'ទាញទៀនថ្មីស្វ័យប្រវត្តិពេលបិទទៀន',
    matrixTitle: 'ផែនទី Key Level អនាគត & ផែនការ ២ ផ្លូវ',
    winrate: 'ភាពស្របគ្នា',
    entryPrice: 'តម្លៃចូល',
    chartTitle: 'ក្រាហ្វ Key Levels + Fast EMA 8/21 + ICT',
    signalHistory: 'ប្រវត្តិ Signal',
    traderTipTitle: 'យុទ្ធសាស្ត្រលឿន ៣ បែប',
    rule1Title: 'Momentum Impulse:',
    rule1Desc: 'EMA 8/21 + MACD ចាប់ចលនា Trend លឿនដោយមិនចាំ Pin Bar យូរ។',
    rule2Title: 'Squeeze Breakout:',
    rule2Desc: 'ចាប់ពេលទីផ្សារប្រមូលកម្លាំងរួចផ្ទុះចេញ (ខ្លាំងពេល News/Breakout)។',
    rule3Title: 'Key-Level S/R + Anti-Spike:',
    rule3Desc: 'ចូលភ្លាមតាម Bounce ឬ Breakout S1/R1 (ទប់ស្កាត់តែ Spike ហួសកម្រិត >3.2x ATR ប៉ុណ្ណោះ)។',
    rule4Title: 'TP1 = 0.85R–0.90R លឿន៖',
    rule4Desc: 'ប៉ះ TP1 មានភាគរយខ្ពស់ និងលឿន ដើម្បីរំកិល SL ទៅ Breakeven មុនរត់ទៅ TP2/TP3។',
    modalTitle: 'តេស្ត ២០ ចំណុច & ត្រួតពិនិត្យ',
    modalDesc: 'តេស្ត Momentum, Squeeze, Anti-Spike, Key Levels, W1 និង Live BIQUOTE Forex + Crypto។',
    apiBtn: 'QA តេស្ត',
    refreshBtn: 'ផ្ទុកឡើងវិញ',
    alertOn: '20m: បើក',
    alertOff: '20m: បិទ',
    copySignal: 'ចម្លង',
  },
};
