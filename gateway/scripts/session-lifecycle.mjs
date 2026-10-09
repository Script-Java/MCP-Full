// Exercises the gateway's session handling end to end: fresh sessions,
// resumed (unknown-id) sessions, GET stream re-open, DELETE, stateless POST.
//
//   node scripts/session-lifecycle.mjs                 # spawns a local gateway with no upstreams
//   node scripts/session-lifecycle.mjs <base> <token>  # runs against a live gateway
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let base = process.argv[2];
let token = process.argv[3] || 'testtoken';
let child;

if (!base) {
  const port = 8765;
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(here, '..', 'src', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      MCP_GATEWAY_TOKEN: token,
      MCP_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'mcp-full-')),
      MCP_DISABLED_SERVERS: 'supabase,github,playwright,filesystem,memory,sequentialthinking,fetch,git,time',
      MCP_SESSION_IDLE_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [gw] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [gw] ${d}`));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
}

const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const rpc = (id, method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const init = rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lifecycle', version: '0' } });

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

async function post(body, sid) {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: sid ? { ...H, 'mcp-session-id': sid } : H, body });
  const text = await r.text();
  return { status: r.status, sid: r.headers.get('mcp-session-id'), text };
}
async function get(sid, ms = 800) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(`${base}/mcp`, { headers: { ...H, accept: 'text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, signal: ac.signal });
    const status = r.status;
    if (r.body) r.body.cancel().catch(() => {});
    clearTimeout(t);
    return status;
  } catch (e) {
    clearTimeout(t);
    return `error:${e.name}`;
  }
}
async function del(sid) {
  const r = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { ...H, 'mcp-session-id': sid } });
  await r.text();
  return r.status;
}

try {
  // 1. normal session
  const a = await post(init);
  check('initialize returns a session id', a.status === 200 && Boolean(a.sid), `status ${a.status}`);
  const b = await post(rpc(2, 'tools/list'), a.sid);
  check('tools/list on live session', b.status === 200 && b.text.includes('"tools"'), `status ${b.status}`);

  // 2. unknown id (as after a redeploy): POST, GET, GET again, DELETE
  const stale = '11111111-2222-3333-4444-555555555555';
  const c = await post(rpc(3, 'tools/list'), stale);
  check('tools/list on unknown session id is served', c.status === 200 && c.text.includes('"tools"'), `status ${c.status}`);
  check('unknown id is kept as the session id', c.sid === stale, `got ${c.sid}`);
  const g1 = await get(stale);
  check('GET stream on resumed session', g1 === 200, `status ${g1}`);
  const g2 = await get(stale);
  check('second GET on same session is not 409', g2 === 200, `status ${g2}`);
  const d1 = await del(stale);
  check('DELETE resumed session', d1 === 200, `status ${d1}`);
  const c2 = await post(rpc(4, 'tools/list'), stale);
  check('POST after DELETE resumes again', c2.status === 200, `status ${c2.status}`);

  // 3. GET straight away on an id nobody has POSTed with (SSE reconnect after redeploy)
  const g3 = await get('66666666-7777-8888-9999-000000000000');
  check('GET on never-seen session id opens a stream', g3 === 200, `status ${g3}`);

  // 4. initialize while holding an old id -> new session, no 400
  const e = await post(init, a.sid);
  check('initialize with an existing id gives a fresh session', e.status === 200 && e.sid && e.sid !== a.sid, `status ${e.status}`);

  // 5. no session id at all
  const f = await post(rpc(5, 'tools/list'));
  check('POST without session id is served statelessly', f.status === 200 && !f.sid, `status ${f.status}`);
  const g4 = await get(undefined);
  check('GET without session id is 405', g4 === 405, `status ${g4}`);
  const h = await post(rpc(6, 'tools/list'), 'bad id!');
  check('malformed session id is 400', h.status === 400, `status ${h.status}`);

  const health = await fetch(`${base}/health`).then((r) => r.json());
  check('health reports sessions', typeof health.sessions === 'number' && health.sessions >= 2, `sessions=${health.sessions}`);

  if (child) {
    await new Promise((r) => setTimeout(r, 11500)); // idle 5s + sweep interval 5s
    const h2 = await fetch(`${base}/health`).then((r) => r.json());
    check('idle sweep closes sessions', h2.sessions === 0, `sessions=${h2.sessions}`);
  }
} finally {
  if (child) child.kill();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
