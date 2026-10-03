/**
 * Guards the document service's layering: dependencies point inwards.
 *
 *       api ─┐
 *            ├─▶ application ─▶ domain
 *   adapters ┘
 *
 * The composition root (`main.ts`, `app.module.ts`, `infrastructure.ts`) and
 * `config.ts` may import anything.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

// layer -> modules of src/ it must not import
const FORBIDDEN: Record<string, string[]> = {
  domain: ['application', 'adapters', 'api', 'config', 'main', 'app.module', 'infrastructure'],
  application: ['adapters', 'api', 'main', 'app.module', 'infrastructure'],
  adapters: ['api', 'main', 'app.module', 'infrastructure'],
  api: ['adapters', 'main', 'app.module', 'infrastructure'],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** Top-level src/ modules (`api`, `config`, ...) that `file` imports. */
function importedModules(file: string): Set<string> {
  const text = readFileSync(file, 'utf8');
  const modules = new Set<string>();
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = relative(SRC, resolve(dirname(file), match[1] as string));
    if (!target.startsWith('..')) {
      modules.add((target.split('/')[0] as string).replace(/\.js$/, ''));
    }
  }
  return modules;
}

describe('layering', () => {
  it.each(Object.keys(FORBIDDEN))('%s depends only inwards', (layer) => {
    const violations = Object.fromEntries(
      sourceFiles(join(SRC, layer))
        .map((file): [string, string[]] => [
          relative(SRC, file),
          [...importedModules(file)].filter((m) => FORBIDDEN[layer]?.includes(m)).sort(),
        ])
        .filter(([, bad]) => bad.length > 0),
    );
    expect(violations).toEqual({});
  });

  it('finds imports at all (guards the guard)', () => {
    expect(importedModules(join(SRC, 'api/documents.controller.ts'))).toContain('application');
  });
});
