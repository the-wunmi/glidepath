import { z } from 'zod';

/** A public page we fetched to confirm an event, with what it supports and when we read it. */
export const EventSource = z.object({
  url: z.url(),
  fetched_at: z.iso.date(),
  supports: z.string().min(1),
});
export type EventSource = z.infer<typeof EventSource>;

/**
 * One publicly scheduled team/investor unlock. Amounts are whole tokens as decimal strings, so the
 * JSON round-trips exactly. `insider_amount` is the part that went to team and investors (the part a
 * sealed plan would be selling); `verification` says whether every number came straight from a
 * source or some were derived by arithmetic on sourced numbers.
 */
export const UnlockEvent = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  token: z.string().min(1),
  symbol: z.string().regex(/^[A-Z0-9]+USDT$/),
  unlock_date: z.iso.date(),
  unlock_amount: z.string().regex(/^\d+$/),
  insider_amount: z.string().regex(/^\d+$/),
  recipients: z.string().min(1),
  share_of_supply: z.object({ pct: z.number(), basis: z.enum(['total', 'circulating']) }),
  share_of_supply_notes: z.string(),
  verification: z.enum(['confirmed', 'partly_derived']),
  verification_notes: z.string(),
  sources: z.array(EventSource).min(1),
});
export type UnlockEvent = z.infer<typeof UnlockEvent>;

const FETCHED = '2026-11-11';

/**
 * The replayed unlocks. Every amount below was read from the linked pages on FETCHED; where a source
 * rounds ("more than 386 million") we use the rounded figure and say so.
 */
export const EVENTS: UnlockEvent[] = z.array(UnlockEvent).parse([
  {
    id: 'arb-2024-03-16',
    token: 'Arbitrum (ARB)',
    symbol: 'ARBUSDT',
    unlock_date: '2024-03-16',
    unlock_amount: '1110000000',
    insider_amount: '1110000000',
    recipients: 'Team, contributors and advisors, and investors (first cliff of the 4-year lockup)',
    share_of_supply: { pct: 11.1, basis: 'total' },
    share_of_supply_notes:
      '1.11B of the 10B initial supply cap. CoinDesk (Aug 2023) put it at 87% of the then circulating supply; FXStreet (Mar 2024) at 76.62% of circulating supply.',
    verification: 'confirmed',
    verification_notes:
      'Total 1.11B and the team-and-investor cliff confirmed by CoinDesk; investor part 438.25M ARB confirmed by FXStreet; the team part (about 672M) is the remainder and was not read from a source directly.',
    sources: [
      {
        url: 'https://www.coindesk.com/markets/2023/08/16/arbitrum-will-unlock-12b-arb-in-march-2024-token-unlocks',
        fetched_at: FETCHED,
        supports: 'Cliff unlock of 1.11 billion ARB for team and investors on March 16, 2024',
      },
      {
        url: 'https://www.fxstreet.com/cryptocurrencies/news/arbitrum-price-readies-for-one-of-the-biggest-token-unlocks-of-2024-202403130200',
        fetched_at: FETCHED,
        supports: '438.25 million ARB to investors; 76.62% of circulating supply',
      },
      {
        url: 'https://docs.arbitrum.foundation/airdrop-eligibility-distribution',
        fetched_at: FETCHED,
        supports:
          '10B initial supply cap; team 26.94%, investors 17.53%; 4-year lockups with first unlocks one year after 3/16/2023',
      },
    ],
  },
  {
    id: 'op-2023-05-31',
    token: 'Optimism (OP)',
    symbol: 'OPUSDT',
    unlock_date: '2023-05-31',
    unlock_amount: '386000000',
    insider_amount: '386000000',
    recipients: 'Core contributors and investors (their first unlock)',
    share_of_supply: { pct: 9, basis: 'total' },
    share_of_supply_notes:
      '9% of total supply (Token Terminal, quoted by Cointelegraph). The Block: 387M tokens, a 114% increase to circulating supply.',
    verification: 'confirmed',
    verification_notes:
      'Sources say "more than 386 million"; we use 386,000,000 (a lower bound). No fetched source gave the contributor/investor split, so it is not recorded.',
    sources: [
      {
        url: 'https://cointelegraph.com/news/optimism-unlock-millions-op-token-may-price-pressure',
        fetched_at: FETCHED,
        supports:
          'More than 386 million OP unlocked May 31; first unlock for core contributors and investors; 9% of total supply',
      },
      {
        url: 'https://www.theblock.co/post/232511/optimism-sui-set-for-large-token-unlocks-worth-a-combined-650-million',
        fetched_at: FETCHED,
        supports: '387 million OP on May 31, split between core contributors and investors',
      },
    ],
  },
  {
    id: 'apt-2023-11-12',
    token: 'Aptos (APT)',
    symbol: 'APTUSDT',
    unlock_date: '2023-11-12',
    unlock_amount: '24840000',
    insider_amount: '20300000',
    recipients:
      'Core contributors 11.88M and investors 8.42M; the remaining 4.54M went to the community and the Aptos Foundation',
    share_of_supply: { pct: 10, basis: 'circulating' },
    share_of_supply_notes: 'About 10% of circulating supply (The Block).',
    verification: 'partly_derived',
    verification_notes:
      'Total 24.84M and cohort amounts read from The Daily Hodl (citing Lookonchain); The Block gives 24.8M on Nov. 12. The insider amount 20.30M is our sum of the core contributor and investor cohorts.',
    sources: [
      {
        url: 'https://www.theblock.co/news/ecosystems/2023-11-01-aptos-avalanche-dominate-450-million-november-token-unlocks-260336',
        fetched_at: FETCHED,
        supports: '24.8 million APT released on Nov. 12; 10% of circulating supply',
      },
      {
        url: 'https://dailyhodl.com/2023/11/13/over-181000000-worth-of-aptos-apt-tokens-unlocked-distributed-to-four-major-cohorts/',
        fetched_at: FETCHED,
        supports:
          '24.84M APT: core contributors 11.88M, investors 8.42M, community 3.21M, foundation 1.33M',
      },
    ],
  },
  {
    id: 'strk-2024-04-15',
    token: 'Starknet (STRK)',
    symbol: 'STRKUSDT',
    unlock_date: '2024-04-15',
    unlock_amount: '64000000',
    insider_amount: '64000000',
    recipients:
      'Early contributors and investors (first monthly unlock after the revised schedule)',
    share_of_supply: { pct: 0.64, basis: 'total' },
    share_of_supply_notes:
      '0.64% of the 10B total supply. The original plan would have released about 1.3B on this date; StarkWare cut it on Feb 22, 2024.',
    verification: 'confirmed',
    verification_notes: 'Amount, recipients and share read from Cointelegraph.',
    sources: [
      {
        url: 'https://cointelegraph.com/news/starkware-changes-controversial-investor-starknet-token-unlock-schedule',
        fetched_at: FETCHED,
        supports:
          '64 million STRK to early contributors and investors on April 15; 0.64% of 10B supply',
      },
    ],
  },
]);

/** The reference asset used to separate token-specific moves from the whole market's. */
export const MARKET_SYMBOL = 'BTCUSDT';
