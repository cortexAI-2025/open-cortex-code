import { dockerRunArgs, defaultPolicy } from '../server/advanced/execution-policy.js';
import { probeDocker } from '../server/advanced/secure-execution.js';

/** Runner reproductible. N’appelle aucun modèle et ne bascule pas vers le runtime local. */
export async function dockerCertificationReport(): Promise<{
  docker: boolean;
  evidence: 'live' | 'absent';
  status: 'BLOCKED' | 'NOT_TESTED';
  sandbox: 'BLOCKED_SANDBOX' | 'NOT_TESTED';
  certified: false;
  fallback: false;
  reason: string;
  image: string;
  prerequisites: string[];
  exampleArgs: string[];
}> {
  const probe = await probeDocker();
  const exampleArgs = dockerRunArgs({
    name: 'cortex-exec-certification',
    image: 'node:22-alpine',
    projectPath: '/tmp/cortex-fixture',
    command: ['node', '--experimental-strip-types', '--test', 'tests/tax.node-test.ts'],
    policy: defaultPolicy({ isolation: 'required', network: 'deny', memoryMb: 256, cpus: 1, maxProcesses: 64 }),
  });
  return {
    docker: probe.available,
    evidence: probe.evidence,
    status: probe.available ? 'NOT_TESTED' : 'BLOCKED',
    sandbox: probe.available ? 'NOT_TESTED' : 'BLOCKED_SANDBOX',
    certified: false,
    fallback: false,
    reason: probe.available ? 'Docker répond. Le correctif modèle n’est pas lancé par ce runner.' : probe.reason,
    image: 'node:22-alpine',
    prerequisites: ['docker info doit répondre', 'image locale node:22-alpine', 'aucun pull automatique', 'socket Docker non monté', 'pas de --privileged'],
    exampleArgs,
  };
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('certify-docker.ts') || entry.endsWith('certify-docker.js')) {
  dockerCertificationReport().then((report) => {
    console.log(JSON.stringify(report));
    if (!report.docker) process.exitCode = 2;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'sonde Docker impossible');
    process.exitCode = 2;
  });
}
