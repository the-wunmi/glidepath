'use client';

import { createContext, type ReactNode, useContext, useEffect } from 'react';
import { api } from '@/lib/api';
import type { Meta } from '@/lib/types';
import { type Resource, useResource } from '@/lib/use-resource';

const MetaContext = createContext<Resource<Meta> | null>(null);

/** The system's public facts (accounts, enclave, modes), shared by every page. */
export function MetaProvider({ children }: { children: ReactNode }) {
  const meta = useResource(() => api<Meta>('/api/meta'), [], 20_000);
  useEffect(() => {
    const onChange = () => void meta.reload();
    window.addEventListener('vsp:chain-advanced', onChange);
    return () => window.removeEventListener('vsp:chain-advanced', onChange);
  }, [meta.reload]);
  return <MetaContext.Provider value={meta}>{children}</MetaContext.Provider>;
}

export function useMeta(): Resource<Meta> {
  const ctx = useContext(MetaContext);
  if (!ctx) throw new Error('useMeta outside MetaProvider');
  return ctx;
}
