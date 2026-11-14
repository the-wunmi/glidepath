'use client';

import Link from 'next/link';

const FACTS = [
  {
    figure: '~90%',
    text: 'of more than 16,000 token unlocks studied by Keyrock pushed the price down, often starting about 30 days before the date.',
    sources: [
      {
        label: 'Keyrock',
        href: 'https://keyrock.com/from-locked-to-liquidity-what-16000-token-unlocks-teach-us/',
      },
      {
        label: 'BeInCrypto summary',
        href: 'https://beincrypto.com/keyrock-research-token-unlocks/',
      },
    ],
  },
  {
    figure: '−25%',
    text: 'is the average price move around team unlocks, the worst category in the same study, partly because teams sell without a coordinated plan.',
    sources: [
      {
        label: 'Keyrock',
        href: 'https://keyrock.com/from-locked-to-liquidity-what-16000-token-unlocks-teach-us/',
      },
    ],
  },
  {
    figure: '$38M',
    text: 'of MOVE was sold the day after listing by a market maker with a hidden contract. Binance banned the account and Movement’s co-founder was terminated.',
    sources: [
      {
        label: 'CoinDesk',
        href: 'https://www.coindesk.com/tech/2025/04/30/the-protocol-inside-movement-s-token-dump-scandal',
      },
      {
        label: 'The Block',
        href: 'https://www.theblock.co/post/353417/movement-labs-terminates-co-founder-rushi-manche-following-controversial-move-token-deals',
      },
    ],
  },
];

const STEPS = [
  {
    title: 'Seal the plan',
    text: 'The founder writes the plan in the browser. The browser checks the enclave’s attestation, encrypts the plan to the enclave’s key and publishes only a salted hash on NEAR.',
  },
  {
    title: 'Lock the tokens',
    text: 'The team allocation is minted straight into a plan account with no keys. Its code obeys only the registry, so nobody, the founder included, can move the tokens directly.',
  },
  {
    title: 'Sell inside the limits',
    text: 'The enclave sells at random times through NEAR Intents (1Click). The registry also enforces a public envelope of caps and a floor on every sale, whatever the enclave says.',
  },
  {
    title: 'Publish a receipt',
    text: 'Every sale leaves a signed receipt that anyone can check in the browser. Any change to the plan is public and waits out a cooling-off period first.',
  },
];

export default function OverviewPage() {
  return (
    <div className="space-y-16">
      <section className="grid gap-10 pt-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] lg:items-start">
        <div>
          <h1 className="max-w-[20ch] text-[2.25rem] leading-[1.08] font-semibold sm:text-[3rem]">
            Token unlocks are cliffs. Glidepath turns them into a glide path anyone can verify.
          </h1>
          <p className="mt-3 text-[1.05rem] font-medium text-accent-text">
            10b5-1-style selling plans for crypto, verified on NEAR.
          </p>
          <p className="mt-5 max-w-[60ch] text-[1.05rem] text-ink-2">
            Founders and investors commit to how they will sell before they sell. The plan stays
            sealed inside an enclave, the tokens sit in an account with no keys, and every sale
            publishes a receipt that proves it followed the plan. Changing or cancelling it waits
            out a public cooling-off first.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/unlock" className="btn btn-primary">
              Case study: ARB’s unlock
            </Link>
            <Link href="/app/new" className="btn btn-secondary">
              Create a plan
            </Link>
            <Link href="/verify" className="btn btn-ghost">
              Verify a plan
            </Link>
          </div>
          <p className="mt-3 max-w-[60ch] text-sm text-ink-3">
            ARB’s March 2024 team and investor cliff, read from the chain, beside the same
            allocation under a sealed plan.
          </p>
        </div>
        <div className="well p-5 lg:mt-3">
          <p className="text-sm font-semibold">What a holder can check, without trusting us</p>
          <ul className="mt-3 space-y-2.5 text-sm text-ink-2">
            <li className="flex gap-2">
              <span className="text-accent">●</span>The plan account has 0 keys, read live from
              NEAR.
            </li>
            <li className="flex gap-2">
              <span className="text-accent">●</span>Which plan is in force: its commitment and when
              it was made.
            </li>
            <li className="flex gap-2">
              <span className="text-accent">●</span>The public caps and floor the registry enforces
              on every sale.
            </li>
            <li className="flex gap-2">
              <span className="text-accent">●</span>Each sale’s signature, enclave and compliance
              answers, checked in the browser.
            </li>
            <li className="flex gap-2">
              <span className="text-accent">●</span>Any pending change, and when its cooling-off
              ends.
            </li>
          </ul>
        </div>
      </section>

      <section aria-labelledby="problem">
        <h2 id="problem" className="text-xl font-semibold">
          Insider selling hurts holders, even when it is honest
        </h2>
        <p className="mt-1 max-w-[70ch] text-ink-2">
          A public schedule gets front-run. A quiet sale cannot be checked. Today insiders have to
          pick one.
        </p>
        <div className="mt-6 grid gap-px overflow-hidden rounded-[10px] border border-rule bg-rule md:grid-cols-3">
          {FACTS.map((f) => (
            <div key={f.figure} className="bg-surface p-5">
              <p className="num text-[2rem] leading-none font-semibold text-ink">{f.figure}</p>
              <p className="mt-3 text-sm text-ink-2">{f.text}</p>
              <p className="mt-3 flex flex-wrap gap-x-3 text-xs">
                {f.sources.map((s) => (
                  <a key={s.href} href={s.href} className="link" target="_blank" rel="noreferrer">
                    {s.label}
                  </a>
                ))}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="how">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="how" className="text-xl font-semibold">
            How it works
          </h2>
          <Link href="/how-it-works" className="link text-sm">
            Architecture, guarantees and limits
          </Link>
        </div>
        <ol className="mt-6 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="border-t-2 border-accent pt-4">
              <p className="num text-sm font-semibold text-accent-text">Step {i + 1}</p>
              <h3 className="mt-1 font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-ink-2">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
