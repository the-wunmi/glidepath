/** A source of uniform floats in [0, 1). Seeded in the study so every run gives the same numbers. */
export type Rng = () => number;

/**
 * Mulberry32: a small, fast 32-bit PRNG. It is not cryptographic, and does not need to be: it stands
 * in for the enclave's secret randomness only so the replay is reproducible.
 */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** FNV-1a hash of a string, used to give each event its own seed stream. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Uniform integer in [0, bound). */
export const randomIndex = (bound: number, rng: Rng): number => Math.floor(rng() * bound);
