'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/session';
import { useResource } from '@/lib/use-resource';

/** A signed sale the relayer has not sent after the grace period, with the call that sends it. */
interface UnsentSale {
  seq: number;
  signedAt: string;
  call: {
    receiverId: string;
    method: string;
    args: Record<string, unknown>;
    gasTera: number;
    deposit: string;
  };
}

const minutesAgo = (iso: string) =>
  Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60_000));

/**
 * Signed sales Glidepath's relayer has not sent. The registry accepts an enclave-signed sale from
 * anyone and checks the signature and the plan's limits whoever sends it, so the relayer cannot
 * hold a signed sale back. On the plan page the visitor's own wallet can send it; the verifier
 * (where no wallet loads) links there.
 */
export function UnsentSales({ planId, canSend }: { planId: number; canSend: boolean }) {
  const unsent = useResource(
    () => api<UnsentSale[]>(`/api/plans/${planId}/unsent`),
    [planId],
    30_000,
  );
  const me = useMe();
  const [busy, setBusy] = useState<number | null>(null);
  const [result, setResult] = useState<Record<number, string>>({});
  const rows = unsent.data ?? [];
  if (!rows.length) return null;

  async function send(sale: UnsentSale) {
    setBusy(sale.seq);
    try {
      const { signAndSendTransactions, functionCall } = await import('@/lib/wallet');
      const [sent] = await signAndSendTransactions([
        {
          receiverId: sale.call.receiverId,
          actions: [
            functionCall(
              sale.call.method,
              sale.call.args,
              String(BigInt(sale.call.gasTera) * 10n ** 12n),
              sale.call.deposit,
            ),
          ],
        },
      ]);
      setResult((r) => ({ ...r, [sale.seq]: sent ? `Sent: ${sent.txHash}` : 'Sent.' }));
      unsent.reload();
    } catch (e) {
      setResult((r) => ({ ...r, [sale.seq]: errorMessage(e) }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel border-wait/50 px-5 py-4" aria-label="Signed sales not sent yet">
      <h2 className="font-semibold">A signed sale has not been sent</h2>
      <p className="mt-1 text-sm text-ink-2">
        The enclave signed it, but Glidepath’s relayer has not sent it to the registry. Anyone may
        send it: the registry checks the enclave’s signature and the plan’s public limits whoever
        sends it, and the proceeds still go only to the beneficiary.
      </p>
      <ul className="mt-3 space-y-2 text-sm">
        {rows.map((sale) => (
          <li key={sale.seq} className="flex flex-wrap items-center gap-3">
            <span>
              Sale #{sale.seq}, signed {minutesAgo(sale.signedAt)} min ago
            </span>
            {canSend ? (
              me.data ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy !== null}
                  onClick={() => void send(sale)}
                >
                  {busy === sale.seq ? 'Waiting for the wallet…' : 'Send it with your wallet'}
                </button>
              ) : (
                <Link className="link text-sm" href={`/sign-in?next=/app/plans/${planId}`}>
                  Sign in to send it yourself
                </Link>
              )
            ) : (
              <Link className="link text-sm" href={`/app/plans/${planId}`}>
                Send it yourself from the plan page
              </Link>
            )}
            {result[sale.seq] && (
              <span className="mono text-xs text-ink-2">{result[sale.seq]}</span>
            )}
          </li>
        ))}
      </ul>
      {canSend && (
        <p className="hint mt-2">
          Your wallet attaches {Number(BigInt(rows[0]?.call.deposit ?? '0')) / 1e24} NEAR and pays
          the gas; nothing else changes hands.
        </p>
      )}
    </section>
  );
}
