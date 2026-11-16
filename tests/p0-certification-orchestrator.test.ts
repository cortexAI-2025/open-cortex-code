import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupOrchestrator(): Promise<{ root: string; out: string; script: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cortex-p0-orchestrator-test-'));
  roots.push(root);
  const scripts = path.join(root, 'p0-vm');
  const out = path.join(root, 'evidence');
  await mkdir(scripts, { recursive: true });
  const orchestrator = path.resolve('lab/p0-vm/11-run-p0-certification.sh');
  const body = await readFile(orchestrator, 'utf8');
  const script = path.join(scripts, '11-run-p0-certification.sh');
  await writeFile(script, body, { mode: 0o755 });

  const stepScripts: Record<string, string> = {
    '00-check-host.sh': 'echo "PASS host-baseline"\n',
    '05-verify-runtime.sh': 'echo "PASS runtime"\n',
    '06-build-runner-image.sh': 'printf "registry.test/runner@sha256:%064d\\n" 0 > "$P0_EVIDENCE_DIR/06-image-reference.txt"\n',
    '07-run-isolation-tests.sh': 'echo "PASS isolation-observed"\n',
    '08-run-storage-tests.sh': 'echo "GLOBAL_WORKSPACE_QUOTA=PASS" > "$P0_EVIDENCE_DIR/08-global-result.txt"\n',
    '09-run-seccomp-tests.sh': 'printf "loaded_profile_hash=sha256:%064d\\n" 0 > "$P0_EVIDENCE_DIR/09-seccomp-status.txt"\n',
    '10-generate-attestation.sh': 'printf \'{"schemaVersion":1,"signature":{"status":"VERIFIED","verifiedBy":"verify-attestation.sh"}}\\n\' > "$P0_EVIDENCE_DIR/10-attestation.json"\n',
  };
  for (const [name, contents] of Object.entries(stepScripts)) {
    await writeFile(path.join(scripts, name), `#!/usr/bin/env bash\nset -eu\n${contents}`, { mode: 0o755 });
  }
  return { root, out, script };
}

function run(script: string, out: string, extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, P0_EVIDENCE_DIR: out, P0_WORKSPACE: '/tmp/workspace', P0_WORKSPACE_QUOTA_BYTES: '1024', P0_PROJECT_ID: '123', ...extraEnv },
    timeout: 15_000,
  });
}

describe('P0 certification orchestrator', () => {
  it('keeps evidence in a unique per-run directory and never certifies declarative proof fields', async () => {
    const { script, out } = await setupOrchestrator();
    const first = run(script, out);
    const second = run(script, out);
    expect(first.status).toBe(77);
    expect(second.status).toBe(77);
    const dirs = (await readdir(out)).filter((entry) => entry.startsWith('run-'));
    expect(dirs).toHaveLength(2);
    for (const dir of dirs) {
      const verdict = await readFile(path.join(out, dir, '11-final-verdict.txt'), 'utf8');
      expect(verdict).toContain('workflowStatus=BLOCKED');
      expect(verdict).toContain('certificationTransition=DISABLED_UNTIL_PROTECTED_SIGNATURE_VERIFICATION_EXISTS');
      expect(verdict).toContain('FAIL / NOT RUN — P0 CERTIFICATION NOT GRANTED');
      expect(verdict).not.toContain('verdict=CERTIFIED');
    }
  });

  it('treats unexpected nonzero step statuses as failure rather than ignoring them', async () => {
    const { script, out, root } = await setupOrchestrator();
    const hostStep = path.join(root, 'p0-vm', '00-check-host.sh');
    await writeFile(hostStep, '#!/usr/bin/env bash\necho "simulated unexpected failure"\nexit 2\n', { mode: 0o755 });
    const result = run(script, out);
    expect(result.status).toBe(1);
    const [dir] = (await readdir(out)).filter((entry) => entry.startsWith('run-'));
    const verdict = await readFile(path.join(out, dir!, '11-final-verdict.txt'), 'utf8');
    const statuses = await readFile(path.join(out, dir!, '11-step-status.tsv'), 'utf8');
    expect(verdict).toContain('FAIL / NOT RUN — P0 CERTIFICATION NOT GRANTED');
    expect(statuses).toContain('00-check-host.sh\t2\t');
  });
});
