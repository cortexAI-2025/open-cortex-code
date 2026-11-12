import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startConnector } from '../server/index.js';
import type { Project, Profile } from '../shared/contracts.js';

/** Real local MCP protocol/engine integration. No LLM prompt or paid/external credential.
 * Fixture speaks the newline JSON-RPC legacy protocol supported by V2.
 * Source contracts: V2 packages/client/src/promise/generated/client.ts,
 * packages/server/src/handlers/mcp.ts and packages/core/src/mcp/client.ts.
 * This test verifies initialize/tools/list and real status only, NOT remote MCP/OAuth/provider generation.
 */
describe('real OpenCode 2.2.7 local MCP handshake (no model generation)', () => {
  it('registers disabled via V2, refuses Ask connect, confirms Agent handshake and removes connection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cortex-real-mcp-'));
    const workspace = path.join(root, 'project'); await mkdir(workspace);
    const logPath = path.join(workspace, 'protocol.jsonl');
    const fixture = path.join(workspace, 'mcp-fixture.cjs');
    await writeFile(fixture, `const{createInterface}=require('node:readline');const{appendFileSync}=require('node:fs');const log=process.argv[2];const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');createInterface({input:process.stdin}).on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}appendFileSync(log,JSON.stringify({method:m.method,id:m.id,hasProviderKey:!!process.env.CORTEX_PROVIDER_KEY,hasEnginePassword:!!process.env.OPENCODE_PASSWORD})+'\\n');if(m.id===undefined)return;if(m.method==='initialize')send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'cortex-fixture',version:'1.0.0'}});else if(m.method==='tools/list')send(m.id,{tools:[{name:'echo',description:'Read-only fixture echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]});else if(m.method==='resources/list')send(m.id,{resources:[]});else if(m.method==='resources/templates/list')send(m.id,{resourceTemplates:[]});else if(m.method==='prompts/list')send(m.id,{prompts:[]});else if(m.method==='tools/call')send(m.id,{content:[{type:'text',text:String(m.params.arguments?.text??'echo')}]});else if(m.method==='ping')send(m.id,{});else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Not found'}})+'\\n');});\n`);
    const connector = await startConnector({port: 0, host: '127.0.0.1', dataDir: path.join(root, 'private-data'), logPairing: false});
    const base = `http://127.0.0.1:${connector.port}`;
    const headers = {authorization: `Bearer ${connector.token}`, 'content-type': 'application/json'};
    const request = async (endpoint: string, method = 'GET', body?: unknown) => {
      const response = await fetch(base + endpoint, {method, headers, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
      return {status: response.status, body: await response.json() as any};
    };
    try {
      const project = await request('/api/projects', 'POST', {name: 'MCP real fixture', path: workspace, trusted: true}); expect(project.status).toBe(201);
      const p = project.body as Project;
      const created = await request(`/api/projects/${p.id}/mcp`, 'POST', {name: 'local-protocol-fixture', type: 'local', command: [process.execPath, fixture, logPath], confirm: true});
      expect(created.status, JSON.stringify(created.body)).toBe(201); expect(created.body.status.status).toBe('disabled');
      const askDenied = await request(`/api/projects/${p.id}/mcp/local-protocol-fixture/connect`, 'POST', {confirm: true}); expect(askDenied.status).toBe(403); expect(askDenied.body.code).toBe('MCP_MODE_DENIED');
      // Profile activates an Agent worker WITHOUT creating/prompting a model session.
      const profile: Profile = {id: 'local-no-generation-fixture', name: 'No generation', providerId: 'ollama', modelId: 'qwen3:1.7b', baseUrl: 'http://127.0.0.1:11434/v1', hasSecret: false, createdAt: new Date().toISOString()};
      connector.context.store.put('profiles', profile);
      await connector.context.engine.activate(p.id, profile.id, 'agent');
      const connected = await request(`/api/projects/${p.id}/mcp/local-protocol-fixture/connect`, 'POST', {confirm: true});
      expect(connected.status, JSON.stringify(connected.body)).toBe(200); expect(connected.body.status.status).toBe('connected');
      const logged = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(logged.some((line) => line.method === 'initialize')).toBe(true); expect(logged.some((line) => line.method === 'tools/list')).toBe(true);
      expect(logged.every((line) => !line.hasProviderKey && !line.hasEnginePassword)).toBe(true);
      const statuses = await request(`/api/projects/${p.id}/mcp`); expect(statuses.status).toBe(200); expect(statuses.body[0].status.status).toBe('connected');
      const removed = await request(`/api/projects/${p.id}/mcp/local-protocol-fixture`, 'DELETE', {confirm: true}); expect(removed.status).toBe(200);
      expect((await request(`/api/projects/${p.id}/mcp`)).body).toEqual([]);
      expect(connector.context.store.all('sessions', p.id)).toEqual([]); // No model session / paid generation.
    } finally { await connector.close(); await rm(root, {recursive: true, force: true}); }
  }, 120_000);
});
