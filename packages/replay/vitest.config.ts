import { defineConfig } from 'vitest/config';

// One test reruns the whole study (1,000 seeds per event) to check the committed results; under a
// busy machine that takes well over vitest's 5 s default.
export default defineConfig({ test: { testTimeout: 60_000 } });
