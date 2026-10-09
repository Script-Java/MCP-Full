import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const [base, token] = process.argv.slice(2);
const t = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, "X-MCP-Async": "off" } } });
const c = new Client({ name: 'verify', version: '0' }, { capabilities: {} });
await c.connect(t);
const { tools } = await c.listTools();
const by = {}; for (const x of tools) { const p = x.name.split('__')[0]; by[p] = (by[p] || 0) + 1; }
console.log('tools by server:', JSON.stringify(by));
const text = (r) => (r.content?.[0]?.text ?? '').replace(/\s+/g, ' ').slice(0, 140);
let r = await c.callTool({ name: 'supabase__get_project_url', arguments: {} }); console.log('supabase url:', text(r));
r = await c.callTool({ name: 'supabase__list_tables', arguments: { schemas: ['public'] } }); console.log('supabase tables:', r.isError ? 'ERROR ' : '', text(r));
r = await c.callTool({ name: 'supabase__execute_sql', arguments: { query: 'create table if not exists public.__mcp_write_probe(id int); insert into public.__mcp_write_probe values (1); drop table public.__mcp_write_probe; select 1 as ok;' } }); console.log('supabase write probe:', r.isError ? 'ERROR ' : 'ok ', text(r).slice(0, 60));
r = await c.callTool({ name: 'github__get_me', arguments: {} }); console.log('github:', r.isError ? 'ERROR ' : '', text(r).slice(0, 80));
r = await c.callTool({ name: 'time__get_current_time', arguments: { timezone: 'UTC' } }); console.log('time:', r.isError ? 'ERROR' : 'ok');
r = await c.callTool({ name: 'memory__read_graph', arguments: {} }); console.log('memory:', r.isError ? 'ERROR' : 'ok');
await t.terminateSession(); await c.close();
