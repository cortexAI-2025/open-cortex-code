import type { Express } from 'express';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import type { Project } from '../../shared/contracts.js';
import { isSensitivePath } from '../security.js';
import { AdvancedError, type Context, confirmed, label, now, project, redact, relativePath, route, safePath, trusted, withProjectLock } from './common.js';
import { execute, git, gitOk, githubEnvironment, type Execution, type RunOptions } from './process.js';

const PROTECTED = new Set(['main', 'master', 'gh-pages', 'trunk', 'head']);

export function isProtectedBranch(name: string): boolean {
  return PROTECTED.has(name.trim().toLowerCase());
}

export function assertBranchToken(name: string): string {
  const value = name.trim();
  if (!value || value.length > 200 || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.lock') || value.includes('..') || value.includes('@{') || value.includes('//') || /[\0\s~^:?*\[\\]/u.test(value)) {
    throw new AdvancedError(400, 'INVALID_BRANCH', 'Nom de branche refusé.');
  }
  return value;
}

/** Branche de travail : jamais main/master/gh-pages/trunk. */
export function assertFeatureBranch(name: string): string {
  const value = assertBranchToken(name);
  if (isProtectedBranch(value)) throw new AdvancedError(403, 'PROTECTED_BRANCH', `La branche « ${value} » est protégée. Aucun commit, checkout créé, ni head de PR sur main, master, gh-pages ou trunk. Aucune fusion.`);
  return value;
}

export function assertCortexBranch(name: string): string {
  const value = assertFeatureBranch(name);
  if (!value.startsWith('cortex/')) throw new AdvancedError(400, 'BRANCH_PREFIX_REQUIRED', 'Les branches créées ici doivent commencer par cortex/.');
  return value;
}

export function githubRepositoryFromRemote(remote: string): string {
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote.trim());
  if (!match?.[1] || match[1].includes('..')) throw new AdvancedError(400, 'GH_REPOSITORY_REQUIRED', 'Origin doit identifier un dépôt github.com sans credentials dans l’URL.');
  return match[1];
}

export interface PullRequestPlan { repo: string; base: string; head: string; title: string; body: string }

/** Argv uniquement. Jamais merge, jamais --force, jamais un shell. */
export function buildPullRequestArgs(plan: PullRequestPlan): string[] {
  const head = assertFeatureBranch(plan.head);
  const base = assertBranchToken(plan.base);
  if (head === base) throw new AdvancedError(400, 'PR_SAME_BRANCH', 'La branche de travail et la base doivent différer.');
  if (isProtectedBranch(head)) throw new AdvancedError(403, 'PROTECTED_BRANCH', 'Refus de proposer une PR depuis une branche protégée.');
  const title = plan.title.trim();
  const body = plan.body.trim();
  if (!title || title.length > 200 || /[\r\n\0]/u.test(title)) throw new AdvancedError(400, 'INVALID_PR', 'Titre de PR invalide.');
  if (!body || body.length > 16_000 || body.includes('\0')) throw new AdvancedError(400, 'INVALID_PR', 'Corps de PR invalide.');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(plan.repo)) throw new AdvancedError(400, 'GH_REPOSITORY_REQUIRED', 'Dépôt GitHub invalide.');
  return ['pr', 'create', '--repo', plan.repo, '--base', base, '--head', head, '--title', title, '--body', body];
}

export type CommandRunner = (executable: string, args: string[], options: RunOptions) => Promise<Execution>;

async function currentBranch(p: Project): Promise<string> {
  const branch = (await gitOk(p, ['branch', '--show-current'])).trim();
  if (!branch) throw new AdvancedError(409, 'DETACHED_HEAD', 'HEAD détaché : aucune publication.');
  return branch;
}

async function localIdentity(p: Project): Promise<void> {
  const name = await git(p, ['config', '--local', 'user.name']);
  const email = await git(p, ['config', '--local', 'user.email']);
  if (name.exitCode !== 0 || email.exitCode !== 0 || !name.output.trim() || !email.output.trim()) {
    throw new AdvancedError(409, 'GIT_IDENTITY_REQUIRED', 'Identité Git locale du dépôt (user.name et user.email) requise. Aucune identité globale ni fictive n’est injectée.');
  }
}

export async function createAndCheckoutFeatureBranch(ctx: Context, p: Project, input: unknown): Promise<{ ok: true; branch: string; checkedOut: true; merged: false }> {
  confirmed(input); trusted(p);
  const body = z.object({ name: label, confirm: z.literal(true) }).strict().parse(input);
  const branch = assertCortexBranch(body.name);
  return withProjectLock(p.id, async () => {
    trusted(ctx.project(p.id));
    await gitOk(p, ['rev-parse', '--verify', 'HEAD']);
    await gitOk(p, ['check-ref-format', '--branch', branch]);
    const exists = await git(p, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (exists.exitCode === 0) throw new AdvancedError(409, 'BRANCH_EXISTS', 'Branche déjà présente. Pas de checkout d’une branche existante.');
    await gitOk(p, ['switch', '-c', branch]);
    ctx.history(p.id, 'feature-branch', 'Branche de travail créée et activée', `${branch}; aucun push ni merge.`);
    return { ok: true, branch, checkedOut: true, merged: false };
  });
}

export async function commitPaths(ctx: Context, p: Project, input: unknown): Promise<{ ok: true; branch: string; pushed: false; merged: false; output: string }> {
  confirmed(input); trusted(p);
  const body = z.object({
    message: z.string().trim().min(1).max(500).refine((value) => !value.includes('\0') && !value.startsWith('-') && !/[\r\n]/u.test(value)),
    paths: z.array(z.string().min(1).max(500)).min(1).max(40),
    confirm: z.literal(true),
  }).strict().parse(input);
  return withProjectLock(p.id, async () => {
    trusted(ctx.project(p.id));
    const branch = assertFeatureBranch(await currentBranch(p));
    await localIdentity(p);
    const paths = [...new Set(body.paths.map((value) => relativePath(value)))];
    for (const rel of paths) {
      if (isSensitivePath(rel)) throw new AdvancedError(403, 'SENSITIVE_FILE', `Chemin sensible refusé : ${rel}`);
      const info = await lstat(await safePath(p, rel)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (!info?.isFile()) throw new AdvancedError(400, 'NOT_REGULAR_FILE', `Fichier régulier requis : ${rel}`);
    }
    await gitOk(p, ['add', '--', ...paths]);
    const committed = await git(p, ['commit', '-m', body.message, '--', ...paths]);
    if (committed.exitCode !== 0 || committed.timedOut || committed.truncated) {
      await git(p, ['restore', '--staged', '--', ...paths]);
      throw new AdvancedError(409, 'GIT_COMMIT_FAILED', redact(ctx, committed.output || 'Commit refusé ou sortie bornée.'));
    }
    const output = redact(ctx, committed.output.trim());
    ctx.history(p.id, 'commit', 'Commit local sur branche de travail', `${branch}: ${redact(ctx, body.message)}; pas de push.`);
    return { ok: true, branch, pushed: false, merged: false, output };
  });
}

export async function openPullRequest(ctx: Context, p: Project, input: unknown, run: CommandRunner = execute): Promise<{ ok: true; url: string | null; branch: string; base: string; merged: false; forced: false; output: string }> {
  confirmed(input); trusted(p);
  const body = z.object({
    base: z.string().trim().min(1).max(200).default('main'),
    title: label,
    body: z.string().trim().min(1).max(16_000),
    confirm: z.literal(true),
    allowPush: z.literal(true),
  }).strict().parse(input);
  return withProjectLock(p.id, async () => {
    trusted(ctx.project(p.id));
    const head = assertFeatureBranch(await currentBranch(p));
    const remote = (await gitOk(p, ['remote', 'get-url', 'origin'])).trim();
    const repo = githubRepositoryFromRemote(remote);
    const args = buildPullRequestArgs({ repo, base: body.base, head, title: body.title, body: body.body });
    if (args.some((arg) => arg === '--force' || arg === '--force-with-lease' || arg === 'merge' || arg === 'pr merge')) {
      throw new AdvancedError(500, 'PR_POLICY', 'Construction d’arguments interdite.');
    }
    let result: Execution;
    try {
      result = await run('gh', args, { cwd: p.path, env: githubEnvironment(), timeoutMs: 20_000, maxOutput: 64 * 1024 });
    } catch (error) {
      throw new AdvancedError(503, 'GH_UNAVAILABLE', redact(ctx, error instanceof Error ? error.message : 'CLI gh indisponible.'));
    }
    const output = redact(ctx, result.output.trim());
    if (result.exitCode !== 0 || result.timedOut || result.truncated) throw new AdvancedError(502, 'PR_CREATE_FAILED', output || 'gh pr create a échoué. Aucune PR n’est considérée ouverte.');
    const url = output.split('\n').map((line) => line.trim()).find((line) => line.startsWith('https://github.com/')) ?? null;
    ctx.history(p.id, 'pull-request', 'Pull request demandée (jamais fusionnée)', `${head} → ${body.base}; ${url ?? 'URL absente de la sortie gh'}`);
    return { ok: true, url, branch: head, base: assertBranchToken(body.base), merged: false, forced: false, output };
  });
}

export function registerGitPublishRoutes(app: Express, ctx: Context): void {
  app.post('/api/projects/:id/git/feature-branch', route(ctx, async (req, res) => res.status(201).json(await createAndCheckoutFeatureBranch(ctx, project(ctx, req), req.body))));
  app.post('/api/projects/:id/git/commit', route(ctx, async (req, res) => res.status(201).json(await commitPaths(ctx, project(ctx, req), req.body))));
  app.post('/api/projects/:id/git/pull-request', route(ctx, async (req, res) => res.status(201).json({ ...await openPullRequest(ctx, project(ctx, req), req.body), createdAt: now() })));
}
