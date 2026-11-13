import { activity, type Tx } from '@vsp/db';

/**
 * Appends to a plan's timeline. Never updated: corrections are new entries. Accepts a transaction,
 * so a workflow's timeline entry commits with the state change it describes, exactly once.
 */
export async function record(
  db: Tx,
  planId: number | null,
  kind: string,
  message: string,
  data: Record<string, unknown> = {},
) {
  await db.insert(activity).values({ planId, kind, message, data });
}
