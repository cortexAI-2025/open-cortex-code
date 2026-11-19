/**
 * Recette applicative : pilote le VRAI connecteur (server/index.ts) avec Ollama local.
 *
 * Contrairement à scripts/test-engine.ts (qui lance le moteur directement), ce script passe par
 * les routes HTTP de l'application : projet approuvé, profil, session par mode, prompt,
 * permissions et messages. Il vérifie Ask, Plan et Agent de bout en bout.
 *
 * Aucune réponse n'est simulée. Si Ollama ou le modèle sont absents, le script sort avec le code 2
 * et n'affiche aucun PASS.
 *
 * Usage : pnpm test:recette [--runs N]     (défaut : 1 ; viser 3 pour une preuve de stabilité)
 * Sortie : artifacts/recette-connector.json
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startConnector } from '../server/index.js';

const MODEL = process.env.CORTEX_TEST_MODEL ?? 'qwen3:1.7b';
const OLLAMA = process.env.CORTEX_TEST_OLLAMA ?? 'http://127.0.0.1:11434';
const SESSION_TIMEOUT_MS = 600_000;
const FIXTURE_FILES = ['calculator.js', 'formatter.js'];
const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg >= 0 ? Number(process.argv[runsArg + 1]) : 1;

type Mode = 'ask' | 'plan' | 'agent';
interface ToolPart { name: string; status: string; input?: unknown; output?: string }
interface ChatMessage { id: string; role: string; text: string; tools?: ToolPart[]; error?: string }
interface Check { name: string; passed: boolean; detail?: unknown }
interface SessionRecord { mode: Mode; sessionId: string; decisions: { action: string; resources: string[]; decision: string }[]; messages: ChatMessage[] }

class PrerequisiteError extends Error {}

function sha(buffer: Buffer): string { return createHash('sha256').update(buffer).digest('hex'); }
async function hashes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of ['calculator.js', 'formatter.js', 'calculator.test.js', 'formatter.test.js']) out[f] = sha(await readFile(join(dir, f)));
  return out;
}
function runTests(dir: string): { exitCode: number; output: string } {
  try { return { exitCode: 0, output: execFileSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8' }) }; }
  catch (error) { const e = error as { status: number; stdout?: string; stderr?: string }; return { exitCode: e.status, output: (e.stdout ?? '') + (e.stderr ?? '') }; }
}

/** Vérifie que la recette peut réellement tourner. Sinon, lève PrerequisiteError (aucun résultat simulé). */
async function assertPrerequisites(): Promise<void> {
  let tags: { models?: { name: string }[] };
  try { tags = await (await fetch(`${OLLAMA}/api/tags`)).json() as typeof tags; }
  catch { throw new PrerequisiteError(`Ollama injoignable sur ${OLLAMA}. Recette NON exécutée (aucun résultat simulé).`); }
  if (!tags.models?.some((m) => m.name === MODEL)) throw new PrerequisiteError(`Modèle absent : ${MODEL}. Lancer « ollama pull ${MODEL} ».`);
  const show = await (await fetch(`${OLLAMA}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL }) })).json() as { capabilities?: string[] };
  if (!show.capabilities?.includes('tools')) throw new PrerequisiteError(`Le modèle ${MODEL} ne déclare pas la capacité « tools ».`);
}

async function makeFixture(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'calculator.js'), 'exports.add = (a, b) => a - b;\n');
  await writeFile(join(dir, 'formatter.js'), 'exports.formatTotal = (n) => `${n.toFixed(2)} USD`;\n');
  await writeFile(join(dir, 'calculator.test.js'), "const {test}=require('node:test');const assert=require('node:assert/strict');const {add}=require('./calculator');test('add',()=>assert.equal(add(2,3),5));\n");
  await writeFile(join(dir, 'formatter.test.js'), "const {test}=require('node:test');const assert=require('node:assert/strict');const {formatTotal}=require('./formatter');test('currency',()=>assert.equal(formatTotal(12.5),'12.50 EUR'));\n");
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=Cortex recette', '-c', 'user.email=recette@example.invalid', 'commit', '-qm', 'Initial fixture'], { cwd: dir });
}

/** Politique de l'opérateur de recette : en Agent, seuls les deux fichiers fixtures et « node --test » sont approuvés. */
function decide(mode: Mode, action: string, resources: string[]): 'once' | 'reject' {
  if (mode !== 'agent') return 'reject';
  const editOk = action === 'edit' && resources.every((r) => FIXTURE_FILES.some((f) => r === f || r.endsWith(`/${f}`)));
  const shellOk = action === 'shell' && resources.every((r) => r.startsWith('node --test'));
  return editOk || shellOk ? 'once' : 'reject';
}

async function runRecette(index: number): Promise<{ run: number; checks: Check[]; sessions: SessionRecord[]; diff: string; passed: boolean }> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'cortex-recette-')));
  const workspace = join(root, 'project');
  await makeFixture(workspace);
  const connector = await startConnector({ port: 0, host: '127.0.0.1', dataDir: join(root, 'data'), staticDir: resolve('dist'), quiet: true, logPairing: false });
  const base = `http://127.0.0.1:${connector.port}`;
  const checks: Check[] = [];
  const sessions: SessionRecord[] = [];
  const check = (name: string, passed: boolean, detail?: unknown) => { checks.push({ name, passed, detail }); console.log(`${passed ? 'PASS' : 'FAIL'} [run ${index}] ${name}`); };

  async function api<T>(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${connector.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  }

  try {
    const project = await api<{ id: string }>('/api/projects', 'POST', { name: 'Recette Ollama', path: workspace, trusted: true });
    if (project.status !== 201) throw new Error(`Création projet : HTTP ${project.status}`);
    const profile = await api<{ id: string }>('/api/profiles', 'POST', { name: 'Ollama local', providerId: 'ollama', modelId: MODEL, baseUrl: `${OLLAMA}/v1` });
    if (profile.status !== 201) throw new Error(`Création profil : HTTP ${profile.status}`);
    const projectId = project.body.id;
    const profileId = profile.body.id;

    const initial = runTests(workspace);
    check('Précondition : fixture en échec avant Agent', initial.exitCode !== 0, { exitCode: initial.exitCode });

    const scenarios: { mode: Mode; text: string }[] = [
      { mode: 'ask', text: 'Read calculator.js using a tool. What arithmetic bug is present? Do not modify any file.' },
      { mode: 'plan', text: 'Read formatter.js using the read tool. Plan how to change the currency from USD to EUR. Do not change any file.' },
      { mode: 'agent', text: 'Fix two files: calculator.js add(a,b) must return a+b (currently a-b). formatter.js formatTotal(n) must return n.toFixed(2) followed by a space and EUR (currently USD). Read both files, edit both, then run node --test with the shell tool. Be concise.' },
    ];

    for (const { mode, text } of scenarios) {
      const before = await hashes(workspace);
      const created = await api<{ id: string }>(`/api/projects/${projectId}/sessions`, 'POST', { title: `Recette ${mode}`, profileId, mode });
      check(`${mode} : session créée via l'API`, created.status === 201, { status: created.status });
      const sessionId = created.body.id;
      const promptResult = await api<{ accepted: boolean }>(`/api/sessions/${sessionId}/prompt`, 'POST', { text: `${text} /no_think`, profileId, mode });
      check(`${mode} : prompt accepté (202)`, promptResult.status === 202, { status: promptResult.status, body: promptResult.body });

      const decisions: SessionRecord['decisions'] = [];
      await sleep(2000);
      const deadline = Date.now() + SESSION_TIMEOUT_MS;
      let idleStreak = 0;
      let finished = false;
      while (Date.now() < deadline) {
        const session = await api<{ status: string }>(`/api/sessions/${sessionId}`);
        if (session.body.status === 'permission') {
          idleStreak = 0;
          const pending = await api<{ id: string; action: string; resources: string[] }[]>(`/api/sessions/${sessionId}/permissions`);
          for (const request of pending.body) {
            const decision = decide(mode, request.action, request.resources);
            const reply = await api(`/api/sessions/${sessionId}/permissions/${request.id}`, 'POST', { decision });
            decisions.push({ action: request.action, resources: request.resources, decision: reply.status === 200 ? decision : `HTTP ${reply.status}` });
          }
        } else if (session.body.status === 'running') idleStreak = 0;
        else if (session.body.status === 'error') { check(`${mode} : session sans erreur moteur`, false, session.body); break; }
        else idleStreak++;
        if (idleStreak >= 3) { finished = true; break; }
        await sleep(1000);
      }
      check(`${mode} : session terminée dans le délai`, finished, { timeoutMs: SESSION_TIMEOUT_MS });

      const messages = await api<ChatMessage[]>(`/api/sessions/${sessionId}/messages`);
      const list = messages.body;
      sessions.push({ mode, sessionId, decisions, messages: list });
      const tools = list.flatMap((m) => m.tools ?? []);
      const completed = (re: RegExp) => tools.filter((t) => re.test(t.name) && t.status === 'completed');
      const assistantText = list.filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
      const after = await hashes(workspace);
      const changed = Object.keys(before).filter((f) => before[f] !== after[f]);

      check(`${mode} : réponse texte réelle du modèle`, assistantText.trim().length > 10, { chars: assistantText.length });

      if (mode === 'ask' || mode === 'plan') {
        const file = mode === 'ask' ? 'calculator.js' : 'formatter.js';
        const reads = completed(/^read$/i).filter((t) => JSON.stringify(t.input ?? {}).includes(file));
        check(`${mode} : lecture outil réelle de ${file}`, reads.length > 0, { reads: reads.length });
        check(`${mode} : aucun fichier modifié`, changed.length === 0, { changed });
        check(`${mode} : aucune mutation ni commande exécutée`, completed(/edit|write|patch|shell|bash/i).length === 0, { tools: tools.map((t) => `${t.name}:${t.status}`) });
      }

      if (mode === 'agent') {
        const edits = completed(/edit|write|patch/i);
        const editedFiles = new Set(edits.flatMap((t) => FIXTURE_FILES.filter((f) => JSON.stringify(t.input ?? {}).includes(f))));
        check('agent : modifications réelles des deux fichiers par des outils', FIXTURE_FILES.every((f) => editedFiles.has(f)), { editedFiles: [...editedFiles] });
        const shells = completed(/shell|bash/i).filter((t) => JSON.stringify(t.input ?? {}).includes('node --test'));
        check('agent : exécution de node --test par l\'agent (outil shell)', shells.length > 0, { shells: shells.length });
        const calc = await readFile(join(workspace, 'calculator.js'), 'utf8');
        const fmt = await readFile(join(workspace, 'formatter.js'), 'utf8');
        check('agent : contenu corrigé sur disque (add = a + b)', /return\s+a\s*\+\s*b|=>\s*a\s*\+\s*b/.test(calc), { calc: calc.trim() });
        check('agent : contenu corrigé sur disque (EUR, plus de USD)', fmt.includes('EUR') && !fmt.includes('USD'), { fmt: fmt.trim() });
        const independent = runTests(workspace);
        check('agent : tests de la fixture réussis (exécution indépendante du harness)', independent.exitCode === 0, { exitCode: independent.exitCode, output: independent.output.slice(-400) });
        const forbidden = decisions.filter((d) => d.decision === 'once' && (d.action !== 'edit' && d.action !== 'shell'));
        check('agent : aucune permission hors périmètre approuvée', forbidden.length === 0, { forbidden });
      }

      check(`${mode} : prompt utilisateur présent dans la session moteur`, list.some((m) => m.role === 'user' && m.text.includes(text.slice(0, 40))), { messages: list.length });
    }

    const diff = execFileSync('git', ['diff'], { cwd: workspace, encoding: 'utf8' });
    return { run: index, checks, sessions, diff, passed: checks.every((c) => c.passed) };
  } finally {
    await connector.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = { started: new Date().toISOString(), model: MODEL, provider: 'Ollama local CPU', paidApiCalls: 0, runs: [] };
  const output = resolve('artifacts/recette-connector.json');
  await mkdir(resolve('artifacts'), { recursive: true });
  try {
    await assertPrerequisites();
    for (let i = 1; i <= RUNS; i++) (report.runs as unknown[]).push(await runRecette(i));
    const runs = report.runs as { passed: boolean }[];
    report.passed = runs.every((r) => r.passed);
    report.summary = `${runs.filter((r) => r.passed).length}/${runs.length} exécutions réussies`;
    console.log(report.summary);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    if (error instanceof PrerequisiteError) { report.prerequisite = error.message; report.passed = false; console.error(`PRÉREQUIS ABSENT : ${error.message}`); process.exitCode = 2; }
    else { report.error = error instanceof Error ? error.message : String(error); report.passed = false; console.error('Échec du harness :', report.error); process.exitCode = 1; }
  } finally {
    report.completed = new Date().toISOString();
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log('Rapport :', output);
  }
}

await main();
