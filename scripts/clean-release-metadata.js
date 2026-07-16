import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
rmSync(path.join(root, 'src', 'release', 'release-metadata.json'), { force: true });
