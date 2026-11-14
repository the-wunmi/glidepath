import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pcsRoutes } from '../src/pcs.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../data/intel-pcs/${name}`, import.meta.url));
const TCB_INFO = fixture('tdx-tcb-info-B0C06F000000.json');
/** As Intel sends it: URL-encoded PEM. */
const CHAIN = encodeURIComponent(fixture('tdx-tcb-info-issuer-chain.pem').toString());

/** A stand-in for Intel: records each URL asked for and answers like the PCS. */
function intel(answer: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return answer(url);
  }) as typeof fetch;
  return { calls, app: pcsRoutes(fetchImpl) };
}

const tcbAnswer = () =>
  new Response(TCB_INFO, {
    headers: { 'content-type': 'application/json', 'TCB-Info-Issuer-Chain': CHAIN },
  });

describe('Intel PCS pass-through', () => {
  it('passes TCB Info and its issuer chain through byte for byte', async () => {
    const { app, calls } = intel(tcbAnswer);
    const res = await app.request('/tdx/tcb?fmspc=b0c06f000000');
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(TCB_INFO));
    expect(res.headers.get('tcb-info-issuer-chain')).toBe(CHAIN);
    expect(calls).toEqual([
      'https://api.trustedservices.intel.com/tdx/certification/v4/tcb?fmspc=B0C06F000000',
    ]);
  });

  it('asks Intel only for the four documents, built from validated parameters', async () => {
    const { app, calls } = intel(() => new Response(new Uint8Array([0x30, 0x00])));
    expect((await app.request('/tdx/qe-identity')).status).toBe(200);
    expect((await app.request('/pckcrl?ca=processor&encoding=pem')).status).toBe(200);
    expect((await app.request('/rootcacrl')).status).toBe(200);
    expect(calls).toEqual([
      'https://api.trustedservices.intel.com/tdx/certification/v4/qe/identity',
      'https://api.trustedservices.intel.com/sgx/certification/v4/pckcrl?ca=processor&encoding=der',
      'https://certificates.trustedservices.intel.com/IntelSGXRootCA.der',
    ]);
    for (const path of [
      '/tdx/tcb',
      '/tdx/tcb?fmspc=B0C06F00000',
      '/tdx/tcb?fmspc=B0C06F000000%26x=1',
      '/tdx/tcb?fmspc=../../x00000',
      '/pckcrl?ca=root',
      '/pckcrl',
    ])
      expect((await app.request(path)).status, path).toBe(422);
    for (const path of ['/sgx/certification/v4/pckcert', '/tdx/certification/v4/tcb', '/'])
      expect((await app.request(path)).status, path).toBe(404);
    expect(calls).toHaveLength(3);
  });

  it('keeps an answer, but never past its nextUpdate', async () => {
    const { app, calls } = intel(tcbAnswer);
    await app.request('/tdx/tcb?fmspc=B0C06F000000');
    const second = await app.request('/tdx/tcb?fmspc=b0c06f000000');
    expect(second.status).toBe(200);
    expect(calls).toHaveLength(1);
    // The fixture's nextUpdate (2026-12-14) lies beyond the hour kept.
    expect(
      Number(/max-age=(\d+)/.exec(second.headers.get('cache-control') ?? '')?.[1]),
    ).toBeLessThanOrEqual(3600);

    const lapsing = JSON.stringify({
      tcbInfo: { nextUpdate: new Date(Date.now() - 1000).toISOString() },
      signature: '00',
    });
    const stale = intel(
      () => new Response(lapsing, { headers: { 'content-type': 'application/json' } }),
    );
    await stale.app.request('/tdx/tcb?fmspc=B0C06F000000');
    await stale.app.request('/tdx/tcb?fmspc=B0C06F000000');
    expect(stale.calls).toHaveLength(2);
  });

  it('answers Intel’s 404 as 404 and an outage as 503 with a retry hint, remembered briefly', async () => {
    const missing = intel(() => new Response('{}', { status: 404 }));
    expect((await missing.app.request('/tdx/tcb?fmspc=000000000000')).status).toBe(404);

    const down = intel(() => {
      throw new TypeError('fetch failed');
    });
    const res = await down.app.request('/tdx/qe-identity');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    await down.app.request('/tdx/qe-identity');
    expect(down.calls).toHaveLength(1);

    const failing = intel(() => new Response('busy', { status: 500 }));
    expect((await failing.app.request('/rootcacrl')).status).toBe(503);
  });

  it('refuses an answer far larger than any collateral', async () => {
    const { app } = intel(() => new Response(new Uint8Array(300 * 1024)));
    expect((await app.request('/rootcacrl')).status).toBe(503);
  });
});
