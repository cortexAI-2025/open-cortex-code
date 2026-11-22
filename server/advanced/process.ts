import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import type { Express } from 'express';
import { z } from 'zod';
import type { Project, CommandResult } from '../../shared/contracts.js';
import { AdvancedError, type Context, all, confirmed, id, now, project, redact, route, trusted, withProjectLock } from './common.js';
import { safeToolchainPath } from '../security.js';

export interface Execution {
  output: string; exitCode: number | null; signal: string | null; timedOut: boolean; truncated: boolean; durationMs: number;
}
export interface RunOptions { cwd: string; timeoutMs?: number; maxOutput?: number; env?: NodeJS.ProcessEnv }
export function safeEnvironment(home = '/nonexistent'): NodeJS.ProcessEnv {
  return { PATH: safeToolchainPath(), HOME: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'dumb', CI: '1', NO_COLOR: '1' };
}
export function execute(executable: string, args: string[], options: RunOptions): Promise<Execution> {
  const start = Date.now();
  const max = Math.max(1024, Math.min(options.maxOutput ?? 128 * 1024, 2 * 1024 * 1024));
  const timeout = Math.max(50, Math.min(options.timeoutMs ?? 30_000, 120_000));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env ?? safeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    let bytes = 0, timedOut = false, truncated = false;
    const parts: Buffer[] = [];
    const terminate = () => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
    const consume = (chunk: Buffer) => {
      if (bytes < max) parts.push(chunk.subarray(0, max - bytes));
      bytes += chunk.length;
      if (bytes > max) { truncated = true; terminate(); }
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      // Kill surviving children that inherited the process group, even after shell exit.
      terminate();
      resolve({ output: Buffer.concat(parts).toString('utf8'), exitCode, signal, timedOut, truncated, durationMs: Date.now() - start });
    });
  });
}
export interface StoredCommand extends CommandResult { projectId: string; kind: 'command' | 'test'; signal: string | null; timedOut: boolean; truncated: boolean }
export async function runCommand(ctx: Context, p: Project, input: unknown): Promise<StoredCommand> {
  confirmed(input); trusted(p);
  const body = z.object({ command: z.string().min(1).max(16_000).refine((s) => !s.includes('\0')), confirm: z.literal(true), kind: z.enum(['command', 'test']).default('command'), timeoutMs: z.number().int().min(50).max(120_000).optional() }).strict().parse(input);
  return withProjectLock(p.id, async () => {
    ctx.project(p.id); trusted(ctx.project(p.id));
    let result: Execution;
    try { result = await execute('/bin/bash', ['--noprofile', '--norc', '-c', body.command], { cwd: p.path, timeoutMs: body.timeoutMs }); }
    catch (error) { throw new AdvancedError(503, 'RUNNER_UNAVAILABLE', redact(ctx, error instanceof Error ? error.message : 'Runner indisponible.')); }
    const record: StoredCommand = { id: id(), projectId: p.id, kind: body.kind, command: redact(ctx, body.command), ...result, output: redact(ctx, result.output), createdAt: now() };
    ctx.store.put('commands', record, p.id);
    ctx.history(p.id, body.kind === 'test' ? 'test' : 'command', 'Commande exécutée', JSON.stringify({ id: record.id, command: record.command, exitCode: record.exitCode, timedOut: record.timedOut, truncated: record.truncated }));
    return record;
  });
}
export function registerCommandRoutes(app: Express, ctx: Context): void {
  app.get('/api/projects/:id/commands', route(ctx, (req, res) => { const p = project(ctx, req); res.json(all<StoredCommand>(ctx, 'commands', p.id)); }));
  app.post('/api/projects/:id/commands', route(ctx, async (req, res) => { res.json(await runCommand(ctx, project(ctx, req), req.body)); }));
}
export function gitEnvironment(): NodeJS.ProcessEnv {
  return { ...safeEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}
export async function git(p: Project, args: string[], maxOutput = 128 * 1024): Promise<Execution> {
  return execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'diff.external=', ...args], { cwd: p.path, env: gitEnvironment(), maxOutput });
}
export async function gitOk(p: Project, args: string[], maxOutput?: number): Promise<string> {
  const r = await git(p, args, maxOutput);
  if (r.exitCode !== 0 || r.truncated || r.timedOut) throw new AdvancedError(409, 'GIT_FAILED', r.output || 'Commande Git échouée ou bornée.');
  return r.output;
}
function operatorToolchainPath(): string {
  const allowed = new Set(safeToolchainPath().split(path.delimiter));
  const ordered: string[] = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (allowed.has(dir) && !ordered.includes(dir)) ordered.push(dir);
  }
  for (const dir of allowed) if (!ordered.includes(dir)) ordered.push(dir);
  return ordered.join(path.delimiter);
}
export function gitPushEnvironment(): NodeJS.ProcessEnv {
  const env = gitEnvironment();
  // Keep the operator PATH order so a later toolchain directory cannot shadow gh.
  env.PATH = operatorToolchainPath();
  const name = process.env.GH_TOKEN ? 'GH_TOKEN' : process.env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : '';
  if (name) env[name] = process.env[name];
  // Helper expands through gh. The token is not placed in argv or in a file.
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'credential.helper';
  env.GIT_CONFIG_VALUE_0 = '!gh auth git-credential';
  return env;
}
export const githubEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...safeEnvironment(os.homedir()), PATH: operatorToolchainPath(), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  // The sanitized environment would otherwise hide the CLI credential. The value is never written to the store.
  if (process.env.GH_TOKEN) env.GH_TOKEN = process.env.GH_TOKEN;
  else if (process.env.GITHUB_TOKEN) env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  return env;
};
