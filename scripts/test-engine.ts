import { OpenCode, type SessionMessageAssistant } from '@opencode/client';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const model = process.env.CORTEX_TEST_MODEL ?? 'qwen3:1.7b';
const output = resolve('artifacts/engine-test.json');
const started = new Date().toISOString();
const root = await mkdtemp(join(tmpdir(), 'cortex-engine-test-'));
const workspace = join(root, 'workspace');
const report: Record<string, unknown> = { started, engineVersion: '2.2.7', model, provider: 'Ollama local CPU', paidApiCalls: 0, fixture: workspace, checks: [], sessions: [] };
const checks = report.checks as Record<string, unknown>[];
const sessions = report.sessions as Record<string, unknown>[];
await mkdir(workspace, { recursive: true });
await mkdir(resolve('artifacts'), { recursive: true });
for (const dir of ['home', 'config', 'data', 'cache']) await mkdir(join(root, dir));
await writeFile(join(workspace, 'calculator.js'), 'exports.add = (a, b) => a - b;\n');
await writeFile(join(workspace, 'formatter.js'), 'exports.formatTotal = (n) => `${n.toFixed(2)} USD`;\n');
await writeFile(join(workspace, 'calculator.test.js'), "const {test}=require('node:test');const assert=require('node:assert/strict');const {add}=require('./calculator');test('add',()=>assert.equal(add(2,3),5));\n");
await writeFile(join(workspace, 'formatter.test.js'), "const {test}=require('node:test');const assert=require('node:assert/strict');const {formatTotal}=require('./formatter');test('currency',()=>assert.equal(formatTotal(5),'5.00 EUR'));\n");
execFileSync('git', ['init', '-q'], { cwd: workspace });
execFileSync('git', ['add', '.'], { cwd: workspace });
execFileSync('git', ['-c','user.name=Cortex test','-c','user.email=test@example.invalid','commit','-qm','Initial fixture'], {cwd: workspace});
let engine: ReturnType<typeof spawn> | undefined;
let engineLogs = '';
const password = randomBytes(32).toString('hex');
const port = 4101;
const baseUrl = `http://127.0.0.1:${port}`;
const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
const client = OpenCode.make({ baseUrl, headers });
const rules = (mutable: boolean) => [
  {action:'*',resource:'*',effect:'deny'},
  {action:'read',resource:'*',effect:'allow'},
  {action:'glob',resource:'*',effect:'allow'},
  {action:'grep',resource:'*',effect:'allow'},
  ...(mutable ? [{action:'edit',resource:'*',effect:'ask'},{action:'shell',resource:'node --test',effect:'ask'}] : []),
  {action:'external_directory',resource:'*',effect:'deny'},
];
const config = {
  update:'disable', share:'disabled', default_agent:'cortex-test-ask',
  model:`ollama/${model}`, snapshots:true,
  providers:{ollama:{settings:{baseURL:'http://127.0.0.1:11434/v1'},models:{[model]:{name:model,capabilities:{tools:true},limit:{context:16384,output:4096}}}}},
  policies:[{action:'plugin.use',resource:'*',effect:'deny'},{action:'mcp.use',resource:'*',effect:'deny'}],
  agents:{
    'cortex-test-ask':{mode:'primary',description:'Read only',system:'Read the requested project file with the read tool, then answer concisely. Do not change files. /no_think',permissions:rules(false),steps:8},
    'cortex-test-plan':{mode:'primary',description:'Read and plan only',system:'Read the named source files, then provide a concise technical plan. No edits or shell. /no_think',permissions:rules(false),steps:8},
    'cortex-test-agent':{mode:'primary',description:'Approved coding fixture',system:'Fix the requested small JavaScript bugs using read and edit tools. Run node --test using shell. Only operate in this test directory. Be concise. /no_think',permissions:rules(true),steps:16},
  },
};
async function save(): Promise<void> { await writeFile(output, JSON.stringify(report, null, 2)+'\n'); }
function record(name: string, passed: boolean, detail: unknown): void {
  checks.push({name,passed,detail}); console.log(`${passed?'PASS':'FAIL'} ${name}`);
}
async function hashes(): Promise<string> {
  const contents = await Promise.all(['calculator.js','formatter.js','calculator.test.js','formatter.test.js'].map(p=>readFile(join(workspace,p))));
  return createHash('sha256').update(Buffer.concat(contents)).digest('hex');
}
function runTests() {
  try { return {exitCode:0,output:execFileSync(process.execPath,['--test'],{cwd:workspace,encoding:'utf8'})}; }
  catch(error) { const e=error as {status:number;stdout?:string;stderr?:string}; return {exitCode:e.status,output:(e.stdout??'')+(e.stderr??'')}; }
}
async function sessionRun(agent: string, text: string): Promise<{id:string;messages: SessionMessageAssistant[]}> {
  const session = await client.session.create({title:agent,agent,model:{id:model,providerID:'ollama'},location:{directory:workspace}});
  console.log('Session réelle créée:',agent,session.id);
  const initial = await client.session.prompt({sessionID:session.id,text:text+' /no_think'});
  let done = false;
  let waitError: unknown;
  const wait = client.session.wait({sessionID:session.id},{signal:AbortSignal.timeout(600000)}).then(()=>{done=true},error=>{done=true;waitError=error});
  const deadline = Date.now()+600000;
  const decisions: unknown[]=[];
  let progress=0;
  while (!done && Date.now()<deadline) {
    const pending = await client.permission.list({sessionID:session.id});
    for (const request of pending) {
      const allowed = agent==='cortex-test-agent' && (request.action==='edit' && request.resources.every(p=>['calculator.js','formatter.js',join(workspace,'calculator.js'),join(workspace,'formatter.js')].includes(p)) || request.action==='shell' && request.resources.every(p=>p==='node --test'));
      await client.permission.reply({sessionID:session.id,requestID:request.id,decision:allowed?'once':'reject'});
      decisions.push({action:request.action,resources:request.resources,decision:allowed?'once':'reject'});
      console.log('Permission fixture:',request.action,allowed?'once':'reject');
    }
    if (Date.now()-progress>10000) { console.log('Session en cours:',agent);progress=Date.now(); }
    await sleep(700);
  }
  await wait;
  if(waitError) throw waitError;
  const all = await client.session.context({sessionID:session.id});
  const messages = all.filter((m):m is SessionMessageAssistant=>m.type==='assistant');
  sessions.push({id:session.id,agent,inputId:initial.id,messages,decisions});
  await save();
  return {id:session.id,messages};
}

try {
  const tags = await fetch('http://127.0.0.1:11434/api/tags').then(r=>r.json()) as {models:{name:string;capabilities:string[]}[]};
  if(!tags.models.some(m=>m.name===model&&m.capabilities.includes('tools'))) throw new Error(`Modèle local compatible outils absent: ${model}`);
  const binary = require.resolve('@opencode/cli/bin/opencode.exe');
  engine = spawn(binary,['serve','--hostname','127.0.0.1','--port',String(port),'--log-level','error'],{
    cwd:workspace,
    env:{PATH:process.env.PATH,HOME:join(root,'home'),XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_CACHE_HOME:join(root,'cache'),OPENCODE_CONFIG_DIR:join(root,'config'),OPENCODE_CONFIG_CONTENT:JSON.stringify(config),OPENCODE_CONFIG_PROJECT_DISABLE:'1',OPENCODE_PASSWORD:password},
    stdio:['ignore','pipe','pipe'],
  });
  const collect=(chunk:Buffer)=>{engineLogs=(engineLogs+chunk.toString().split(password).join('[REDACTED]')).slice(-24000);};
  engine.stdout?.on('data',collect);engine.stderr?.on('data',collect);
  let info;
  for(let i=0;i<100;i++) { try { info=await client.server.info();break;} catch { if(engine.exitCode!==null)throw new Error('Moteur arrêté: '+engineLogs);await sleep(200); } }
  if(!info)throw new Error('Moteur indisponible: '+engineLogs);
  report.server=info;
  record('OpenCode 2.2.7 natif et API V2',info.version==='2.2.7',info.version);
  const noAuth=await fetch(`${baseUrl}/api/info`);
  record('Authentification moteur obligatoire',noAuth.status===401,noAuth.status);
  const before=runTests(); record('Fixture initialement en échec réel',before.exitCode!==0,before);report.initialTests=before;
  const beforeHash=await hashes();
  const ask=await sessionRun('cortex-test-ask','Read calculator.js using a tool. What arithmetic bug is present?');
  record('Ask: réponse LLM réelle et lecture outil',ask.messages.some(m=>m.content.some(c=>c.type==='tool'&&c.name==='read'&&c.state.status==='completed'))&&ask.messages.some(m=>m.content.some(c=>c.type==='text'&&c.text.length>10)),ask.id);
  record('Ask ne modifie aucun fichier',beforeHash===await hashes(),ask.id);
  const plan=await sessionRun('cortex-test-plan','Read formatter.js using the read tool. Plan how to change currency from USD to EUR, without changing any files.');
  record('Plan: réponse réelle sans mutation',plan.messages.some(m=>m.content.some(c=>c.type==='text'&&c.text.length>10))&&beforeHash===await hashes(),plan.id);
  const agent=await sessionRun('cortex-test-agent','Fix two files: calculator.js add(a,b) must return a+b (currently a-b). formatter.js formatTotal(n) must return n.toFixed(2) followed by a space and EUR (currently USD). Read both files, edit both, then run node --test.');
  const after=runTests();report.finalTests=after;
  const diff=execFileSync('git',['diff'],{cwd:workspace,encoding:'utf8'});report.diff=diff;
  record('Agent: modifications multi-fichiers réelles',diff.includes('calculator.js')&&diff.includes('formatter.js'),diff);
  record('Tests de la fixture après Agent',after.exitCode===0,after);
  record('Agent a réellement invoqué shell tests',agent.messages.some(m=>m.content.some(c=>c.type==='tool'&&c.name==='shell'&&c.state.status==='completed')),agent.id);
  await client.session.switchModel({sessionID:ask.id,model:{id:model,providerID:'ollama'}});
  const context=await client.session.context({sessionID:ask.id});
  record('Changement de modèle sur la même session conserve contexte',context.length>0&&context.some(m=>m.type==='assistant'),{sessionId:ask.id,contextMessages:context.length,note:'Même modèle local, contrat switchModel testé; changement inter-fournisseur externe non testé.'});
  report.completed=new Date().toISOString();
  report.passed=checks.every(c=>c.passed);
} catch(error) {
  report.error=error instanceof Error?error.message:String(error);
  report.engineLogs=engineLogs;
  report.passed=false;
  console.error('Échec réel du harness:',report.error);
} finally {
  await save();engine?.kill('SIGTERM');await sleep(500);
}
console.log('Rapport:',output);
if(report.passed!==true)process.exitCode=1;
