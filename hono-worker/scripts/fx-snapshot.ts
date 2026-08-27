// A fixed FX snapshot, checked in deliberately: the spec rules out a live FX
// dependency, so analytics stay reproducible and a rate never changes under a
// report that was already generated. Shared by the full seed and seed-fx.
export const FX_SNAPSHOT = [
  { currency: "USD", rateToUsd: "1.000000", asOfDate: "2026-01-01" },
  { currency: "GBP", rateToUsd: "1.270000", asOfDate: "2026-01-01" },
  { currency: "EUR", rateToUsd: "1.090000", asOfDate: "2026-01-01" },
  { currency: "INR", rateToUsd: "0.012000", asOfDate: "2026-01-01" },
  { currency: "CAD", rateToUsd: "0.730000", asOfDate: "2026-01-01" },
  { currency: "AUD", rateToUsd: "0.660000", asOfDate: "2026-01-01" },
  { currency: "SGD", rateToUsd: "0.740000", asOfDate: "2026-01-01" },
];
