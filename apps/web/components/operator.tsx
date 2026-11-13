'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, api, operatorToken, setOperatorToken } from '@/lib/api';

/**
 * Whether this browser holds the operator's token, as the API judged it: `operator` once
 * GET /api/operator said yes, `none` without a token, `unchecked` when the API could not answer.
 */
export type OperatorStatus = 'none' | 'checking' | 'operator' | 'refused' | 'unchecked';

interface OperatorState {
  status: OperatorStatus;
  signIn: (token: string) => Promise<OperatorStatus>;
  signOut: () => void;
}

const OperatorContext = createContext<OperatorState | null>(null);

async function check(): Promise<OperatorStatus> {
  if (!operatorToken()) return 'none';
  try {
    const r = await api<{ operator: boolean }>('/api/operator');
    return r.operator ? 'operator' : 'refused';
  } catch (e) {
    return e instanceof ApiError && (e.status === 401 || e.status === 403)
      ? 'refused'
      : 'unchecked';
  }
}

export function OperatorProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<OperatorStatus>('checking');
  const verify = useCallback(async () => {
    setStatus('checking');
    const s = await check();
    // A refused token (wrong, or rotated by the operator) authorizes nothing, so it is not kept.
    if (s === 'refused') setOperatorToken(null);
    setStatus(s);
    return s;
  }, []);
  useEffect(() => {
    void verify();
  }, [verify]);
  const signIn = useCallback(
    (token: string) => {
      setOperatorToken(token);
      return verify();
    },
    [verify],
  );
  const signOut = useCallback(() => {
    setOperatorToken(null);
    setStatus('none');
  }, []);
  return (
    <OperatorContext.Provider value={{ status, signIn, signOut }}>
      {children}
    </OperatorContext.Provider>
  );
}

export function useOperator(): OperatorState {
  const ctx = useContext(OperatorContext);
  if (!ctx) throw new Error('useOperator outside OperatorProvider');
  return ctx;
}
