'use client';

import { useEffect, useState } from 'react';
import { MoonIcon, SunIcon } from './icons';

const KEY = 'vsp-theme';

/**
 * Runs before paint (inlined in <head>) so the page never flashes the wrong theme. An explicit
 * choice is stored; without one the system preference decides.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('${KEY}');var d=t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => {
      if (localStorage.getItem(KEY)) return;
      document.documentElement.classList.toggle('dark', e.matches);
      setDark(e.matches);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const next = dark ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm size-8 px-0"
      aria-label={dark === null ? 'Switch theme' : `Switch to ${next} theme`}
      title={dark === null ? 'Switch theme' : `Switch to ${next} theme`}
      onClick={() => {
        const d = !document.documentElement.classList.contains('dark');
        document.documentElement.classList.toggle('dark', d);
        localStorage.setItem(KEY, d ? 'dark' : 'light');
        setDark(d);
      }}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
