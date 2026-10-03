// Generates contracts/openapi.json, the document service's HTTP API, from
// the compiled service (services/document-service/src/api/openapi.ts), with
// the default settings. Run through `just contracts`, which builds first;
// never edit the output.
//
//   node scripts/generate-openapi.mjs [--check]
//
// --check exits 1 if the committed file is out of date.

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

import { format, resolveConfig } from 'prettier';

const SERVICE = new URL('../services/document-service/', import.meta.url);
const OUTPUT = new URL('../contracts/openapi.json', import.meta.url);

const { buildOpenApiDocument } = await import(new URL('dist/api/openapi.js', SERVICE).href);
const { documentServiceSettings, withDerived } = await import(new URL('dist/config.js', SERVICE).href);
const { loadSettings } = await import(new URL('../libs/ts-shared/dist/index.js', import.meta.url).href);

const { version } = JSON.parse(await readFile(new URL('package.json', SERVICE), 'utf8'));
const document = buildOpenApiDocument(version, withDerived(loadSettings(documentServiceSettings, {})));
const formatted = await format(JSON.stringify(document), { ...(await resolveConfig(OUTPUT)), parser: 'json' });

if (process.argv.includes('--check')) {
  const current = await readFile(OUTPUT, 'utf8').catch(() => '');
  if (current !== formatted) {
    process.stderr.write(`${OUTPUT.pathname} is out of date: run \`just contracts\`\n`);
    process.exit(1);
  }
} else {
  await writeFile(OUTPUT, formatted);
}
