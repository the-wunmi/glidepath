import { readFileSync } from 'node:fs';
import { fromBase64 } from '@glidepath/core';
import { describe, expect, it } from 'vitest';
import {
  appraiseTcb,
  type CollateralCheck,
  type CollateralCheckId,
  collateralRequest,
  type PcsCollateral,
  parseCrl,
  pckPlatform,
  UnknownFormat,
  verifyCollateral,
} from '../src/collateral.ts';
import { parseCertificate, parseTdxQuote, pemCertificates } from '../src/tdx.ts';

const file = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url));
const text = (path: string) => file(path).toString('utf8');

/** OutLayer's key-proof quote (the machine every current build runs on: FMSPC B0C06F000000). */
const quote = parseTdxQuote(
  fromBase64(
    JSON.parse(text('data/outlayer/attestation-cxmt7H2q7p83PWaJzR1RWQij8VyhjbjGkkf3ZyZGnVo.json'))
      .tdx_quote,
  ),
);

/** Intel PCS responses for that machine, fetched 2026-11-14 (data/intel-pcs). */
const collateral: PcsCollateral = {
  tcbInfo: {
    body: text('data/intel-pcs/tdx-tcb-info-B0C06F000000.json'),
    issuerChain: text('data/intel-pcs/tdx-tcb-info-issuer-chain.pem'),
  },
  qeIdentity: {
    body: text('data/intel-pcs/tdx-qe-identity.json'),
    issuerChain: text('data/intel-pcs/tdx-qe-identity-issuer-chain.pem'),
  },
  pckCrl: new Uint8Array(file('data/intel-pcs/pck-crl-platform.der')),
  rootCaCrl: new Uint8Array(file('data/intel-pcs/root-ca-crl.der')),
};
/** After both documents were issued (17:24 and 17:40 UTC) and before any of them lapses. */
const NOW = new Date('2026-11-14T18:00:00Z');

const tcbInfo = JSON.parse(collateral.tcbInfo.body).tcbInfo;
const qeIdentity = JSON.parse(collateral.qeIdentity.body).enclaveIdentity;
const platform = pckPlatform(parseCertificate(pemCertificates(quote.pckChainPem)[0]!));

const results = (c: PcsCollateral, now = NOW) =>
  Object.fromEntries(verifyCollateral(quote, c, { now }).checks.map((x) => [x.id, x])) as Record<
    CollateralCheckId,
    CollateralCheck
  >;

/** Flips one bit of the character at `at` (a hex digit stays a hex digit). */
const flipText = (s: string, at: number) =>
  s.slice(0, at) + String.fromCharCode(s.charCodeAt(at) ^ 0x01) + s.slice(at + 1);
const flipBytes = (b: Uint8Array, at: number) => {
  const out = b.slice();
  out[at] = (out[at] ?? 0) ^ 0x01;
  return out;
};

describe('Intel PCS collateral', () => {
  it('reads what the quote needs from its PCK certificate', () => {
    expect(collateralRequest(quote)).toEqual({ fmspc: 'B0C06F000000', ca: 'platform' });
    expect(platform).toEqual({
      fmspc: 'B0C06F000000',
      pceId: '0000',
      sgxTcbComponents: [4, 4, 2, 2, 4, 1, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0],
      pceSvn: 11,
    });
  });

  it('parses Intel’s CRLs', () => {
    const pck = parseCrl(collateral.pckCrl);
    expect(pck.revoked.size).toBeGreaterThan(10);
    expect(pck.revoked.has('6fc34e5023e728923435d61aa4b83c618166ad35')).toBe(true);
    expect(pck.nextUpdate?.toISOString()).toBe('2026-12-14T17:28:57.000Z');
    const root = parseCrl(collateral.rootCaCrl);
    expect(root.revoked.size).toBe(0);
    expect(root.nextUpdate?.toISOString()).toBe('2027-02-26T13:04:00.000Z');
  });

  it('the live machine: nothing revoked, TCB up to date', () => {
    const v = verifyCollateral(quote, collateral, { now: NOW });
    expect(v.checks.map((c) => [c.id, c.ok, c.warn ?? false])).toEqual([
      ['revocation', true, false],
      ['tcb_status', true, false],
    ]);
    expect(v.tcb).toMatchObject({
      status: 'UpToDate',
      issueDate: '2026-11-14T17:40:02Z',
      tcbDate: '2025-08-13T00:00:00Z',
      moduleStatus: 'UpToDate',
      qeStatus: 'UpToDate',
      advisoryIds: [],
    });
    expect(v.checks[1]?.label).toBe(
      'Platform patch level (TCB): up to date as of Intel’s 2026-11-14 data',
    );
  });

  describe('a flipped byte in a signed body fails', () => {
    it('TCB Info', () => {
      const at = collateral.tcbInfo.body.indexOf('"tcbEvaluationDataNumber":20') + 27;
      const r = results({
        ...collateral,
        tcbInfo: { ...collateral.tcbInfo, body: flipText(collateral.tcbInfo.body, at) },
      });
      expect(r.tcb_status.ok).toBe(false);
      expect(r.tcb_status.detail).toMatch(/signature over the tcbInfo does not verify/);
      expect(r.revocation.ok).toBe(true);
    });

    it('TCB Info’s signature', () => {
      const body = collateral.tcbInfo.body;
      const r = results({
        ...collateral,
        tcbInfo: { ...collateral.tcbInfo, body: flipText(body, body.length - 5) },
      });
      expect(r.tcb_status.ok).toBe(false);
    });

    it('QE Identity', () => {
      const at = collateral.qeIdentity.body.indexOf('"isvsvn":4') + 9;
      const r = results({
        ...collateral,
        qeIdentity: { ...collateral.qeIdentity, body: flipText(collateral.qeIdentity.body, at) },
      });
      expect(r.tcb_status.ok).toBe(false);
      expect(r.tcb_status.detail).toMatch(/enclaveIdentity does not verify/);
    });

    it('the TCB Signing certificate in the issuer chain', () => {
      const chain = collateral.tcbInfo.issuerChain;
      const r = results({
        ...collateral,
        tcbInfo: {
          ...collateral.tcbInfo,
          issuerChain: flipText(chain, chain.indexOf('MII') + 200),
        },
      });
      expect(r.tcb_status.ok).toBe(false);
    });

    it('the PCK CRL (its revoked list)', () => {
      const r = results({ ...collateral, pckCrl: flipBytes(collateral.pckCrl, 300) });
      expect(r.revocation.ok).toBe(false);
      expect(r.revocation.detail).toMatch(/CRL signature does not verify/);
      expect(r.tcb_status.ok).toBe(true);
    });

    it('the Root CA CRL', () => {
      const r = results({ ...collateral, rootCaCrl: flipBytes(collateral.rootCaCrl, 120) });
      expect(r.revocation.ok).toBe(false);
    });
  });

  it('collateral swapped between kinds or for another CA fails', () => {
    // The Root CA's CRL in place of the PCK CA's: wrong issuer.
    expect(results({ ...collateral, pckCrl: collateral.rootCaCrl }).revocation.ok).toBe(false);
    // QE Identity served as TCB Info.
    expect(results({ ...collateral, tcbInfo: collateral.qeIdentity }).tcb_status.ok).toBe(false);
  });

  it('collateral past its nextUpdate fails', () => {
    const later = new Date('2026-12-15T00:00:00Z');
    const r = results(collateral, later);
    expect(r.revocation.ok).toBe(false);
    expect(r.tcb_status.ok).toBe(false);
    expect(r.tcb_status.detail).toMatch(/not current/);
  });
});

describe('TCB appraisal (Intel’s TDX rules)', () => {
  /** The quote with its TEE_TCB_SVN replaced. */
  const withTee = (hex: string) => ({ ...quote, body: { ...quote.body, teeTcbSvn: hex } });
  const LIVE_TEE = '0e010400000000000000000000000000';

  it('matches the first level all components meet', () => {
    expect(quote.body.teeTcbSvn).toBe(LIVE_TEE);
    expect(appraiseTcb(quote, platform, tcbInfo, qeIdentity).status).toBe('UpToDate');
  });

  it('an older TDX late microcode (component 3) is out of date, with Intel’s advisories', () => {
    const a = appraiseTcb(
      withTee('0e010300000000000000000000000000'),
      platform,
      tcbInfo,
      qeIdentity,
    );
    expect(a.status).toBe('OutOfDate');
    expect(a.tcbDate).toBe('2025-05-14T00:00:00Z');
    expect(a.advisoryIds).toEqual([
      'INTEL-SA-01192',
      'INTEL-SA-01245',
      'INTEL-SA-01312',
      'INTEL-SA-01313',
    ]);
  });

  it('an older SGX component or PCESVN in the PCK certificate is out of date', () => {
    const older = { ...platform, sgxTcbComponents: [3, 3, ...platform.sgxTcbComponents.slice(2)] };
    expect(appraiseTcb(quote, older, tcbInfo, qeIdentity).status).toBe('OutOfDate');
    // PCESVN 10 meets only Intel's 2018 level (PCESVN 5); below every level nothing matches.
    const pce = appraiseTcb(quote, { ...platform, pceSvn: 10 }, tcbInfo, qeIdentity);
    expect([pce.status, pce.tcbDate]).toEqual(['OutOfDate', '2018-01-04T00:00:00Z']);
    expect(pce.advisoryIds).toContain('INTEL-SA-00106');
    expect(() => appraiseTcb(quote, { ...platform, pceSvn: 4 }, tcbInfo, qeIdentity)).toThrow(
      /No TCB level/,
    );
  });

  it('an out-of-date TDX module makes an up-to-date platform out of date', () => {
    // Module version 1 (TDX_01) at SVN 6: listed as OutOfDate.
    const a = appraiseTcb(
      withTee('06010400000000000000000000000000'),
      platform,
      tcbInfo,
      qeIdentity,
    );
    expect(a.moduleStatus).toBe('OutOfDate');
    expect(a.status).toBe('OutOfDate');
    expect(a.advisoryIds).toContain('INTEL-SA-01192');
    // A module version Intel does not list fails.
    expect(() =>
      appraiseTcb(withTee('0e070400000000000000000000000000'), platform, tcbInfo, qeIdentity),
    ).toThrow(/TDX_07/);
  });

  it('a newer format of Intel’s data is reported as unknown, not as a failed machine', () => {
    expect(() => appraiseTcb(quote, platform, { ...tcbInfo, version: 4 }, qeIdentity)).toThrow(
      UnknownFormat,
    );
    expect(() => appraiseTcb(quote, platform, tcbInfo, { ...qeIdentity, version: 3 })).toThrow(
      UnknownFormat,
    );
  });

  it('an out-of-date quoting enclave makes the platform out of date', () => {
    const qe = { ...qeIdentity, tcbLevels: [{ ...qeIdentity.tcbLevels[0], tcb: { isvsvn: 7 } }] };
    expect(quote.qeReport.isvSvn).toBe(6);
    const a = appraiseTcb(quote, platform, tcbInfo, qe);
    expect(a.qeStatus).toBe('OutOfDate');
    expect(a.status).toBe('OutOfDate');
  });

  it('carries Intel’s other statuses through, and revocation wins', () => {
    const level = (tcbStatus: string) => ({
      ...tcbInfo,
      tcbLevels: [{ ...tcbInfo.tcbLevels[0], tcbStatus, advisoryIDs: ['INTEL-SA-00000'] }],
    });
    const status = (s: string) => appraiseTcb(quote, platform, level(s), qeIdentity);
    expect(status('SWHardeningNeeded')).toMatchObject({
      status: 'SWHardeningNeeded',
      advisoryIds: ['INTEL-SA-00000'],
    });
    expect(status('ConfigurationNeeded').status).toBe('ConfigurationNeeded');
    expect(status('Revoked').status).toBe('Revoked');
    expect(() => status('Fine')).toThrow(/Unknown TCB status/);
    const qeOld = {
      ...qeIdentity,
      tcbLevels: [{ ...qeIdentity.tcbLevels[0], tcb: { isvsvn: 9 } }],
    };
    expect(appraiseTcb(quote, platform, level('ConfigurationNeeded'), qeOld).status).toBe(
      'OutOfDateConfigurationNeeded',
    );
  });

  it('refuses TCB Info for another machine and a quoting enclave that is not Intel’s', () => {
    expect(() =>
      appraiseTcb(quote, platform, { ...tcbInfo, fmspc: '00906ED50000' }, qeIdentity),
    ).toThrow(/FMSPC/);
    expect(() =>
      appraiseTcb(quote, platform, tcbInfo, { ...qeIdentity, mrsigner: '00'.repeat(32) }),
    ).toThrow(/TD_QE identity/);
  });

  it('a non-UpToDate status is a warning that names it; Revoked is a failure', () => {
    // Re-signing is impossible, so this runs the row logic through a quote whose TDX
    // microcode component is older than Intel's current level.
    const v = verifyCollateral(withTee('0e010300000000000000000000000000'), collateral, {
      now: NOW,
    });
    const row = v.checks.find((c) => c.id === 'tcb_status');
    expect(row).toMatchObject({ ok: true, warn: true });
    expect(row?.label).toBe(
      'Platform patch level (TCB): out of date as of Intel’s 2026-11-14 data',
    );
    expect(row?.detail).toMatch(/OutOfDate.*INTEL-SA-01313/);
  });
});
