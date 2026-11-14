import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/** The API also serves the read-only chain proxies (/rpc/*) and the 1Click simulator (/sim/*). */
const API_ORIGIN = process.env.VSP_API_ORIGIN ?? 'http://127.0.0.1:4400';

const config: NextConfig = {
  reactStrictMode: true,
  // A self-contained server for the production image (the root Dockerfile); traced from the
  // monorepo root so workspace packages are included.
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  agentRules: false,
  devIndicators: false,
  // The workspace packages ship TypeScript source; the browser needs @vsp/core, @vsp/verify and @vsp/btc.
  transpilePackages: ['@vsp/core', '@vsp/verify', '@vsp/chainsig', '@vsp/trust', '@vsp/btc'],
  typescript: {
    // Type checking runs through `pnpm typecheck` (tsc --noEmit), which uses the workspace compiler.
    ignoreBuildErrors: true,
  },
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` },
      { source: '/rpc/:path*', destination: `${API_ORIGIN}/rpc/:path*` },
      { source: '/sim/:path*', destination: `${API_ORIGIN}/sim/:path*` },
    ];
  },
};

export default config;
