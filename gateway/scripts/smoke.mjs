import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2] || 'http://localhost:8765';
const token = process.argv[3] || 'testtoken';
const path = process.argv[4] || '/mcp';

const health = await fetch(`${base}/health`).then((r) => r.json());
console.log('health:', JSON.stringify(health.servers.map((s) => [s.name, s.status, s.toolCount])));

const noAuth = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
console.log('no-auth status:', noAuth.status);

const transport = new StreamableHTTPClientTransport(new URL(`${base}${path}`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'smoke', version: '0.0.1' }, { capabilities: {} });
await client.connect(transport);
console.log('server:', client.getServerVersion(), 'session:', transport.sessionId);
const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(', '));

const pick = (n) => tools.find((t) => t.name === n || t.name.endsWith(`__${n}`));
if (pick('list_allowed_directories')) {
  const r = await client.callTool({ name: pick('list_allowed_directories').name, arguments: {} });
  console.log('filesystem:', r.content?.[0]?.text?.slice(0, 200));
}
if (pick('create_entities')) {
  const r = await client.callTool({ name: pick('create_entities').name, arguments: { entities: [{ name: 'smoke', entityType: 'test', observations: ['works'] }] } });
  console.log('memory:', (r.content?.[0]?.text ?? '').slice(0, 120));
}
if (pick('sequentialthinking')) {
  const r = await client.callTool({ name: pick('sequentialthinking').name, arguments: { thought: 'hi', nextThoughtNeeded: false, thoughtNumber: 1, totalThoughts: 1 } });
  console.log('sequentialthinking:', (r.content?.[0]?.text ?? '').slice(0, 120));
}
if (pick('get_current_time')) {
  const r = await client.callTool({ name: pick('get_current_time').name, arguments: { timezone: 'UTC' } });
  console.log('time:', (r.content?.[0]?.text ?? '').slice(0, 120));
}
if (pick('fetch')) {
  const r = await client.callTool({ name: pick('fetch').name, arguments: { url: 'https://example.com', max_length: 200 } });
  console.log('fetch:', (r.content?.[0]?.text ?? '').slice(0, 120).replace(/\n/g, ' '));
}
if (pick('browser_navigate')) {
  const r = await client.callTool({ name: pick('browser_navigate').name, arguments: { url: 'https://example.com' } });
  console.log('playwright:', (r.content?.[0]?.text ?? '').slice(0, 160).replace(/\n/g, ' '));
  const c = pick('browser_close');
  if (c) await client.callTool({ name: c.name, arguments: {} });
}
if (pick('get_me')) {
  const r = await client.callTool({ name: pick('get_me').name, arguments: {} });
  console.log('github:', (r.content?.[0]?.text ?? '').slice(0, 120).replace(/\n/g, ' '));
}
if (pick('list_projects')) {
  const r = await client.callTool({ name: pick('list_projects').name, arguments: {} });
  console.log('supabase:', (r.content?.[0]?.text ?? '').slice(0, 120).replace(/\n/g, ' '));
}
await transport.terminateSession();
await client.close();
console.log('done');
