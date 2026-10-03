import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // NestJS uses legacy (experimental) decorators with emitted parameter
  // metadata; the oxc transformer has to be told so explicitly.
  oxc: {
    decorator: { legacy: true, emitDecoratorMetadata: true },
  },
  resolve: {
    // Tests run against shared's source, so they don't need a build first.
    alias: {
      '@docprocessor/shared': fileURLToPath(new URL('./libs/ts-shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['services/*/test/**/*.test.ts', 'libs/*/test/**/*.test.ts'],
    // Keep the services' JSON logs out of the test output.
    setupFiles: ['./vitest.setup.ts'],
  },
});
