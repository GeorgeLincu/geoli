import { defineConfig } from 'vitest/config';

// Unit tests for pure logic (src/lib/**). Kept separate from Astro's Vite config.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
