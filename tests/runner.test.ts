import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { RunnerSupervisor, containerIdsMatch, cpuMaxForNanoCpus, hasMappedSubrange, imageDigestMatches, parseIdMap, transitionRunnerState } from '../server/runner.js';

describe('RunnerSupervisor', () => {
  it('does not claim isolation without a pinned image and certified backend', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortex-runner-capability-'));
    const runner = new RunnerSupervisor({ dataDir: root, image: '' });
    const capability = runner.capability();
    expect(capability.available).toBe(false);
    expect(capability.certified).toBe(false);
    expect(capability.isolationLevel).toBe('none');
    expect(['UNAVAILABLE', 'INSTALLED']).toContain(capability.state);
    expect(capability.certified).toBe(false);
    expect(capability.backendAvailable).toBe(false);
    expect(capability.validationAvailable).toBe(false);
    expect(capability.certifiedExecutionAvailable).toBe(false);
  });

  it('fails closed when isolation is unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortex-runner-closed-'));
    const runner = new RunnerSupervisor({ dataDir: root, image: 'ghcr.io/cortexai/opencode-runner@sha256:not-installed' });
    expect(() => runner.requireAvailable()).toThrowError(expect.objectContaining({ code: 'ISOLATION_UNAVAILABLE' }));
  });

  it('does not transition beyond prerequisites without an image or attestation', () => {
    const root = '/tmp/cortex-runner-state-test';
    const runner = new RunnerSupervisor({ dataDir: root, image: '' });
    const capability = runner.capability(true);
    expect(capability.state).not.toBe('CERTIFIED');
    expect(capability.checks.attestation.status).toBe('not_run');
  });

  it('keeps validation and untrusted execution separate', () => {
    const runner = new RunnerSupervisor({ dataDir: '/tmp/cortex-runner-separation-test', image: '' });
    const capability = runner.capability(true);
    expect(capability.certifiedExecutionAvailable).toBe(false);
    expect(() => runner.requireAvailable()).toThrowError(expect.objectContaining({ code: 'ISOLATION_UNAVAILABLE' }));
  });

  it('rejects incomplete or malformed UID/GID mappings', () => {
    const configured = [{ start: 100000, count: 65536 }];
    expect(parseIdMap('0 1000 1')).toEqual([[0, 1000, 1]]);
    expect(hasMappedSubrange(parseIdMap('0 1000 1'), configured)).toBe(false);
    expect(hasMappedSubrange(parseIdMap('1 100000 65535'), configured)).toBe(false);
    expect(hasMappedSubrange(parseIdMap('bad mapping'), configured)).toBe(false);
  });

  it('accepts only a complete configured subordinate range', () => {
    const configured = [{ start: 100000, count: 65536 }];
    expect(hasMappedSubrange(parseIdMap('0 1000 1\n1 100000 65536'), configured)).toBe(true);
    expect(hasMappedSubrange(parseIdMap('0 1000 1\n1 200000 65536'), configured)).toBe(false);
    expect(hasMappedSubrange(parseIdMap('0 1000 1\n1 100000 65537'), configured)).toBe(false);
  });

  it('advances states only with measured proofs and quota', () => {
    expect(transitionRunnerState('PREREQUISITES_VERIFIED', { image: true, attestation: false, validation: false, storageQuota: false, seccompMeasured: false })).toBe('IMAGE_VERIFIED');
    expect(transitionRunnerState('IMAGE_VERIFIED', { image: true, attestation: true, validation: false, storageQuota: false, seccompMeasured: false })).toBe('ATTESTED');
    expect(transitionRunnerState('ATTESTED', { image: true, attestation: true, validation: true, storageQuota: false, seccompMeasured: false })).toBe('VALIDATED');
    expect(transitionRunnerState('VALIDATED', { image: true, attestation: true, validation: true, storageQuota: false, seccompMeasured: true })).toBe('VALIDATED');
    expect(transitionRunnerState('VALIDATED', { image: true, attestation: true, validation: true, storageQuota: true, seccompMeasured: false })).toBe('VALIDATED');
    expect(transitionRunnerState('VALIDATED', { image: true, attestation: true, validation: true, storageQuota: true, seccompMeasured: true })).toBe('CERTIFIED');
  });

  it('revokes an expired proof instead of retaining certification', () => {
    expect(transitionRunnerState('CERTIFIED', { image: true, attestation: true, validation: true, storageQuota: true, seccompMeasured: true, expiresAt: new Date(Date.now() - 1000).toISOString() })).toBe('UNAVAILABLE');
  });

  it('converts NanoCPUs to cgroup v2 quota using the effective period', () => {
    expect(cpuMaxForNanoCpus(500_000_000)).toBe('50000 100000');
    expect(cpuMaxForNanoCpus(1_000_000_000)).toBe('100000 100000');
    expect(cpuMaxForNanoCpus(2_000_000_000)).toBe('200000 100000');
    expect(cpuMaxForNanoCpus(4_000_000_000, 50_000)).toBe('200000 50000');
    expect(cpuMaxForNanoCpus(0)).toBeNull();
    expect(cpuMaxForNanoCpus(2_000_000_000, 0)).toBeNull();
  });

  it('requires exact container identity and exact pinned image digest', async () => {
    const id = 'a'.repeat(64);
    expect(containerIdsMatch(id, id)).toBe(true);
    expect(containerIdsMatch(id, `${id.slice(0, 12)}${'b'.repeat(52)}`)).toBe(false);
    const digest = `sha256:${'c'.repeat(64)}`;
    expect(imageDigestMatches([`registry.test/runner@${digest}`], `registry.test/runner@${digest}`)).toBe(true);
    expect(imageDigestMatches([`registry.test/runner@sha256:${'d'.repeat(64)}`], `registry.test/runner@${digest}`)).toBe(false);
  });

  it('refuses a corrupted or incomplete persisted workflow on restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortex-runner-workflow-'));
    await writeFile(path.join(root, 'runner-certification-workflow.json'), '{"state":"CERTIFIED"}\n');
    const runner = new RunnerSupervisor({ dataDir: root, image: '' });
    expect(runner.capability(true).reason).toContain('Workflow de certification');
    expect(() => runner.requireAvailable()).toThrowError(expect.objectContaining({ code: 'ISOLATION_UNAVAILABLE' }));
  });
});
