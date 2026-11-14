/**
 * Blind trust (prototype) cases for `pnpm enclave:wasi`: the mandate rules and the rebalance
 * decision, computed by the TypeScript code (`@vsp/trust`) and compared with the Rust module's
 * `trust_check_mandate` and `trust_rebalance` answers.
 */
import {
  type AssetPrice,
  checkMandateEnvelope,
  type DecideInput,
  decideRebalance,
  type Holding,
  mandateProblems,
  parseMandate,
  type TrustCounters,
  type TrustEnvelope,
  type TrustMandateInput,
} from '@vsp/trust';

export interface TrustCase {
  name: string;
  input: Record<string, unknown>;
  result: unknown;
}

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const id = (token: string) => `nep141:${token}.near`;
const units = (whole: number, decimals = 18) =>
  (BigInt(whole) * 10n ** BigInt(decimals)).toString();

const MANDATE: TrustMandateInput = {
  version: 1,
  universe: [
    { asset: id('idx'), sector: 'broad' },
    { asset: id('bond'), sector: 'bonds' },
    { asset: id('gold'), sector: 'commodities' },
    { asset: id('oil'), sector: 'energy' },
  ],
  excluded_sectors: ['energy'],
  targets: [
    { asset: id('idx'), weight_bps: 6_000 },
    { asset: id('bond'), weight_bps: 4_000 },
  ],
  band_bps: 500,
  max_trade_usd: '500',
  min_trade_usd: '10',
  beneficiary: 'official.near',
  end: '2027-11-15T00:00:00.000Z',
};

const ENVELOPE: TrustEnvelope = {
  excluded_assets: [id('oil')],
  period_ms: DAY,
  max_turnover_usd_e6: '1000000000',
  min_gap_ms: 3_600_000,
};

const COUNTERS: TrustCounters = {
  start_ms: NOW - 10 * DAY,
  period_index: 10,
  turnover_in_period_usd_e6: '0',
  last_trade_ms: null,
};

const PRICES: AssetPrice[] = [
  { asset: id('idx'), price_usd_e6: '2000000' },
  { asset: id('bond'), price_usd_e6: '1000000' },
  { asset: id('gold'), price_usd_e6: '2500123456' },
  { asset: id('oil'), price_usd_e6: '75500000' },
];

const hold = (token: string, whole: number, decimals = 18): Holding => ({
  asset: id(token),
  amount: units(whole, decimals),
  decimals,
});

export function trustCases(): TrustCase[] {
  const cases: TrustCase[] = [];
  const mandate = parseMandate(MANDATE);

  // The mandate's own rules and the envelope checks.
  const variants: [string, Partial<TrustMandateInput>, Partial<TrustEnvelope>][] = [
    ['valid', {}, {}],
    [
      'weights not 100%',
      {
        targets: [
          { asset: id('idx'), weight_bps: 6_000 },
          { asset: id('bond'), weight_bps: 3_000 },
        ],
      },
      {},
    ],
    [
      'repeated asset',
      {
        universe: [
          { asset: id('idx'), sector: 'broad' },
          { asset: id('idx'), sector: 'broad' },
          { asset: id('bond'), sector: 'bonds' },
        ],
      },
      {},
    ],
    ['target outside the universe', { universe: [{ asset: id('idx'), sector: 'broad' }] }, {}],
    ['target in an excluded sector', { excluded_sectors: ['energy', 'bonds'] }, {}],
    ['smallest above largest', { min_trade_usd: '600', max_trade_usd: '500.5' }, {}],
    ['largest is zero', { min_trade_usd: '0', max_trade_usd: '0.000000' }, {}],
    ['target publicly excluded', {}, { excluded_assets: [id('oil'), id('bond')] }],
    ['largest trade above the cap', { max_trade_usd: '1000.000001' }, {}],
  ];
  for (const [label, over, envOver] of variants) {
    const m = parseMandate({ ...MANDATE, ...over });
    const envelope = { ...ENVELOPE, ...envOver };
    cases.push({
      name: `trust_check_mandate ${label}`,
      input: { op: 'trust_check_mandate', mandate: m, envelope },
      result: {
        problems: mandateProblems(m),
        checks: checkMandateEnvelope(m, envelope).map((c) => ({ rule: c.rule, ok: c.ok })),
      },
    });
  }

  // Rebalance decisions.
  const scenarios: [string, Partial<DecideInput>][] = [
    ['all in the index: capped by the largest trade', { holdings: [hold('idx', 1_000)] }],
    ['on target', { holdings: [hold('idx', 600), hold('bond', 800)] }],
    ['drift inside the band', { holdings: [hold('idx', 620), hold('bond', 760)] }],
    ['drift beyond the band', { holdings: [hold('idx', 700), hold('bond', 600)] }],
    [
      'an excluded holding is sold whatever the band',
      { holdings: [hold('idx', 600), hold('bond', 800), hold('oil', 1)] },
    ],
    [
      'a holding outside the targets is sold',
      { holdings: [hold('idx', 600), hold('bond', 800), hold('gold', 1, 8)] },
    ],
    [
      'minimum gap since the last trade',
      { holdings: [hold('idx', 1_000)], counters: { ...COUNTERS, last_trade_ms: NOW - 60_000 } },
    ],
    [
      'turnover cap used this period',
      {
        holdings: [hold('idx', 1_000)],
        counters: { ...COUNTERS, turnover_in_period_usd_e6: '1000000000' },
      },
    ],
    [
      'a new period resets the turnover',
      {
        holdings: [hold('idx', 1_000)],
        counters: { ...COUNTERS, period_index: 9, turnover_in_period_usd_e6: '1000000000' },
      },
    ],
    [
      'the rest of the cap limits the trade',
      {
        holdings: [hold('idx', 1_000)],
        counters: { ...COUNTERS, turnover_in_period_usd_e6: '876543210' },
      },
    ],
    ['no price for a holding', { holdings: [hold('idx', 600), hold('silver', 5)] }],
    ['nothing held', { holdings: [hold('idx', 0)] }],
    [
      'a target the envelope now excludes is sold',
      {
        holdings: [hold('idx', 600), hold('bond', 800)],
        envelope: { ...ENVELOPE, excluded_assets: [id('oil'), id('bond')] },
      },
    ],
    [
      'every target excluded',
      {
        holdings: [hold('idx', 600)],
        envelope: { ...ENVELOPE, excluded_assets: [id('idx'), id('bond')] },
      },
    ],
    ['too small to trade', { holdings: [hold('idx', 10)] }],
    ['before the trust starts', { holdings: [hold('idx', 1_000)], now_ms: COUNTERS.start_ms - 1 }],
    [
      'odd decimals and prices round down',
      {
        holdings: [hold('idx', 333, 6), hold('bond', 1, 24)],
        prices: [
          { asset: id('idx'), price_usd_e6: '1234567' },
          { asset: id('bond'), price_usd_e6: '999999' },
        ],
      },
    ],
  ];
  for (const [label, over] of scenarios) {
    const input: DecideInput = {
      mandate,
      envelope: ENVELOPE,
      counters: COUNTERS,
      holdings: [],
      prices: PRICES,
      now_ms: NOW,
      ...over,
    };
    cases.push({
      name: `trust_rebalance ${label}`,
      input: { op: 'trust_rebalance', ...input },
      result: decideRebalance(input),
    });
  }
  return cases;
}
