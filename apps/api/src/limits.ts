/**
 * A fixed-window counter per key (a client address, or one shared key for a global cap). In
 * memory: the API is one process, and losing the counts on restart only resets the windows.
 */
export class RateLimit {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Counts one hit for the key; false once the key has used up its window. */
  take(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(now);
      return true;
    }
    if (entry.count >= this.max) return false;
    entry.count += 1;
    return true;
  }

  private sweep(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}

/**
 * The rate-limit key for a client address. An IPv6 client usually holds a whole /64, so keying by
 * the full address would give it 2^64 separate budgets; IPv4-mapped addresses count as IPv4.
 */
export function clientKeyOf(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return mapped[1];
  if (!address.includes(':')) return address;
  const [head = '', tail = ''] = address.toLowerCase().split('%')[0]?.split('::') ?? [];
  const left = head ? head.split(':') : [];
  const right = address.includes('::') && tail ? tail.split(':') : [];
  const groups = address.includes('::')
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** Remembers each key's last answer (or failure) for a few seconds, so a burst costs one call. */
export class TtlCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>();

  constructor(
    private readonly ttlMs: number,
    /** Failures are remembered this long; 0 retries at once. */
    private readonly failureTtlMs = 0,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = load();
    const entry = { at: Date.now(), value };
    // Keys can come from a query string; a flood of distinct ones must not grow memory.
    if (this.entries.size >= 1_000) this.entries.clear();
    this.entries.set(key, entry);
    value.catch(() => {
      if (this.entries.get(key) !== entry) return;
      // Kept for failureTtlMs instead of ttlMs: shift its start back by the difference.
      if (this.failureTtlMs <= 0) this.entries.delete(key);
      else entry.at = Date.now() - this.ttlMs + this.failureTtlMs;
    });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
