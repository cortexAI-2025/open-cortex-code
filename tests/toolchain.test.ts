import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { safeEnvironment as coreEnvironment, safeToolchainPath } from '../server/security.js';
import { execute, safeEnvironment as commandEnvironment } from '../server/advanced/process.js';

const originalPath = process.env.PATH;
afterEach(() => { process.env.PATH = originalPath; });

describe('toolchains locales sans secrets ambiants', () => {
  it('garde Node réellement installé et refuse les entrées relatives PATH', () => {
    process.env.PATH = `.${path.delimiter}./bin${path.delimiter}/does-not-exist${path.delimiter}${path.dirname(process.execPath)}`;
    const entries = safeToolchainPath().split(path.delimiter);
    expect(entries).toContain(path.dirname(process.execPath));
    expect(entries.every(entry => path.isAbsolute(entry))).toBe(true);
    expect(entries).not.toContain('/does-not-exist');
  });

  it('ne copie ni credentials ni proxies dans les environnements enfants', () => {
    const marker = 'unit-fixture-not-a-real-credential';
    const previous = process.env.CORTEX_UNSAFE_TEST_CREDENTIAL;
    process.env.CORTEX_UNSAFE_TEST_CREDENTIAL = marker;
    try {
      expect(JSON.stringify(coreEnvironment())).not.toContain(marker);
      expect(JSON.stringify(commandEnvironment())).not.toContain(marker);
    } finally {
      if (previous === undefined) delete process.env.CORTEX_UNSAFE_TEST_CREDENTIAL;
      else process.env.CORTEX_UNSAFE_TEST_CREDENTIAL = previous;
    }
  });

  it('exécute vraiment Node depuis le runner nettoyé', async () => {
    const result = await execute('/bin/bash', ['--noprofile', '--norc', '-c', 'node -e "console.log(6*7)"'], { cwd: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('42');
  });
});
