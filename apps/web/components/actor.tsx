'use client';

import { createContext, type ReactNode, useContext, useEffect, useId, useState } from 'react';
import type { Meta } from '@/lib/types';
import { useMeta } from './meta';

const KEY = 'vsp-actor';

/**
 * Who the founder app acts as: the founder's own account (the server signs with its key) or the
 * treasury DAO the founder sits on (each action goes through a DAO proposal). Not a wallet.
 */
interface ActorState {
  actor: string | null;
  setActor: (a: string) => void;
  options: { account: string; how: string }[];
}

const ActorContext = createContext<ActorState | null>(null);

export const actorOptions = (meta: Meta | null) =>
  meta
    ? [
        { account: meta.accounts.founder, how: '' },
        ...(meta.accounts.dao ? [{ account: meta.accounts.dao, how: 'via DAO proposal' }] : []),
      ]
    : [];

export function ActorProvider({ children }: { children: ReactNode }) {
  const { data: meta } = useMeta();
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => setChosen(localStorage.getItem(KEY)), []);
  const options = actorOptions(meta);
  const actor = options.find((o) => o.account === chosen)?.account ?? options[0]?.account ?? null;
  return (
    <ActorContext.Provider
      value={{
        actor,
        options,
        setActor: (a) => {
          localStorage.setItem(KEY, a);
          setChosen(a);
        },
      }}
    >
      {children}
    </ActorContext.Provider>
  );
}

export function useActor(): ActorState {
  const ctx = useContext(ActorContext);
  if (!ctx) throw new Error('useActor outside ActorProvider');
  return ctx;
}

export function ActorSwitcher() {
  const { actor, options, setActor } = useActor();
  const id = useId();
  if (!actor) return <span className="text-xs text-ink-3">Acting as …</span>;
  if (options.length < 2)
    return (
      <span className="text-sm text-ink-2">
        Acting as <span className="mono font-medium text-ink">{actor}</span>
      </span>
    );
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-sm text-ink-2">
      <label htmlFor={id} className="shrink-0">
        Acting as
      </label>
      <select
        id={id}
        className="mono max-w-[15rem] min-w-0 truncate rounded-md border border-rule bg-surface py-1 pr-6 pl-2 text-xs text-ink sm:max-w-none"
        value={actor}
        onChange={(e) => setActor(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.account} value={o.account}>
            {o.how ? `${o.account} (${o.how})` : o.account}
          </option>
        ))}
      </select>
    </span>
  );
}
