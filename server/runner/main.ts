import path from 'node:path';
import { startRunner } from '../advanced/external-runner.js';

const secret = process.env.CORTEX_RUNNER_TOKEN ?? '';
const host = process.env.CORTEX_RUNNER_HOST ?? '127.0.0.1';
const dataDir = process.env.CORTEX_RUNNER_DATA ?? path.join(process.cwd(), '.cortex', 'runner');
const port = Number(process.env.CORTEX_RUNNER_PORT ?? 8791);

if (secret.length < 16) {
  console.error('CORTEX_RUNNER_TOKEN absent ou trop court. Le runner ne démarre pas.');
  process.exit(1);
}

startRunner({ secret, dataDir, host, port: Number.isFinite(port) ? port : 8791 }).then((runner) => {
  process.stdout.write(`RUNNER_READY ${runner.port}\n`);
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Runner arrêté.'}\n`);
  process.exit(1);
});
