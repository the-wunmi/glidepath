import { Hono } from 'hono';

/**
 * A read-only pass-through to Intel's PCS for the collateral a browser needs to check a TDX quote's
 * revocation and TCB status, since Intel serves it without CORS headers. Only these four documents,
 * with only these parameters: the upstream URL is built here, never taken from the request. The
 * bytes and Intel's issuer-chain header go out untouched; Intel signs all of it, so the browser
 * checks it against Intel's pinned root and trusts nothing about this server but its availability.
 */

const PCS = 'https://api.trustedservices.intel.com';
/** The Root CA's CRL lives here (its certificate's CRL distribution point); PCS v4 has no route for it. */
const CERTS = 'https://certificates.trustedservices.intel.com';
/** Intel reissues these daily at most; an hour keeps a TCB recovery from waiting long. */
const KEEP_MS = 60 * 60_000;
/** A failure is remembered this long, so a burst of page views does not each wait on Intel. */
const FAILURE_MS = 30_000;
const TIMEOUT_MS = 10_000;
/** The platform PCK CRL is about 3 KB and TDX TCB Info about 6 KB. */
const MAX_BYTES = 256 * 1024;

interface Document {
  upstream: string;
  /** Intel's header carrying the signer's certificate chain, passed through as Intel sends it. */
  chainHeader?: string;
}

const FMSPC = /^[0-9a-f]{12}$/i;
const PCK_CAS = new Set(['platform', 'processor']);

interface Answer {
  body: Uint8Array;
  contentType: string;
  chain: string | null;
  /** Wall-clock time this answer may be kept until. */
  until: number;
}

/** Thrown for Intel's 404 (an FMSPC it does not know), which is not an outage. */
class NotFound extends Error {}

/** Never past the document's own nextUpdate, so an expired copy is not served from here. */
function keepUntil(body: Uint8Array, contentType: string, now: number): number {
  if (!contentType.includes('json')) return now + KEEP_MS;
  try {
    const doc = JSON.parse(new TextDecoder().decode(body)) as Record<
      string,
      { nextUpdate?: string }
    >;
    const next = Date.parse(Object.values(doc)[0]?.nextUpdate ?? '');
    return Number.isNaN(next) ? now + KEEP_MS : Math.min(now + KEEP_MS, next);
  } catch {
    return now + KEEP_MS;
  }
}

export function pcsRoutes(fetchImpl: typeof fetch = fetch) {
  const app = new Hono();
  const cache = new Map<string, { until: number; answer: Promise<Answer> }>();

  const load = async (doc: Document): Promise<Answer> => {
    const res = await fetchImpl(doc.upstream, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) throw new NotFound();
    if (!res.ok) throw new Error(`Intel answered HTTP ${res.status}`);
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.length > MAX_BYTES) throw new Error('Intel’s answer is larger than expected');
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    return {
      body,
      contentType,
      chain: doc.chainHeader ? res.headers.get(doc.chainHeader) : null,
      until: keepUntil(body, contentType, Date.now()),
    };
  };

  const get = (doc: Document): Promise<Answer> => {
    const now = Date.now();
    const hit = cache.get(doc.upstream);
    if (hit && hit.until > now) return hit.answer;
    const answer = load(doc);
    const entry = { until: now + KEEP_MS, answer };
    cache.set(doc.upstream, entry);
    answer.then(
      (a) => {
        entry.until = a.until;
      },
      () => {
        entry.until = Date.now() + FAILURE_MS;
      },
    );
    return answer;
  };

  const serve = async (doc: Document) => {
    try {
      const a = await get(doc);
      const headers: Record<string, string> = {
        'content-type': a.contentType,
        'cache-control': `public, max-age=${Math.max(0, Math.floor((a.until - Date.now()) / 1000))}`,
      };
      if (doc.chainHeader && a.chain) headers[doc.chainHeader] = a.chain;
      return new Response(a.body, { status: 200, headers });
    } catch (e) {
      if (e instanceof NotFound)
        return Response.json(
          { error: 'not_found', code: 'not_found', message: 'Intel has no such collateral' },
          { status: 404 },
        );
      return Response.json(
        {
          error: 'unavailable',
          code: 'unavailable',
          message: 'Intel’s certification service did not answer; try again shortly',
        },
        { status: 503, headers: { 'retry-after': String(FAILURE_MS / 1000) } },
      );
    }
  };

  const invalid = (message: string) =>
    Response.json({ error: 'invalid', code: 'invalid', message }, { status: 422 });

  app.get('/tdx/tcb', (c) => {
    const fmspc = c.req.query('fmspc') ?? '';
    if (!FMSPC.test(fmspc)) return invalid('fmspc must be 12 hex digits');
    return serve({
      upstream: `${PCS}/tdx/certification/v4/tcb?fmspc=${fmspc.toUpperCase()}`,
      chainHeader: 'TCB-Info-Issuer-Chain',
    });
  });
  app.get('/tdx/qe-identity', () =>
    serve({
      upstream: `${PCS}/tdx/certification/v4/qe/identity`,
      chainHeader: 'SGX-Enclave-Identity-Issuer-Chain',
    }),
  );
  // The browser checks the PCK CRL with the CA certificate the quote itself carries.
  app.get('/pckcrl', (c) => {
    const ca = c.req.query('ca') ?? '';
    if (!PCK_CAS.has(ca)) return invalid('ca must be platform or processor');
    return serve({ upstream: `${PCS}/sgx/certification/v4/pckcrl?ca=${ca}&encoding=der` });
  });
  app.get('/rootcacrl', () => serve({ upstream: `${CERTS}/IntelSGXRootCA.der` }));
  return app;
}
