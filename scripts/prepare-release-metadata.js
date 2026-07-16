import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const metadataPath = path.join(root, 'src', 'release', 'release-metadata.json');

const commit = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).trim();
execFileSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: root, stdio: 'ignore' });

writeFileSync(metadataPath, `${JSON.stringify({ commit }, null, 2)}\n`, { mode: 0o600 });
