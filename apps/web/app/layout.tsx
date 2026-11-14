import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Public_Sans } from 'next/font/google';
import type { ReactNode } from 'react';
import { MetaProvider } from '@/components/meta';
import { OperatorProvider } from '@/components/operator';
import { Shell } from '@/components/shell';
import { THEME_SCRIPT } from '@/components/theme';
import './globals.css';

const publicSans = Public_Sans({ subsets: ['latin'], variable: '--font-public' });
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
});

export const metadata: Metadata = {
  title: { default: 'Glidepath', template: '%s · Glidepath' },
  description:
    'Token unlocks are cliffs. Glidepath turns them into a glide path anyone can verify: 10b5-1-style selling plans for crypto, verified on NEAR.',
  applicationName: 'Glidepath',
  openGraph: {
    title: 'Glidepath',
    description:
      'Token unlocks are cliffs. Glidepath turns them into a glide path anyone can verify.',
    siteName: 'Glidepath',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Glidepath',
    description: '10b5-1-style selling plans for crypto, verified on NEAR.',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#111925' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${publicSans.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed theme script, no user input. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <MetaProvider>
          <OperatorProvider>
            <Shell>{children}</Shell>
          </OperatorProvider>
        </MetaProvider>
      </body>
    </html>
  );
}
