import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function rawMarkdownPlugin() {
  return {
    name: 'raw-markdown',
    load(id: string) {
      const cleanId = id.split('?', 1)[0];
      if (!cleanId.endsWith('.md')) {
        return null;
      }
      const raw = readFileSync(cleanId, 'utf8');
      return `export default ${JSON.stringify(raw)};`;
    },
  };
}

export default defineConfig({
  plugins: [rawMarkdownPlugin()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  oxc: {
    jsx: {
      runtime: 'automatic',
      importSource: 'preact',
    },
  },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/mocks/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.{ts,tsx}'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          environment: 'node',
          testTimeout: 60000,
          hookTimeout: 60000,
          include: ['tests/e2e/**/*.test.ts'],
        },
      },
    ],
  },
});
