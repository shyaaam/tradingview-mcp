import { readFile } from 'node:fs/promises';

const expected = (await readFile(new URL('../docs/runtime/node-version.txt', import.meta.url), 'utf8')).trim();
if (process.versions.node !== expected) {
  console.error(`Node pin mismatch: expected ${expected}, observed ${process.versions.node}`);
  process.exit(1);
}
console.log(`Node pin: ${process.versions.node}`);
