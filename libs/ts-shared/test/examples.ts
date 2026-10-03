/** Loads the golden messages in contracts/examples, shared with the Python tests. */

import { readdirSync, readFileSync } from 'node:fs';

const EXAMPLES = new URL('../../../contracts/examples/', import.meta.url);

export type Contract = 'document-uploaded' | 'extraction-completed';

/** [file name, parsed JSON] for each example of `contract` in `kind`. */
export function examples(contract: Contract, kind: 'valid' | 'invalid'): [string, unknown][] {
  const dir = new URL(`${contract}/${kind}/`, EXAMPLES);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as unknown]);
}
