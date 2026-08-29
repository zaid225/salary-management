// Treasury/EWA cash prediction - deterministic, same Rule #1 discipline as
// payroll-engine.ts: this is arithmetic over numbers already on the books
// (known obligations, pending requests, accrual headroom), never an LLM
// guessing at a future balance. No AI anywhere in this file.
//
// SCOPE NOTE: this app has no real bank/treasury account integration, so
// "current cash balance" is an admin-supplied figure (what the real bank
// balance is today), not something read from a ledger table - the ledger
// (ledgerEvents/ledgerBalances) records money that has already moved
// through this app, not the employer's actual bank balance, which also
// moves from things this app knows nothing about (revenue, other
// expenses). This forecasts forward from a stated starting point using
// only obligations this app actually knows about.

export type Minor = number;

export interface TreasuryForecastInput {
  startingCashBalanceMinor: Minor; // admin-supplied real balance "as of today"
  knownObligationsMinor: Minor; // calculated-but-not-yet-posted payroll run totals - near-certain
  pendingEwaMinor: Minor; // pending EWA requests, org-wide - could be approved at any time
  potentialAdditionalEwaMinor: Minor; // remaining max-advance headroom this period across employees who haven't requested yet - the stress-test tail
}

export interface TreasuryForecastResult {
  projectedBalanceMinor: Minor; // starting - known obligations - pending EWA
  stressTestBalanceMinor: Minor; // projected - every remaining employee maxing out their advance
  shortfallMinor: Minor; // how far below zero the projected balance falls, 0 if not at risk
  stressShortfallMinor: Minor;
  atRisk: boolean; // projectedBalanceMinor < 0
  stressAtRisk: boolean;
}

export function computeTreasuryForecast(input: TreasuryForecastInput): TreasuryForecastResult {
  const projectedBalanceMinor =
    input.startingCashBalanceMinor - input.knownObligationsMinor - input.pendingEwaMinor;
  const stressTestBalanceMinor = projectedBalanceMinor - input.potentialAdditionalEwaMinor;

  return {
    projectedBalanceMinor,
    stressTestBalanceMinor,
    shortfallMinor: Math.max(0, -projectedBalanceMinor),
    stressShortfallMinor: Math.max(0, -stressTestBalanceMinor),
    atRisk: projectedBalanceMinor < 0,
    stressAtRisk: stressTestBalanceMinor < 0,
  };
}
