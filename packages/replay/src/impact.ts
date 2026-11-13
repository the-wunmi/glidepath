/**
 * Square-root market impact: selling notional Q in a day whose total traded notional is V moves the
 * average execution price against the seller by
 *
 *   impact = Y * sigma_daily * sqrt(Q / V)
 *
 * (Torre/Barra; Almgren et al. 2005; Toth et al. 2011 find Y of order 1 across markets). This is a
 * model, not an observation: the study reports results for several Y values.
 */
export interface ImpactModel {
  /** Y, the dimensionless impact coefficient. */
  coefficient: number;
  /** Daily volatility of the token (standard deviation of daily log returns). */
  dailyVolatility: number;
  /**
   * Caps the modelled price concession so a day where the sale dwarfs the market cannot produce a
   * cost above the proceeds; such days are flagged by their participation rate instead.
   */
  maxFraction: number;
}

/** Fraction of proceeds lost to impact when selling `notional` against `dailyVolume` (both USD). */
export function impactFraction(model: ImpactModel, notional: number, dailyVolume: number): number {
  if (notional <= 0) return 0;
  if (dailyVolume <= 0) return model.maxFraction;
  const raw = model.coefficient * model.dailyVolatility * Math.sqrt(notional / dailyVolume);
  return Math.min(model.maxFraction, raw);
}
