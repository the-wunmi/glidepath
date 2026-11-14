'use client';

import { api } from './api';
import { type Resource, useResource } from './use-resource';

/** The signed-in NEAR testnet account. */
export interface Me {
  account: string;
}

/** Who is signed in, or null when nobody is. */
export function useMe(): Resource<Me | null> {
  return useResource(() => api<Me | null>('/api/me'), []);
}

export async function signOut(): Promise<void> {
  // An empty JSON body: the API takes writes only as JSON.
  await api('/api/auth/logout', { body: {} });
}
