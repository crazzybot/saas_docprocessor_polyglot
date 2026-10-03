// Copies non-TypeScript assets (e.g. SQL migrations) next to the compiled
// output: `node copy-assets.mjs <from> <to>`, relative to the working directory.
import { cp, rm } from 'node:fs/promises';
import process from 'node:process';

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  process.stderr.write('usage: copy-assets.mjs <from> <to>\n');
  process.exit(2);
}
await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true });
