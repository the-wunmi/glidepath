import { loadPlanKey } from './backup';

/** Errors from the API carry its code and message, so the UI can show the fact it reported. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const OPERATOR_KEY = 'vsp-operator-token';

/** The operator token this browser signed in with; sent as the bearer on every API call. */
export const operatorToken = (): string | null => localStorage.getItem(OPERATOR_KEY);

export function setOperatorToken(token: string | null) {
  if (token) localStorage.setItem(OPERATOR_KEY, token);
  else localStorage.removeItem(OPERATOR_KEY);
}

interface ApiInit {
  method?: string;
  body?: unknown;
  /** An owner action on this plan: sends the plan key this browser holds for it. */
  planId?: number;
}

function headers(init: ApiInit | undefined): Record<string, string> {
  const h: Record<string, string> = {};
  if (init?.body !== undefined) h['content-type'] = 'application/json';
  const operator = operatorToken();
  if (operator) h.authorization = `Bearer ${operator}`;
  const key = init?.planId === undefined ? null : loadPlanKey(init.planId);
  if (key) h['x-plan-key'] = key.key;
  return h;
}

/** The API's refusals that people meet in normal use, in our words rather than the server's. */
function plainMessage(status: number, code: string, path: string, init?: ApiInit): string | null {
  if (code === 'rate_limited')
    return 'Too many requests from this address. Try again in a few minutes.';
  if (code === 'busy') return 'Glidepath is busy right now; try again later.';
  if (status !== 403 || code !== 'forbidden') return null;
  if (init?.planId !== undefined)
    return loadPlanKey(init.planId)
      ? 'The plan refused the key this browser holds. Replace it under Proof, Plan key.'
      : 'Managing this plan needs its plan key. Paste it to manage the plan here.';
  if (path.startsWith('/api/sim')) return 'Only the operator can change the simulation.';
  return null;
}

export async function api<T>(path: string, init?: ApiInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? (init?.body === undefined ? 'GET' : 'POST'),
      headers: headers(init),
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
      // Chain writes can take a while (a DAO action is a proposal plus a vote), so only reads time out.
      signal: init?.body === undefined ? AbortSignal.timeout(15_000) : undefined,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw new ApiError(0, 'timeout', 'The API did not answer within 15 s. Retrying.');
    throw new ApiError(0, 'unreachable', 'The API is not reachable. Is it running on port 4400?');
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const err = (parsed ?? {}) as { error?: string; message?: string; details?: unknown };
    if (res.status >= 500 && !err.error)
      throw new ApiError(res.status, 'unreachable', 'The API is not reachable. Is it running?');
    const code = err.error ?? 'error';
    throw new ApiError(
      res.status,
      code,
      plainMessage(res.status, code, path, init) ?? err.message ?? `Request failed (${res.status})`,
      err.details,
    );
  }
  return parsed as T;
}

/** The on-chain refusal code in an API error, when the registry refused something. */
export function refusalCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const d = error.details as { code?: string } | undefined;
  return d && typeof d.code === 'string' ? d.code : null;
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
