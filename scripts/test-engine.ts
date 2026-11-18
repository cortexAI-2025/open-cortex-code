import { OpenCode, type SessionMessageAssistant } from '@opencode/client';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { administratorConfig } from '../server/engine.js';

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
    'cortex-test-ask':{mode:'primary',description:'Read only',system:`${(administratorConfig('ask').agents as Record<string,{system:string}>)['cortex-ask'].system} /no_think`,permissions:rules(false),steps:40},
    'cortex-test-plan':{mode:'primary',description:'Read and plan only',system:`${(administratorConfig('plan').agents as Record<string,{system:string}>)['cortex-plan'].system} /no_think`,permissions:rules(false),steps:4},
    'cortex-test-agent':{mode:'primary',description:'Approved coding fixture',system:`${(administratorConfig('agent').agents as Record<string,{system:string}>)['cortex-agent'].system} /no_think`,permissions:rules(true),steps:40},
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
  const sessionRecord: Record<string,unknown> = {id:session.id,agent,inputId:initial.id,messages:[],decisions};
  sessions.push(sessionRecord);
  await save();
  let progress=0;
  while (!done && Date.now()<deadline) {
    const pending = await client.permission.list({sessionID:session.id});
    for (const request of pending) {
      const allowed = agent==='cortex-test-agent' && (request.action==='edit' && request.resources.every(p=>['calculator.js','formatter.js',join(workspace,'calculator.js'),join(workspace,'formatter.js')].includes(p)) || request.action==='shell' && request.resources.every(p=>p==='node --test'));
      try {
        await client.permission.reply({sessionID:session.id,requestID:request.id,decision:allowed?'once':'reject'});
        decisions.push({action:request.action,resources:request.resources,decision:allowed?'once':'reject'});
        console.log('Permission fixture:',request.action,allowed?'once':'reject',JSON.stringify(request.resources));
      } catch(error) {
        const stillPending=await client.permission.list({sessionID:session.id});
        if(String(error).includes('Permission request not found')&&!stillPending.some(item=>item.id===request.id)) {
          decisions.push({action:request.action,resources:request.resources,decision:'stale-not-pending'});
          console.log('Permission already absent from pending list:',request.action,JSON.stringify(request.resources));
          await save();
          continue;
        }
        throw error;
      }
      await save();
    }
    if (Date.now()-progress>10000) { console.log('Session en cours:',agent);progress=Date.now(); }
    await sleep(700);
  }
  await wait;
  if(waitError) throw waitError;
  const all = await client.session.context({sessionID:session.id});
  const messages = all.filter((m):m is SessionMessageAssistant=>m.type==='assistant');
  sessionRecord.messages=messages;
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
  const ask=await sessionRun('cortex-test-ask','The contract of add(a,b) is to return a+b. Read calculator.js and say whether its implementation conforms; identify any mismatch in one sentence.');
  const askRead=ask.messages.some(m=>m.content.some(c=>c.type==='tool'&&c.name==='read'&&c.state.status==='completed'));
  const askAnswer=ask.messages.flatMap(m=>m.content).filter((c):c is Extract<(typeof ask.messages)[number]['content'][number],{type:'text'}>=>c.type==='text').map(c=>c.text).join('\n');
  const askGrounded=/\badd\b/iu.test(askAnswer)&&(/\ba\s*-\s*b\b/iu.test(askAnswer)||/subtract/iu.test(askAnswer))&&(/\ba\s*\+\s*b\b/iu.test(askAnswer)||/addition/iu.test(askAnswer));
  record('Ask: lecture outil et diagnostic fidèle à la source',askRead&&askGrounded,{sessionId:ask.id,usedReadTool:askRead,groundedAnswer:askGrounded,answer:askAnswer.slice(0,1200)});
  record('Ask ne modifie aucun fichier',beforeHash===await hashes(),ask.id);
  const plan=await sessionRun('cortex-test-plan','Read formatter.js. Its current output uses USD; give me a one-sentence plan to change it to EUR. Do not modify any files.');
  const planTools=plan.messages.flatMap(m=>m.content).filter(c=>c.type==='tool');
  const planInspection=planTools.some(c=>{
    if(!['read','grep','glob','list'].includes(c.name)||c.state.status!=='completed') return false;
    const input=c.state.input;
    return typeof input==='object'&&input!==null&&!Array.isArray(input)&&'path' in input&&String(input.path).split(/[\\/]/u).pop()==='formatter.js';
  });
  const planAnswer=plan.messages.flatMap(m=>m.content).filter((c):c is Extract<(typeof plan.messages)[number]['content'][number],{type:'text'}>=>c.type==='text').map(c=>c.text).join('\n');
  const planGrounded=/\bUSD\b/iu.test(planAnswer)&&/\bEUR\b/iu.test(planAnswer);
  const planReadOnly=!planTools.some(c=>['edit','write','shell','bash'].includes(c.name));
  record('Plan: inspection ciblée, synthèse fondée et sans mutation',planInspection&&planGrounded&&planReadOnly&&beforeHash===await hashes(),{sessionId:plan.id,inspectedFormatter:planInspection,groundedAnswer:planGrounded,readOnlyTools:planReadOnly,answer:planAnswer.slice(0,1000)});
  const agent=await sessionRun('cortex-test-agent','In this workspace, add(2,3) must return 5 and formatTotal(5) must return exactly `5.00 EUR`. First call read on calculator.js, then read on formatter.js. Do not edit either file until both reads succeeded. Make only these replacements: `a - b` to `a + b` in calculator.js, and `USD` to `EUR` in formatter.js. Then call shell with the exact command `node --test` from the workspace root, wait for its output, and report whether the tests pass.');
  const after=runTests();report.finalTests=after;
  const diff=execFileSync('git',['diff'],{cwd:workspace,encoding:'utf8'});report.diff=diff;
  const agentTools=agent.messages.flatMap(m=>m.content).filter(c=>c.type==='tool');
  const readPaths=agentTools.filter(c=>c.name==='read'&&c.state.status==='completed').map(c=>{
    const input=c.state.input;
    return typeof input==='object'&&input!==null&&!Array.isArray(input)&&'path' in input ? String(input.path).split(/[\\/]/u).pop() : '';
  });
  const successfulEdits=agentTools.filter(c=>c.name==='edit'&&c.state.status==='completed').length;
  record('Agent: lectures et éditions acceptées par le moteur',readPaths.includes('calculator.js')&&readPaths.includes('formatter.js')&&successfulEdits>=2,{readPaths,successfulEdits});
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
