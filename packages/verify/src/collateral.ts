/**
 * Intel's PCS collateral for a TDX quote, checked in the browser: revocation (the PCK CRL and the
 * Root CA CRL) and the machine's TCB status (TDX TCB Info and the TD quoting enclave's identity).
 * Intel signs all of it under the same pinned root as the quote, so whoever relays the bytes (our
 * API, since Intel serves them without CORS) can withhold them but not change them unnoticed.
 *
 * Sources: Intel PCS API v4 (https://api.trustedservices.intel.com/documents/PCS_V4.pdf: TDX TCB
 * Info, TDX QE Identity, PCK CRL) and the Root CA CRL at
 * https://certificates.trustedservices.intel.com/IntelSGXRootCA.der (the root certificate's CRL
 * distribution point). TCB matching follows Intel's quote verification library (QVL) for TDX.
 */

import { bytesToHex, hexToBytes } from '@vsp/core';
import {
  type Certificate,
  children,
  derTime,
  ecdsaDer,
  ecdsaRaw,
  INTEL_SGX_ROOT_CA_PUBLIC_KEY,
  integerHex,
  need,
  parseCertificate,
  pemCertificates,
  readTlv,
  SEQUENCE,
  sameBytes,
  type TdxQuote,
  type Tlv,
  verifyPckChain,
} from './tdx.ts';

/** What a browser gets from the PCS pass-through: Intel's bytes, untouched. */
export interface PcsCollateral {
  /** TDX TCB Info response body (JSON text, exactly as Intel sent it) and its issuer chain (PEM). */
  tcbInfo: { body: string; issuerChain: string };
  /** TDX QE Identity response body and its issuer chain. */
  qeIdentity: { body: string; issuerChain: string };
  /** The CRL of the CA that issued the PCK certificate (DER). */
  pckCrl: Uint8Array;
  /** The Intel SGX Root CA's CRL (DER). */
  rootCaCrl: Uint8Array;
}

/** Intel's TCB statuses (TCB Info v3). */
export type TcbStatus =
  | 'UpToDate'
  | 'SWHardeningNeeded'
  | 'ConfigurationNeeded'
  | 'ConfigurationAndSWHardeningNeeded'
  | 'OutOfDate'
  | 'OutOfDateConfigurationNeeded'
  | 'Revoked';

const TCB_STATUSES = new Set<string>([
  'UpToDate',
  'SWHardeningNeeded',
  'ConfigurationNeeded',
  'ConfigurationAndSWHardeningNeeded',
  'OutOfDate',
  'OutOfDateConfigurationNeeded',
  'Revoked',
]);

/** The status in plain words, for the checks list. */
export const TCB_STATUS_WORDS: Record<TcbStatus, string> = {
  UpToDate: 'up to date',
  SWHardeningNeeded: 'up to date, software hardening needed',
  ConfigurationNeeded: 'configuration needed',
  ConfigurationAndSWHardeningNeeded: 'configuration and software hardening needed',
  OutOfDate: 'out of date',
  OutOfDateConfigurationNeeded: 'out of date, configuration needed',
  Revoked: 'revoked',
};

// ── The PCK certificate's Intel SGX extension ──────────────────────────────────────────────────

/** 1.2.840.113741.1.13.1, Intel's SGX extensions in a PCK certificate. */
const SGX_EXT = '2a864886f84d010d01';

export interface PckPlatform {
  fmspc: string;
  pceId: string;
  /** SGX TCB components 1..16, the platform's CPUSVN as Intel's TCB levels compare it. */
  sgxTcbComponents: number[];
  pceSvn: number;
}

const uint = (t: Tlv) => {
  if (t.tag !== 0x02 || t.value.length > 4) throw new Error('PCK extension integer malformed');
  return t.value.reduce((n, b) => n * 256 + b, 0);
};

/** Reads FMSPC, PCE ID and the TCB (16 SGX components and PCESVN) from a PCK certificate. */
export function pckPlatform(pck: Certificate): PckPlatform {
  const ext = pck.extensions.find((e) => e.oid === SGX_EXT);
  if (!ext) throw new Error('PCK certificate has no Intel SGX extension');
  const fields = new Map<string, Tlv>();
  for (const item of children(need(readTlv(ext.value, 0), SEQUENCE, 'SGX extension').value)) {
    const [oid, value] = children(item.value);
    if (oid && value) fields.set(bytesToHex(oid.value), value);
  }
  const tcb = fields.get(`${SGX_EXT}02`);
  const fmspc = fields.get(`${SGX_EXT}04`);
  const pceId = fields.get(`${SGX_EXT}03`);
  if (!tcb || !fmspc || !pceId) throw new Error('PCK certificate lacks FMSPC, PCE ID or TCB');
  const comps = new Map<number, Tlv>();
  for (const item of children(tcb.value)) {
    const [oid, value] = children(item.value);
    const hex = oid ? bytesToHex(oid.value) : '';
    if (value && hex.startsWith(`${SGX_EXT}02`) && hex.length === SGX_EXT.length + 4)
      comps.set(Number.parseInt(hex.slice(-2), 16), value);
  }
  const sgxTcbComponents = Array.from({ length: 16 }, (_, i) => {
    const c = comps.get(i + 1);
    if (!c) throw new Error(`PCK certificate lacks SGX TCB component ${i + 1}`);
    return uint(c);
  });
  const pceSvn = comps.get(17);
  if (!pceSvn) throw new Error('PCK certificate lacks PCESVN');
  return {
    fmspc: bytesToHex(fmspc.value).toUpperCase(),
    pceId: bytesToHex(pceId.value).toUpperCase(),
    sgxTcbComponents,
    pceSvn: uint(pceSvn),
  };
}

/** Which collateral a quote needs: its FMSPC and the CA that issued its PCK certificate. */
export function collateralRequest(quote: TdxQuote): {
  fmspc: string;
  ca: 'platform' | 'processor';
} {
  const [leaf, ca] = pemCertificates(quote.pckChainPem).map(parseCertificate);
  if (!leaf || !ca) throw new Error('Quote carries no PCK chain');
  const name = ca.subjectCn ?? '';
  const which =
    name === 'Intel SGX PCK Platform CA'
      ? 'platform'
      : name === 'Intel SGX PCK Processor CA'
        ? 'processor'
        : null;
  if (!which) throw new Error(`PCK issuer is not an Intel PCK CA (${name})`);
  return { fmspc: pckPlatform(leaf).fmspc, ca: which };
}

// ── CRLs ────────────────────────────────────────────────────────────────────────────────────────

export interface Crl {
  tbs: Uint8Array;
  issuer: Uint8Array;
  thisUpdate: Date;
  nextUpdate: Date | null;
  /** Revoked serial numbers, hex without leading zero bytes. */
  revoked: Set<string>;
  signature: Uint8Array;
}

const isTime = (t: Tlv | undefined) => t?.tag === 0x17 || t?.tag === 0x18;

/** Reads an X.509 CRL (DER) signed with ECDSA-SHA256. */
export function parseCrl(der: Uint8Array): Crl {
  const [tbs, alg, sig] = children(need(readTlv(der, 0), SEQUENCE, 'CRL').value);
  const tbsT = need(tbs, SEQUENCE, 'CRL body');
  const algOid = children(need(alg, SEQUENCE, 'CRL signature algorithm').value)[0];
  if (!algOid || bytesToHex(algOid.value) !== '2a8648ce3d040302')
    throw new Error('CRL is not signed with ECDSA-SHA256');
  const f = children(tbsT.value);
  let i = f[0]?.tag === 0x02 ? 1 : 0;
  need(f[i++], SEQUENCE, 'CRL signature algorithm');
  const issuer = need(f[i++], SEQUENCE, 'CRL issuer');
  const thisUpdate = f[i++];
  if (!thisUpdate || !isTime(thisUpdate)) throw new Error('CRL thisUpdate missing');
  const next = isTime(f[i]) ? f[i++] : undefined;
  const revoked = new Set<string>();
  if (f[i]?.tag === SEQUENCE)
    for (const entry of children((f[i++] as Tlv).value))
      revoked.add(integerHex(need(children(entry.value)[0], 0x02, 'revoked serial')));
  return {
    tbs: tbsT.raw,
    issuer: issuer.raw,
    thisUpdate: derTime(thisUpdate),
    nextUpdate: next ? derTime(next) : null,
    revoked,
    signature: need(sig, 0x03, 'CRL signature').value.subarray(1),
  };
}

/** Why a CRL cannot be used, or null: signed by `signer`, issued by it, and current at `now`. */
function crlProblem(
  crl: Crl,
  signer: Certificate,
  signerKey: Uint8Array,
  now: Date,
): string | null {
  const who = signer.subjectCn ?? 'its CA';
  if (!sameBytes(crl.issuer, signer.subject)) return `The CRL is not issued by ${who}`;
  if (!ecdsaDer(crl.signature, crl.tbs, signerKey)) return `${who}’s CRL signature does not verify`;
  if (now < crl.thisUpdate || (crl.nextUpdate && now > crl.nextUpdate))
    return `${who}’s CRL is not current (${day(crl.thisUpdate)} to ${crl.nextUpdate ? day(crl.nextUpdate) : '?'})`;
  return null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

// ── Signed JSON (TCB Info, QE Identity) ─────────────────────────────────────────────────────────

/**
 * Intel signs the bytes of the inner object exactly as it serializes them in the response, so the
 * body is split as text, never re-serialized. `signature` is r ‖ s, hex.
 */
function signedJson(body: string, field: string): { text: string; signature: Uint8Array } {
  const m = new RegExp(
    `^\\s*\\{"${field}":([\\s\\S]*),"signature":"([0-9a-fA-F]{128})"\\}\\s*$`,
  ).exec(body);
  if (!m?.[1] || !m[2]) throw new Error(`Not a signed ${field} document`);
  return { text: m[1], signature: hexToBytes(m[2]) };
}

/**
 * The TCB Signing chain from an issuer-chain header: TCB Signing certificate → Intel SGX Root CA,
 * the root being the pinned key, both in date. Returns the signing certificate.
 */
function tcbSigner(pem: string, rootKey: Uint8Array, now: Date): Certificate {
  const ders = pemCertificates(pem);
  if (ders.length !== 2)
    throw new Error(`Issuer chain has ${ders.length} certificates, expected 2`);
  const [signer, root] = ders.map(parseCertificate) as [Certificate, Certificate];
  if (!sameBytes(root.publicKey, rootKey))
    throw new Error('Issuer chain root is not Intel’s SGX root');
  if (!ecdsaDer(root.signature, root.tbs, rootKey))
    throw new Error('Root signature does not verify');
  if (
    signer.subjectCn !== 'Intel SGX TCB Signing' ||
    signer.isCa ||
    !sameBytes(signer.issuer, root.subject) ||
    !ecdsaDer(signer.signature, signer.tbs, rootKey)
  )
    throw new Error('The TCB Signing certificate is not signed by Intel’s SGX root');
  for (const c of [signer, root])
    if (now < c.notBefore || now > c.notAfter)
      throw new Error(`${c.subjectCn} is valid ${day(c.notBefore)} to ${day(c.notAfter)}`);
  return signer;
}

function verifySignedJson<T>(
  body: string,
  field: string,
  chain: string,
  rootKey: Uint8Array,
  now: Date,
): { doc: T; signer: Certificate } {
  const signer = tcbSigner(chain, rootKey, now);
  const { text, signature } = signedJson(body, field);
  if (!ecdsaRaw(signature, new TextEncoder().encode(text), signer.publicKey))
    throw new Error(`Intel’s signature over the ${field} does not verify`);
  return { doc: JSON.parse(text) as T, signer };
}

interface Level {
  tcbDate?: string;
  tcbStatus: string;
  advisoryIDs?: string[];
}

interface TcbInfo {
  id: string;
  version: number;
  issueDate: string;
  nextUpdate: string;
  fmspc: string;
  pceId: string;
  tdxModule?: { mrsigner: string; attributes: string; attributesMask: string };
  tdxModuleIdentities?: {
    id: string;
    mrsigner: string;
    attributes: string;
    attributesMask: string;
    tcbLevels: (Level & { tcb: { isvsvn: number } })[];
  }[];
  tcbLevels: (Level & {
    tcb: {
      sgxtcbcomponents: { svn: number }[];
      pcesvn: number;
      tdxtcbcomponents: { svn: number }[];
    };
  })[];
}

interface QeIdentity {
  id: string;
  version: number;
  issueDate: string;
  nextUpdate: string;
  miscselect: string;
  miscselectMask: string;
  attributes: string;
  attributesMask: string;
  mrsigner: string;
  isvprodid: number;
  tcbLevels: (Level & { tcb: { isvsvn: number } })[];
}

function inDate(doc: { issueDate: string; nextUpdate: string }, what: string, now: Date) {
  const from = new Date(doc.issueDate);
  const to = new Date(doc.nextUpdate);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || now < from || now > to)
    throw new Error(`Intel’s ${what} is not current (${doc.issueDate} to ${doc.nextUpdate})`);
}

const masked = (value: Uint8Array, mask: Uint8Array) => value.map((b, i) => b & (mask[i] ?? 0));

function status(s: string): TcbStatus {
  if (!TCB_STATUSES.has(s)) throw new Error(`Unknown TCB status ${s}`);
  return s as TcbStatus;
}

// ── Appraisal ───────────────────────────────────────────────────────────────────────────────────

export interface TcbAppraisal {
  status: TcbStatus;
  /** Intel's TCB Info issue date. */
  issueDate: string;
  /** The matched platform TCB level's date. */
  tcbDate: string | null;
  advisoryIds: string[];
  /** The TDX module's own status, when TCB Info lists the quote's module. */
  moduleStatus: TcbStatus | null;
  /** The quoting enclave's status (QE Identity). */
  qeStatus: TcbStatus;
}

/**
 * Intel's TDX appraisal (QVL): the first TCB level whose SGX components and PCESVN the PCK
 * certificate meets and whose TDX components the TD's TEE_TCB_SVN meets gives the platform status.
 * A TDX module of version > 0 (TEE_TCB_SVN[1]) is judged by its own identity `TDX_<version>`
 * instead of the first two TDX components. An out-of-date module or quoting enclave makes an
 * up-to-date platform out of date; a revoked one revokes it.
 */
export function appraiseTcb(
  quote: TdxQuote,
  platform: PckPlatform,
  tcbInfo: TcbInfo,
  qeIdentity: QeIdentity,
): TcbAppraisal {
  if (tcbInfo.id !== 'TDX' || tcbInfo.version !== 3)
    throw new UnknownFormat(`TCB Info is ${tcbInfo.id} v${tcbInfo.version}, expected TDX v3`);
  if (
    tcbInfo.fmspc.toUpperCase() !== platform.fmspc ||
    tcbInfo.pceId.toUpperCase() !== platform.pceId
  )
    throw new Error(`TCB Info is for FMSPC ${tcbInfo.fmspc}, the machine is ${platform.fmspc}`);
  const tee = hexToBytes(quote.body.teeTcbSvn);
  const moduleVersion = tee[1] ?? 0;
  const level = tcbInfo.tcbLevels.find(
    (l) =>
      l.tcb.sgxtcbcomponents.length === 16 &&
      l.tcb.tdxtcbcomponents.length === 16 &&
      l.tcb.sgxtcbcomponents.every((c, i) => (platform.sgxTcbComponents[i] ?? 0) >= c.svn) &&
      platform.pceSvn >= l.tcb.pcesvn &&
      l.tcb.tdxtcbcomponents.every(
        (c, i) => (moduleVersion > 0 && i < 2) || (tee[i] ?? 0) >= c.svn,
      ),
  );
  if (!level) throw new Error('No TCB level in Intel’s TCB Info matches this machine');
  let platformStatus = status(level.tcbStatus);
  const advisories = new Set(level.advisoryIDs ?? []);

  // The TDX module: its signer and attributes, and for version > 0 its own TCB levels.
  const mrSignerSeam = hexToBytes(quote.body.mrSignerSeam);
  const seamAttributes = hexToBytes(quote.body.seamAttributes);
  const moduleOk = (m: { mrsigner: string; attributes: string; attributesMask: string }) =>
    sameBytes(hexToBytes(m.mrsigner), mrSignerSeam) &&
    sameBytes(masked(seamAttributes, hexToBytes(m.attributesMask)), hexToBytes(m.attributes));
  let moduleStatus: TcbStatus | null = null;
  if (moduleVersion === 0) {
    if (tcbInfo.tdxModule && !moduleOk(tcbInfo.tdxModule))
      throw new Error('The TDX module’s signer or attributes are not Intel’s');
  } else {
    const id = `TDX_${moduleVersion.toString(16).toUpperCase().padStart(2, '0')}`;
    const identity = tcbInfo.tdxModuleIdentities?.find((m) => m.id === id);
    if (!identity) throw new Error(`Intel’s TCB Info does not list TDX module ${id}`);
    if (!moduleOk(identity))
      throw new Error(`TDX module ${id}’s signer or attributes are not Intel’s`);
    const svn = tee[0] ?? 0;
    const m = identity.tcbLevels.find((l) => svn >= l.tcb.isvsvn);
    if (!m) throw new Error(`TDX module ${id} SVN ${svn} is below every level Intel lists`);
    moduleStatus = status(m.tcbStatus);
    for (const a of m.advisoryIDs ?? []) advisories.add(a);
    platformStatus = worsen(platformStatus, moduleStatus);
  }

  // The quoting enclave against its identity.
  if (qeIdentity.id !== 'TD_QE' || qeIdentity.version !== 2)
    throw new UnknownFormat(
      `QE Identity is ${qeIdentity.id} v${qeIdentity.version}, expected TD_QE v2`,
    );
  const qe = quote.qeReport;
  const miscselect = qe.raw.subarray(16, 20).slice().reverse(); // little-endian in the report
  const attributes = qe.raw.subarray(48, 64);
  if (
    qe.mrSigner !== qeIdentity.mrsigner.toLowerCase() ||
    qe.isvProdId !== qeIdentity.isvprodid ||
    !sameBytes(
      masked(miscselect, hexToBytes(qeIdentity.miscselectMask)),
      hexToBytes(qeIdentity.miscselect),
    ) ||
    !sameBytes(
      masked(attributes, hexToBytes(qeIdentity.attributesMask)),
      hexToBytes(qeIdentity.attributes),
    )
  )
    throw new Error('The quoting enclave does not match Intel’s TD_QE identity');
  const qeLevel = qeIdentity.tcbLevels.find((l) => qe.isvSvn >= l.tcb.isvsvn);
  const qeStatus: TcbStatus = qeLevel ? status(qeLevel.tcbStatus) : 'OutOfDate';
  for (const a of qeLevel?.advisoryIDs ?? []) advisories.add(a);

  return {
    status: worsen(platformStatus, qeStatus),
    issueDate: tcbInfo.issueDate,
    tcbDate: level.tcbDate ?? null,
    advisoryIds: [...advisories].sort(),
    moduleStatus,
    qeStatus,
  };
}

/** A platform status combined with a component's (the TDX module or the QE), as QVL converges them. */
function worsen(platform: TcbStatus, component: TcbStatus): TcbStatus {
  if (component === 'Revoked' || platform === 'Revoked') return 'Revoked';
  if (component !== 'OutOfDate' && component !== 'OutOfDateConfigurationNeeded') return platform;
  if (platform === 'UpToDate' || platform === 'SWHardeningNeeded') return 'OutOfDate';
  if (platform === 'ConfigurationNeeded' || platform === 'ConfigurationAndSWHardeningNeeded')
    return 'OutOfDateConfigurationNeeded';
  return platform;
}

// ── The checks ──────────────────────────────────────────────────────────────────────────────────

export type CollateralCheckId = 'revocation' | 'tcb_status';

export interface CollateralCheck {
  id: CollateralCheckId;
  label: string;
  /** False: a failure (bad signature, revoked certificate, revoked TCB). */
  ok: boolean;
  /** Not a failure, but not a pass: a TCB status other than UpToDate, or collateral unreadable. */
  warn?: boolean;
  detail?: string;
}

export const REVOCATION_LABEL = 'Intel’s revocation lists: no certificate in the chain is revoked';
export const TCB_LABEL_PREFIX = 'Platform patch level (TCB)';

export interface CollateralVerification {
  checks: CollateralCheck[];
  tcb: TcbAppraisal | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Intel's signed data, in a format version this check does not read yet. Its signatures already
 * checked out, so it is not tampering: the patch level is shown as not checked, a warning, rather
 * than failing every attestation (and blocking every new plan) until this code learns the format.
 */
export class UnknownFormat extends Error {}

/** The two rows for a quote whose collateral could not be read: not checked, said plainly. */
export function collateralUnavailable(reason: string): CollateralCheck[] {
  return [
    {
      id: 'revocation',
      label: REVOCATION_LABEL,
      ok: true,
      warn: true,
      detail: `Not checked: ${reason}`,
    },
    {
      id: 'tcb_status',
      label: `${TCB_LABEL_PREFIX}: not checked`,
      ok: true,
      warn: true,
      detail: `Not checked: ${reason}`,
    },
  ];
}

/**
 * Checks Intel's collateral for a parsed quote: the CRLs' signatures and that neither the PCK nor
 * its CA nor the TCB Signing certificate is revoked; TCB Info's and QE Identity's signatures and
 * chains to the pinned root; then the machine's TCB status. Never throws.
 */
export function verifyCollateral(
  quote: TdxQuote,
  collateral: PcsCollateral,
  opts: { now?: Date; rootKeyHex?: string } = {},
): CollateralVerification {
  const now = opts.now ?? new Date();
  const rootKey = hexToBytes(opts.rootKeyHex ?? INTEL_SGX_ROOT_CA_PUBLIC_KEY);

  let leaf: Certificate | null = null;
  let ca: Certificate | null = null;
  let root: Certificate | null = null;
  let chainProblem: string | null = null;
  try {
    const chain = verifyPckChain(rootKey, now, quote.pckChainPem);
    if (chain.ok)
      [leaf, ca, root] = pemCertificates(quote.pckChainPem).map(parseCertificate) as [
        Certificate,
        Certificate,
        Certificate,
      ];
    else chainProblem = chain.reason;
  } catch (e) {
    chainProblem = message(e);
  }

  // Revocation: the PCK CA's CRL lists the PCK; the root's CRL lists the CAs under it.
  let revocation: CollateralCheck;
  try {
    if (!leaf || !ca || !root) throw new Error(`No trusted PCK chain: ${chainProblem}`);
    const pckCrl = parseCrl(collateral.pckCrl);
    const rootCrl = parseCrl(collateral.rootCaCrl);
    const problem =
      crlProblem(pckCrl, ca, ca.publicKey, now) ?? crlProblem(rootCrl, root, rootKey, now);
    if (problem) throw new Error(problem);
    // An unusable signing chain fails the TCB check below; only revocation is judged here.
    const tcbSignerSerials = [collateral.tcbInfo, collateral.qeIdentity].flatMap((doc) => {
      try {
        return [tcbSigner(doc.issuerChain, rootKey, now).serial];
      } catch {
        return [];
      }
    });
    const revoked = [
      pckCrl.revoked.has(leaf.serial) && 'the PCK certificate',
      rootCrl.revoked.has(ca.serial) && `the ${ca.subjectCn}`,
      tcbSignerSerials.some((s) => rootCrl.revoked.has(s)) && 'the TCB Signing certificate',
    ].filter((x): x is string => !!x);
    revocation = revoked.length
      ? {
          id: 'revocation',
          label: REVOCATION_LABEL,
          ok: false,
          detail: `Intel revoked ${revoked.join(' and ')}`,
        }
      : {
          id: 'revocation',
          label: REVOCATION_LABEL,
          ok: true,
          detail: `Checked against Intel’s CRLs of ${day(pckCrl.thisUpdate)} (${ca.subjectCn}) and ${day(rootCrl.thisUpdate)} (Root CA)`,
        };
  } catch (e) {
    revocation = { id: 'revocation', label: REVOCATION_LABEL, ok: false, detail: message(e) };
  }

  let tcb: TcbAppraisal | null = null;
  let tcbCheck: CollateralCheck;
  try {
    if (!leaf) throw new Error(`No trusted PCK chain: ${chainProblem}`);
    const info = verifySignedJson<TcbInfo>(
      collateral.tcbInfo.body,
      'tcbInfo',
      collateral.tcbInfo.issuerChain,
      rootKey,
      now,
    ).doc;
    inDate(info, 'TCB Info', now);
    const qe = verifySignedJson<QeIdentity>(
      collateral.qeIdentity.body,
      'enclaveIdentity',
      collateral.qeIdentity.issuerChain,
      rootKey,
      now,
    ).doc;
    inDate(qe, 'QE Identity', now);
    tcb = appraiseTcb(quote, pckPlatform(leaf), info, qe);
    const advisories = tcb.advisoryIds.length
      ? `; Intel advisories: ${tcb.advisoryIds.join(', ')}`
      : '';
    tcbCheck = {
      id: 'tcb_status',
      label: `${TCB_LABEL_PREFIX}: ${TCB_STATUS_WORDS[tcb.status]} as of Intel’s ${tcb.issueDate.slice(0, 10)} data`,
      ok: tcb.status !== 'Revoked',
      ...(tcb.status === 'UpToDate' || tcb.status === 'Revoked' ? {} : { warn: true }),
      detail: `Intel’s status ${tcb.status}${tcb.tcbDate ? `, TCB level of ${tcb.tcbDate.slice(0, 10)}` : ''}; quoting enclave ${tcb.qeStatus}${advisories}`,
    };
  } catch (e) {
    tcbCheck =
      e instanceof UnknownFormat
        ? {
            id: 'tcb_status',
            label: `${TCB_LABEL_PREFIX}: not checked`,
            ok: true,
            warn: true,
            detail: `Not checked: Intel’s data is in a newer format (${e.message})`,
          }
        : {
            id: 'tcb_status',
            label: `${TCB_LABEL_PREFIX}: could not be established from Intel’s data`,
            ok: false,
            detail: message(e),
          };
  }
  return { checks: [revocation, tcbCheck], tcb };
}
