import { type EnvelopeJson, SealedPlan } from '@glidepath/core';

/**
 * The founder's own copy of a sealed plan: the plan, its salt and commitment. It never leaves this
 * browser except as the downloaded file. Kept per plan id and commitment, because a change adds a
 * second sealed plan to the same plan id.
 */
export interface PlanBackup {
  kind: 'glidepath-plan-backup';
  commitment: string;
  salt: string;
  plan: unknown;
  envelope: EnvelopeJson;
  launch?: { name: string; founder_allocation?: string; listing_price_usd: string };
  created_at: string;
}

const key = (planId: number) => `glidepath-plan-backups-${planId}`;

function readAll(planId: number): Record<string, PlanBackup> {
  try {
    return JSON.parse(localStorage.getItem(key(planId)) ?? '{}') as Record<string, PlanBackup>;
  } catch {
    return {};
  }
}

export function saveBackup(planId: number, backup: PlanBackup) {
  const all = readAll(planId);
  all[backup.commitment] = backup;
  localStorage.setItem(key(planId), JSON.stringify(all));
}

export function loadBackup(planId: number, commitment: string): PlanBackup | null {
  return readAll(planId)[commitment] ?? null;
}

/** The sealed plan inside a backup, if it parses; a file from elsewhere is checked, not trusted. */
export function backupPlan(b: PlanBackup | null) {
  if (!b) return null;
  const parsed = SealedPlan.safeParse(b.plan);
  return parsed.success ? parsed.data : null;
}

/** Parses an uploaded backup file. Returns null when it is not one of ours. */
export function parseBackupFile(text: string): PlanBackup | null {
  try {
    const v = JSON.parse(text) as Partial<PlanBackup>;
    if (v.kind !== 'glidepath-plan-backup' || typeof v.commitment !== 'string') return null;
    return v as PlanBackup;
  } catch {
    return null;
  }
}

/** A plan's owner key: 32 random bytes as hex, returned once by POST /api/plans. */
export const PLAN_KEY_PATTERN = /^[0-9a-f]{64}$/;

/** The plan key as stored here; `saved` once the owner copied or downloaded it, or pasted it in. */
export interface StoredPlanKey {
  key: string;
  saved: boolean;
}

const planKeyKey = (planId: number) => `glidepath-plan-key-${planId}`;

/** Fired on window whenever a plan key is stored, so open pages pick it up. */
export const PLAN_KEY_EVENT = 'glidepath:plan-key';

export function loadPlanKey(planId: number): StoredPlanKey | null {
  try {
    const v = JSON.parse(
      localStorage.getItem(planKeyKey(planId)) ?? 'null',
    ) as StoredPlanKey | null;
    return v && PLAN_KEY_PATTERN.test(v.key) ? v : null;
  } catch {
    return null;
  }
}

export function savePlanKey(planId: number, stored: StoredPlanKey) {
  localStorage.setItem(planKeyKey(planId), JSON.stringify(stored));
  window.dispatchEvent(new Event(PLAN_KEY_EVENT));
}

/** A pasted key, trimmed and lower-cased; null when it is not 64 hex characters. */
export function parsePlanKey(text: string): string | null {
  const key = text.trim().toLowerCase();
  return PLAN_KEY_PATTERN.test(key) ? key : null;
}
