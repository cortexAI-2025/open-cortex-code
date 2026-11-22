import type { Express } from 'express';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import type { Project } from '../../shared/contracts.js';
import { isSensitivePath } from '../security.js';
import { AdvancedError, type Context, all, confirmed, id, label, now, project, redact, relativePath, route, safePath, trusted, withProjectLock } from './common.js';
import { presentMission, type Mission } from './mission.js';
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

export interface PublishRecord {
  id: string;
  projectId: string;
  branch: string;
  base?: string;
  message?: string;
  files: string[];
  pushed: boolean;
  url: string | null;
  phase: 'commit' | 'push' | 'pull-request' | 'prepare' | 'failed';
  detail: string;
  remoteCertified: false;
  createdAt: string;
}

function remember(ctx: Context, p: Project, record: Omit<PublishRecord, 'id' | 'projectId' | 'createdAt' | 'remoteCertified'>): PublishRecord {
  const stored: PublishRecord = { id: id(), projectId: p.id, createdAt: now(), remoteCertified: false, ...record, detail: redact(ctx, record.detail) };
  return ctx.store.put('publish-log', stored, p.id);
}

export function buildPushArgs(branch: string): string[] {
  const safe = assertFeatureBranch(branch);
  const args = ['push', '--set-upstream', 'origin', safe];
  if (args.some((arg) => arg === '--force' || arg === '--force-with-lease' || arg === '-f')) throw new AdvancedError(500, 'PUSH_POLICY', 'Push forcé interdit.');
  return args;
}

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

export async function commitPaths(ctx: Context, p: Project, input: unknown): Promise<{ ok: true; branch: string; pushed: false; merged: false; remoteCertified: false; files: string[]; output: string }> {
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
    const files = (await gitOk(p, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'])).split('\0').filter(Boolean);
    const same = files.length === paths.length && paths.every((file) => files.includes(file));
    if (!same) {
      remember(ctx, p, { branch, files, pushed: false, url: null, phase: 'failed', message: body.message, detail: `Périmètre inattendu : ${files.join(', ')}` });
      throw new AdvancedError(409, 'COMMIT_SCOPE', `Commit créé mais les fichiers inclus diffèrent de la liste : ${files.join(', ') || 'aucun'}.`);
    }
    remember(ctx, p, { branch, files, pushed: false, url: null, phase: 'commit', message: body.message, detail: `${branch}: ${body.message}` });
    ctx.history(p.id, 'commit', 'Commit local sur branche de travail', `${branch}: ${redact(ctx, body.message)}; fichiers=${files.join(', ')}; pas de push.`);
    return { ok: true as const, branch, pushed: false as const, merged: false as const, remoteCertified: false as const, files, output };
  });
}

export async function pushFeatureBranch(ctx: Context, p: Project, input: unknown, run: CommandRunner = execute, pushGit?: (args: string[]) => Promise<Execution>): Promise<{ ok: true; branch: string; pushed: true; forced: false; merged: false; remoteCertified: false; output: string }> {
  confirmed(input); trusted(p);
  z.object({ confirm: z.literal(true), allowPush: z.literal(true) }).strict().parse(input);
  return withProjectLock(p.id, async () => {
    trusted(ctx.project(p.id));
    const branch = assertFeatureBranch(await currentBranch(p));
    const args = buildPushArgs(branch);
    let auth: Execution;
    try { auth = await run('gh', ['auth', 'status', '--hostname', 'github.com'], { cwd: p.path, env: githubEnvironment(), timeoutMs: 15_000, maxOutput: 32_000 }); }
    catch (error) { throw new AdvancedError(503, 'GH_UNAVAILABLE', redact(ctx, error instanceof Error ? error.message : 'CLI gh indisponible.')); }
    if (auth.exitCode !== 0 || auth.timedOut || auth.truncated) {
      remember(ctx, p, { branch, files: [], pushed: false, url: null, phase: 'failed', detail: auth.output || 'gh non authentifié.' });
      throw new AdvancedError(503, 'GH_AUTH_REQUIRED', redact(ctx, auth.output || 'gh n’est pas authentifié. Aucun push.'));
    }
    const result = await (pushGit ?? ((pushArgs: string[]) => git(p, pushArgs)))(args);
    if (result.exitCode !== 0 || result.timedOut || result.truncated) {
      remember(ctx, p, { branch, files: [], pushed: false, url: null, phase: 'failed', detail: result.output || 'Push refusé.' });
      throw new AdvancedError(502, 'GIT_PUSH_FAILED', redact(ctx, result.output || 'Push refusé. Aucun --force n’a été utilisé.'));
    }
    remember(ctx, p, { branch, files: [], pushed: true, url: null, phase: 'push', detail: `${branch} poussée sans --force.` });
    ctx.history(p.id, 'push', 'Push non forcé', branch);
    return { ok: true, branch, pushed: true, forced: false, merged: false, remoteCertified: false, output: redact(ctx, result.output.trim()) };
  });
}

function provenMissionExists(ctx: Context, p: Project): boolean {
  const missions = all<Mission>(ctx, 'missions', p.id);
  if (!missions.length) return true;
  return missions.some((mission) => presentMission(mission).verdict.complete);
}

/** La PR ne pousse pas elle-même : origin doit déjà porter exactement le HEAD local. */
async function assertRemoteHeadMatches(p: Project, branch: string): Promise<void> {
  const remote = await git(p, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  const local = (await gitOk(p, ['rev-parse', 'HEAD'])).trim();
  if (remote.exitCode !== 0 || remote.timedOut || remote.truncated || remote.output.trim() !== local) {
    throw new AdvancedError(409, 'PUSH_REQUIRED', 'origin ne contient pas ce HEAD. Push explicite requis avant la pull request. Aucun push implicite ni --force.');
  }
}

export async function openPullRequest(ctx: Context, p: Project, input: unknown, run: CommandRunner = execute): Promise<{ ok: true; url: string | null; branch: string; base: string; merged: false; forced: false; remoteCertified: false; output: string }> {
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
    if (!provenMissionExists(ctx, p)) throw new AdvancedError(409, 'MISSION_NOT_PROVEN', 'Une mission du projet est ouverte et aucune n’est prouvée. Pas de pull request.');
    await assertRemoteHeadMatches(p, head);
    const remote = (await gitOk(p, ['remote', 'get-url', 'origin'])).trim();
    const repo = githubRepositoryFromRemote(remote);
    const args = buildPullRequestArgs({ repo, base: body.base, head, title: body.title, body: body.body });
    if (args.some((arg) => arg === '--force' || arg === '--force-with-lease' || arg === 'merge' || arg === 'pr merge')) {
      throw new AdvancedError(500, 'PR_POLICY', 'Construction d’arguments interdite.');
    }
    let auth: Execution;
    try { auth = await run('gh', ['auth', 'status', '--hostname', 'github.com'], { cwd: p.path, env: githubEnvironment(), timeoutMs: 15_000, maxOutput: 32_000 }); }
    catch (error) { throw new AdvancedError(503, 'GH_UNAVAILABLE', redact(ctx, error instanceof Error ? error.message : 'CLI gh indisponible.')); }
    if (auth.exitCode !== 0 || auth.timedOut || auth.truncated) {
      remember(ctx, p, { branch: head, base: body.base, files: [], pushed: false, url: null, phase: 'failed', detail: auth.output || 'gh non authentifié.' });
      throw new AdvancedError(503, 'GH_AUTH_REQUIRED', redact(ctx, auth.output || 'gh n’est pas authentifié. Aucune PR.'));
    }
    let result: Execution;
    try {
      result = await run('gh', args, { cwd: p.path, env: githubEnvironment(), timeoutMs: 20_000, maxOutput: 64 * 1024 });
    } catch (error) {
      throw new AdvancedError(503, 'GH_UNAVAILABLE', redact(ctx, error instanceof Error ? error.message : 'CLI gh indisponible.'));
    }
    const output = redact(ctx, result.output.trim());
    if (result.exitCode !== 0 || result.timedOut || result.truncated) {
      remember(ctx, p, { branch: head, base: body.base, files: [], pushed: false, url: null, phase: 'failed', detail: output || 'gh pr create a échoué.' });
      throw new AdvancedError(502, 'PR_CREATE_FAILED', output || 'gh pr create a échoué. Aucune PR n’est considérée ouverte.');
    }
    const url = output.split('\n').map((line) => line.trim()).find((line) => line.startsWith('https://github.com/')) ?? null;
    remember(ctx, p, { branch: head, base: body.base, files: [], pushed: false, url, phase: 'pull-request', message: body.title, detail: `${head} → ${body.base}; ${url ?? 'URL absente'}` });
    ctx.history(p.id, 'pull-request', 'Pull request demandée (jamais fusionnée, publication non certifiée hors sortie gh)', `${head} → ${body.base}; ${url ?? 'URL absente de la sortie gh'}`);
    return { ok: true, url, branch: head, base: assertBranchToken(body.base), merged: false, forced: false, remoteCertified: false, output };
  });
}

/** Plan local de pull request. N’appelle pas gh, ne pousse pas, ne fusionne pas. */
export async function preparePullRequest(ctx: Context, p: Project, input: unknown, run?: CommandRunner): Promise<{ ok: true; published: false; merged: false; forced: false; remoteCertified: false; plan: { repo: string | null; base: string; head: string; title: string; body: string; argv: string[] | null } }> {
  confirmed(input); trusted(p);
  const body = z.object({
    base: z.string().trim().min(1).max(200).default('main'),
    title: label.optional(),
    body: z.string().trim().min(1).max(16_000).optional(),
    confirm: z.literal(true),
  }).strict().parse(input);
  void run;
  return withProjectLock(p.id, async () => {
    trusted(ctx.project(p.id));
    const head = assertFeatureBranch(await currentBranch(p));
    if (!provenMissionExists(ctx, p)) throw new AdvancedError(409, 'MISSION_NOT_PROVEN', 'Une mission du projet est ouverte et aucune n’est prouvée. Pas de préparation de pull request.');
    const proven = all<Mission>(ctx, 'missions', p.id).map((mission) => presentMission(mission)).find((mission) => mission.verdict.complete);
    const title = (body.title ?? proven?.title ?? 'Mission locale').trim().slice(0, 200);
    const text = (body.body ?? proven?.summary ?? 'Preuve locale uniquement. Cette préparation ne publie rien et ne pousse pas.').trim().slice(0, 16_000);
    if (!title || !text) throw new AdvancedError(400, 'INVALID_PR', 'Titre ou corps de PR vide.');
    let repo: string | null = null;
    const remote = await git(p, ['remote', 'get-url', 'origin']);
    if (remote.exitCode === 0 && !remote.timedOut && !remote.truncated && remote.output.trim()) {
      try { repo = githubRepositoryFromRemote(remote.output.trim()); } catch { repo = null; }
    }
    const argv = repo ? buildPullRequestArgs({ repo, base: body.base, head, title, body: text }) : null;
    remember(ctx, p, { branch: head, base: body.base, files: [], pushed: false, url: null, phase: 'prepare', message: title, detail: argv ? `${head} → ${body.base}; plan local, gh non appelé.` : `${head} → ${body.base}; origin absent, gh non appelé.` });
    ctx.history(p.id, 'pull-request-plan', 'Pull request préparée sans publication', `${head} → ${body.base}; published=false`);
    return { ok: true, published: false, merged: false, forced: false, remoteCertified: false, plan: { repo, base: assertBranchToken(body.base), head, title, body: text, argv } };
  });
}

export async function publishStatus(ctx: Context, p: Project): Promise<{ currentBranch: string; headFiles: string[]; latest: PublishRecord | null; remoteCertified: false }> {
  const latest = all<PublishRecord>(ctx, 'publish-log', p.id).at(-1) ?? null;
  try {
    const currentBranch = (await gitOk(p, ['branch', '--show-current'])).trim();
    const headFiles = (await gitOk(p, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).split('\n').map((file) => file.trim()).filter(Boolean);
    return { currentBranch, headFiles, latest, remoteCertified: false };
  } catch {
    return { currentBranch: '', headFiles: [], latest, remoteCertified: false };
  }
}

export function registerGitPublishRoutes(app: Express, ctx: Context): void {
  app.get('/api/projects/:id/git/publish', route(ctx, async (req, res) => res.json(await publishStatus(ctx, project(ctx, req)))));
  app.post('/api/projects/:id/git/feature-branch', route(ctx, async (req, res) => res.status(201).json(await createAndCheckoutFeatureBranch(ctx, project(ctx, req), req.body))));
  app.post('/api/projects/:id/git/commit', route(ctx, async (req, res) => res.status(201).json(await commitPaths(ctx, project(ctx, req), req.body))));
  app.post('/api/projects/:id/git/push', route(ctx, async (req, res) => res.json(await pushFeatureBranch(ctx, project(ctx, req), req.body))));
  app.post('/api/projects/:id/git/pull-request/prepare', route(ctx, async (req, res) => res.json(await preparePullRequest(ctx, project(ctx, req), req.body))));
  app.post('/api/projects/:id/git/pull-request', route(ctx, async (req, res) => res.status(201).json({ ...await openPullRequest(ctx, project(ctx, req), req.body), createdAt: now() })));
}
