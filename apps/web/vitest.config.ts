import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  esbuild: { jsx: 'automatic' }, // Next compiles with jsx: preserve; vitest needs the automatic runtime
  test: { setupFiles: ['./src/test-setup.ts'] },
});
