/** 10th, 50th and 90th percentiles of a simulated quantity across seeds. */
export interface Spread {
  p10: number;
  median: number;
  p90: number;
}

/** Percentile by linear interpolation between closest ranks (the common "type 7" definition). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error('No values');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (rank - lo);
}

export const spread = (values: number[]): Spread => ({
  p10: percentile(values, 10),
  median: percentile(values, 50),
  p90: percentile(values, 90),
});

/** Sample standard deviation. */
export function stdev(values: number[]): number {
  if (values.length < 2) throw new Error('Need at least two values');
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sq = values.reduce((s, v) => s + (v - mean) ** 2, 0);
  return Math.sqrt(sq / (values.length - 1));
}
