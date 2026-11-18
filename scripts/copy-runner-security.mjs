import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const destination = path.join(root, 'dist-server', 'security');
await mkdir(destination, { recursive: true });
await copyFile(path.join(root, 'security', 'seccomp-runner.json'), path.join(destination, 'seccomp-runner.json'));
