import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient } from 'viem';
import { afterAll, describe, expect, it } from 'vitest';
import { publicRpcTransport, RpcBusyError, rpcUnavailable } from '../src/transport.ts';

interface FakeNode {
  url: string;
  hits: number;
  maxConcurrent: number;
}

const servers: Server[] = [];
afterAll(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

/** A JSON-RPC node that answers every request with `status` (a result on 200) after `delayMs`. */
async function fakeNode(status: number, delayMs = 0): Promise<FakeNode> {
  const node: FakeNode = { url: '', hits: 0, maxConcurrent: 0 };
  let open = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      node.hits++;
      open++;
      node.maxConcurrent = Math.max(node.maxConcurrent, open);
      const { id } = JSON.parse(raw) as { id: number };
      setTimeout(() => {
        open--;
        if (status !== 200) {
          res.writeHead(status, { 'content-type': 'text/plain' }).end('Rate limit exceeded');
          return;
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x10' }));
      }, delayMs);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  node.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return node;
}

const client = (urls: string[], pacing = {}) =>
  createPublicClient({ transport: publicRpcTransport(urls, pacing) });

describe('the public RPC transport', () => {
  it('hands a rate-limited request to the next endpoint, and rests the refusing one', async () => {
    const limited = await fakeNode(429);
    const healthy = await fakeNode(200);
    const c = client([limited.url, healthy.url]);
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(await c.getBlockNumber({ cacheTime: 0 })).toBe(16n);
    // The second request skipped the resting endpoint instead of asking it again.
    expect(limited.hits).toBe(1);
    expect(healthy.hits).toBe(2);
  });

  it('keeps at most maxInFlight requests open to one endpoint', async () => {
    const slow = await fakeNode(200, 30);
    const c = client([slow.url], { maxInFlight: 2 });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        c.request({
          method: 'eth_getTransactionReceipt',
          params: [`0x${String(i).padStart(64, '0')}`],
        }),
      ),
    );
    expect(slow.hits).toBe(10);
    expect(slow.maxConcurrent).toBe(2);
  });

  it('refuses at once, as busy, past maxWaiting', async () => {
    const slow = await fakeNode(200, 50);
    const c = client([slow.url], { maxInFlight: 1, maxWaiting: 2 });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => c.request({ method: 'eth_blockNumber' })),
    );
    const refused = results.filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(2);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(RpcBusyError);
  });

  it('fails as unavailable when every endpoint refuses', async () => {
    const a = await fakeNode(429);
    const b = await fakeNode(503);
    const error = await client([a.url, b.url])
      .request({ method: 'eth_blockNumber' })
      .catch((e: unknown) => e);
    expect(rpcUnavailable(error)).toBe(true);
  });
});
