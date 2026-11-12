import { startConnector } from '../server/index.js';
import type { CortexSession, FileContent, KnowledgeDocument, MemoryEntry, Profile, Project, Skill } from '../shared/contracts.js';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const root=await mkdtemp(join(tmpdir(),'cortex-integration-'));
const workspace=join(root,'project-a');const other=join(root,'project-b');
await mkdir(workspace);await mkdir(other);
await writeFile(join(workspace,'sum.js'),'exports.sum=(a,b)=>a+b;\n');
await writeFile(join(workspace,'sum.test.js'),"const{test}=require('node:test');const assert=require('node:assert/strict');test('sum',()=>assert.equal(require('./sum').sum(2,3),5));\n");
await writeFile(join(workspace,'.env'),'DO_NOT_READ=fixture_sensitive_value\n');
execFileSync('git',['init','-q'],{cwd:workspace});execFileSync('git',['add','sum.js','sum.test.js'],{cwd:workspace});
execFileSync('git',['-c','user.name=Cortex test','-c','user.email=test@example.invalid','commit','-qm','Fixture'],{cwd:workspace});
const dataDir=join(root,'data');
let connector=await startConnector({port:0,host:'127.0.0.1',dataDir,staticDir:resolve('dist'),logPairing:false});
let base=`http://127.0.0.1:${connector.port}`;
let token=connector.token;
const checks:Record<string,unknown>[]=[];
const report:Record<string,unknown>={started:new Date().toISOString(),fixture:root,checks,paidApiCalls:0};
function record(name:string,pass:boolean,detail:unknown){checks.push({name,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name}`);}
async function request<T>(path:string,method='GET',body?:unknown,extra:Record<string,string>={}):Promise<T>{
 const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const text=await response.text();if(!response.ok)throw new Error(`${response.status} ${path}: ${text}`);return (text?JSON.parse(text):undefined) as T;
}
async function denied(path:string,method:string,body:unknown,expected:number,extra:Record<string,string>={}){
 const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...extra},...(method==='GET'?{}:{body:JSON.stringify(body)})});return{pass:r.status===expected,status:r.status,body:await r.text()};
}
async function wait(sessionId:string):Promise<CortexSession>{
 const deadline=Date.now()+600000;
 while(Date.now()<deadline){const s=await request<CortexSession>(`/api/sessions/${sessionId}`);if(s.status==='idle'||s.status==='error')return s;await sleep(1000);}
 throw new Error('Session réelle expirée');
}
try{
 const unauth=await fetch(base+'/api/bootstrap');record('Pairing requis',unauth.status===401,unauth.status);
 const wrongOrigin=await denied('/api/bootstrap','GET',undefined,403,{Origin:'https://malicious.example'});record('Origine hostile refusée',wrongOrigin.pass,wrongOrigin);
 const p=await request<Project>('/api/projects','POST',{name:'Projet A',path:workspace,trusted:true});
 const p2=await request<Project>('/api/projects','POST',{name:'Projet B',path:other,trusted:false});
 record('Deux projets réels créés',p.path===workspace&&p2.path===other,[p,p2]);
 const secretFile=await denied(`/api/projects/${p.id}/file?path=.env`,'GET',undefined,403);record('Lecture .env bloquée',secretFile.pass,secretFile.status);
 const traversal=await denied(`/api/projects/${p.id}/file?path=../project-b/file.txt`,'GET',undefined,403);record('Traversée hors projet bloquée',traversal.pass,traversal.status);
 const file=await request<FileContent>(`/api/projects/${p.id}/file?path=sum.js`);
 const writeNoConfirm=await denied(`/api/projects/${p.id}/file`,'PUT',{path:'sum.js',content:file.content,hash:file.hash},400);record('Sauvegarde exige confirmation',writeNoConfirm.pass,writeNoConfirm.status);
 const written=await request<FileContent>(`/api/projects/${p.id}/file`,'PUT',{path:'sum.js',content:file.content+'// reviewed\n',hash:file.hash,confirm:true});
 record('Modification réelle contrôlée',written.content.includes('// reviewed'),written.hash);
 const wrongHash=await denied(`/api/projects/${p.id}/file`,'PUT',{path:'sum.js',content:'BAD',hash:file.hash,confirm:true},409);record('Écrasement concurrent bloqué',wrongHash.pass,wrongHash.status);
 const memory=await request<MemoryEntry>(`/api/projects/${p.id}/memory`,'POST',{kind:'decision',title:'Code projet',content:'Le nom interne du projet est MEMORY42. Conserver cette décision dans les transferts.'});
 const foreign=await request<MemoryEntry[]>(`/api/projects/${p2.id}/memory`);record('Mémoire indépendante',foreign.length===0,memory.id);
 const knowledge=await request<KnowledgeDocument>(`/api/projects/${p.id}/knowledge`,'POST',{name:'architecture.md',content:'# Architecture\nLe calcul de somme utilise une fonction pure. Les métriques observabilité utilisent OpenTelemetry.\n'.repeat(5)});
 const passages=await request<unknown[]>(`/api/projects/${p.id}/knowledge/search?q=observabilit%C3%A9`);record('Knowledge indexée et recherchée',passages.length>0,{documentId:knowledge.id,passages});
 const skill=await request<Skill>(`/api/projects/${p.id}/skills`,'POST',{name:'review-js',description:'Revue JS',content:'Inspecter les fonctions pures et proposer des tests sans modifier de fichiers.'});
 await request(`/api/projects/${p.id}/skills/${skill.id}/export`,'POST',{confirm:true});record('Skill exporté réellement', (await readFile(join(workspace,'.opencode/skills/review-js/SKILL.md'),'utf8')).includes('review-js'),skill.id);
 const result=await request<{exitCode:number;output:string}>(`/api/projects/${p.id}/commands`,'POST',{command:'node --test',kind:'test',confirm:true});record('Exécution réelle des tests du projet',result.exitCode===0,result);
 const untrusted=await denied(`/api/projects/${p2.id}/commands`,'POST',{command:'node --test',confirm:true},403);record('Exécution non isolée sur projet non approuvé refusée',untrusted.pass,untrusted.status);
 const git=await request<{available:boolean;diff:string}>(`/api/projects/${p.id}/git`);record('Git diff réel',git.available&&git.diff.includes('reviewed'),git.diff);
 const checkpoint=await request<{id?:string}>(`/api/projects/${p.id}/git/checkpoint`,'POST',{confirm:true,message:'Before agent'});record('Checkpoint créé',!!checkpoint.id,checkpoint);
 const keyMarker='temporary-fixture-not-a-real-provider-key-928491';
 const secretProfile=await request<Profile>('/api/profiles','POST',{name:'Security fixture',providerId:'security-fixture',modelId:'none',baseUrl:'http://127.0.0.1:11434/v1',apiKey:keyMarker});
 const profileResponse=await request<Profile[]>('/api/profiles');record('Réponse profils ne divulgue pas les clés',!JSON.stringify(profileResponse).includes(keyMarker),secretProfile.id);
 const dbFiles=(await readdir(dataDir)).filter(p=>/sqlite|db/.test(p));let leaked=false;for(const f of dbFiles){if((await readFile(join(dataDir,f))).includes(Buffer.from(keyMarker)))leaked=true;}
 record('Clé fixture absente de SQLite',!leaked,dbFiles);
 const profile=await request<Profile>('/api/profiles','POST',{name:'Ollama test 1.7B',providerId:'ollama',modelId:'qwen3:1.7b',baseUrl:'http://127.0.0.1:11434/v1'});
 const nextProfile=await request<Profile>('/api/profiles','POST',{name:'Ollama test 0.6B',providerId:'ollama',modelId:'qwen3:0.6b',baseUrl:'http://127.0.0.1:11434/v1'});
 const session=await request<CortexSession>(`/api/projects/${p.id}/sessions`,'POST',{title:'Reprise et mémoire',profileId:profile.id,mode:'ask'});
 await request(`/api/sessions/${session.id}/prompt`,'POST',{text:'Réponds très brièvement: quel est le nom interne défini dans la mémoire du projet? Ne lis pas les fichiers. /no_think',profileId:profile.id,mode:'ask'});
 const completed=await wait(session.id);const messages=await request<{role:string;text:string;error?:string}[]>(`/api/sessions/${session.id}/messages`);
 record('Session réelle via connecteur et mémoire transmise',completed.status!=='error'&&messages.some(m=>m.role==='assistant'&&m.text.includes('MEMORY42')),{session:completed,messages});
 await request(`/api/sessions/${session.id}/prompt`,'POST',{text:'Rappelle le nom interne évoqué dans cette même conversation. Une ligne suffit. /no_think',profileId:nextProfile.id,mode:'ask'});
 const switched=await wait(session.id);const afterMessages=await request<{role:string;text:string}[]>(`/api/sessions/${session.id}/messages`);
 record('Changement réel Qwen 1.7B → 0.6B sans perte de session',switched.engineId===session.engineId&&switched.profileId===nextProfile.id&&afterMessages.some(m=>m.role==='assistant'&&m.text.includes('MEMORY42')),{before:session.engineId,after:switched.engineId,profile:switched.profileId,messages:afterMessages});
 report.sessionId=session.id;report.projectId=p.id;report.contextSwitch='Deux modèles Ollama locaux réels; inter-fournisseur commercial non validé.';
 await connector.close();
 connector=await startConnector({port:0,host:'127.0.0.1',dataDir,staticDir:resolve('dist'),logPairing:false});base=`http://127.0.0.1:${connector.port}`;token=connector.token;
 const resumedMemory=await request<MemoryEntry[]>(`/api/projects/${p.id}/memory`);const resumedSession=await request<CortexSession>(`/api/sessions/${session.id}`);const resumedProfiles=await request<Profile[]>('/api/profiles');
 record('Reprise après arrêt et mémoire persistante',resumedMemory.some(m=>m.id===memory.id)&&resumedSession.engineId===session.engineId,{memory:resumedMemory.length,engineId:resumedSession.engineId});
 record('Secrets mémoire oubliés après arrêt',resumedProfiles.every(p=>!p.hasSecret),resumedProfiles.map(p=>({id:p.id,hasSecret:p.hasSecret})));
 const delivery=await request<{tests?:unknown[]}>(`/api/projects/${p.id}/delivery`);report.delivery=delivery;
 record('Livraison contient des preuves et pas un succès inventé',JSON.stringify(delivery).includes('node --test'),delivery);
}catch(error){report.error=error instanceof Error?error.message:String(error);console.error('Blocage réel:',report.error);}
finally{await connector.close();report.completed=new Date().toISOString();report.passed=!report.error&&checks.every(c=>c.pass);await mkdir(resolve('artifacts'),{recursive:true});await writeFile(resolve('artifacts/connector-test.json'),JSON.stringify(report,null,2)+'\n');console.log('Rapport artifacts/connector-test.json');}
if(report.passed!==true)process.exitCode=1;
