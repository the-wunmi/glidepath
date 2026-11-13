import { DomainError } from '@vsp/core';
import type { z } from 'zod';
import {
  type QuoteRequest,
  QuoteResponse,
  StatusResponse,
  type SubmitDepositRequest,
  TokenInfo,
} from './types.ts';

/** A slow answer is retried by the job, so one request never holds a worker for long. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The 1Click HTTP API. The same class talks to the real service (https://1click.chaindefuser.com)
 * and to the in-repo simulator, which serves the same routes; only the base URL differs.
 */
export class OneClickClient {
  constructor(
    readonly baseUrl: string,
    readonly mode: 'mock' | 'live',
    private readonly jwt?: string,
  ) {}

  private async request<S extends z.ZodType>(
    schema: S,
    path: string,
    init: RequestInit = {},
  ): Promise<z.output<S>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.jwt) headers.authorization = `Bearer ${this.jwt}`;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DomainError('unavailable', '1Click did not answer', String(error));
    }
    const text = await res.text();
    if (res.status === 404) throw new DomainError('not_found', '1Click does not know this deposit');
    if (!res.ok) {
      throw new DomainError(
        res.status >= 500 ? 'unavailable' : 'invalid',
        `1Click refused the request (${res.status})`,
        text.slice(0, 500),
      );
    }
    return schema.parse(JSON.parse(text));
  }

  tokens(): Promise<TokenInfo[]> {
    return this.request(TokenInfo.array(), '/v0/tokens');
  }

  quote(request: QuoteRequest): Promise<QuoteResponse> {
    return this.request(QuoteResponse, '/v0/quote', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  status(depositAddress: string): Promise<StatusResponse> {
    return this.request(
      StatusResponse,
      `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
    );
  }

  submitDeposit(request: SubmitDepositRequest): Promise<StatusResponse> {
    return this.request(StatusResponse, '/v0/deposit/submit', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }
}
