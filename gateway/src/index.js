// HTTP entry point: exposes every bundled MCP server over Streamable HTTP.
//
//   POST/GET/DELETE /mcp              -> all servers, tools namespaced <server>__<tool>
//   POST/GET/DELETE /<server>/mcp     -> one server, original tool names
//   GET /health                       -> JSON status of every upstream (no auth)
//   GET /                             -> JSON index of endpoints (no auth)
//
// Auth: if MCP_GATEWAY_TOKEN is set, every /mcp route requires
//   Authorization: Bearer <token>   (or  X-API-Key: <token>)
//
// Sessions: a client initialises once and reuses the `mcp-session-id` header.
// Sessions live in memory, so a redeploy (or the idle sweep) forgets them. A
// request that presents an id this process does not know is not rejected:
// the session is re-created under that same id ("resumed"), so POST, GET and
// DELETE all keep working and the client never sees a 400/404 for it.
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServerCatalog } from './servers.js';
import { Upstream } from './upstream.js';
import { createDownstreamServer } from './downstream.js';
import { initTileRuns, stopTileRuns } from './tile-run.js';

const VERSION = '1.1.0';
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.MCP_GATEWAY_TOKEN || '';
const CORS_ORIGIN = process.env.MCP_CORS_ORIGIN || '';
const SESSION_IDLE_MS = Number(process.env.MCP_SESSION_IDLE_MS || 2 * 60 * 60 * 1000);
const MAX_SESSIONS = Number(process.env.MCP_MAX_SESSIONS || 1000);
const DRAIN_MS = Number(process.env.MCP_DRAIN_MS || 20 * 1000);
const ACCESS_LOG = !/^(0|false|no|off)$/i.test(process.env.MCP_ACCESS_LOG || '1');
const MAX_BODY = 8 * 1024 * 1024;
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
// Session ids we are willing to resume: what we generate (UUIDs) plus anything
// token-shaped. Keeps log lines and the session map free of arbitrary input.
const SESSION_ID_RE = /^[A-Za-z0-9._~-]{8,128}$/;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const log = Object.fromEntries(
  Object.keys(LEVELS).map((lvl) => [
    lvl,
    (msg) => {
      if (LEVELS[lvl] < LEVELS[LOG_LEVEL]) return;
      const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}`;
      (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n');
    },
  ])
);

// ---------------------------------------------------------------------------
// Upstreams
// ---------------------------------------------------------------------------
for (const dir of [process.env.MCP_DATA_DIR || '/data']) {
  try {
    mkdirSync(`${dir}/files`, { recursive: true });
    mkdirSync(`${dir}/playwright-output`, { recursive: true });
  } catch (e) {
    log.warn(`could not create data dir ${dir}: ${e.message}`);
  }
}

const catalog = buildServerCatalog(process.env);
const upstreams = catalog.servers.map((def) => new Upstream(def, log));
const byName = new Map(upstreams.map((u) => [u.name, u]));

for (const s of catalog.skipped) log.info(`[${s.name}] not enabled: ${s.reason}`);
if (!TOKEN) {
  log.warn('MCP_GATEWAY_TOKEN is not set: the /mcp endpoints are UNAUTHENTICATED. Set it before exposing publicly.');
}

// Start all upstreams in parallel; a failing one does not block the gateway.
await Promise.allSettled(upstreams.map((u) => u.connect()));
// Warm tool caches so /health can report counts.
await Promise.allSettled(upstreams.filter((u) => u.status === 'up').map((u) => u.listTools()));
// Server-side Maps tile runs (start_tile_run, TILE_RUN_CRON, active_selectors copy).
initTileRuns({ harvest: byName.get('harvest'), supabase: byName.get('supabase'), log });

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
/** @typedef {{transport: StreamableHTTPServerTransport, server: any, route: string, lastSeen: number, resumed: boolean}} Session */
/** @type {Map<string, Session>} */
const sessions = new Map();
/** In-progress resumes, so two concurrent requests for one unknown id share a session. */
const resuming = new Map();

const short = (id) => String(id).slice(0, 8);

function register(id, transport, server, route, how) {
  if (sessions.size >= MAX_SESSIONS) {
    let oldest;
    for (const [k, s] of sessions) if (!oldest || s.lastSeen < oldest[1].lastSeen) oldest = [k, s];
    if (oldest) {
      log.info(`session ${short(oldest[0])} evicted (limit ${MAX_SESSIONS})`);
      oldest[1].transport.close().catch(() => {});
    }
  }
  sessions.set(id, { transport, server, route, lastSeen: Date.now(), resumed: how === 'resumed' });
  log.info(`session ${short(id)} ${how} on ${route}`);
}

// Servers that get a private subprocess per session on their scoped route, so
// e.g. two agents on /playwright/mcp drive two browsers instead of queueing on
// one. The aggregate /mcp route always uses the shared instance.
// ponytail: a private Chromium lives until the session closes (DELETE, or the 2 h idle sweep); add a per-session idle cap if memory bites.
const PER_SESSION = new Set((process.env.MCP_PER_SESSION_SERVERS ?? 'playwright').split(',').map((s) => s.trim()).filter(Boolean));

function makeTransport(route, targets, aggregate, sessionIdGenerator) {
  let own = null;
  if (!aggregate && PER_SESSION.has(targets[0].name)) {
    own = new Upstream(targets[0].def, log);
    targets = [own];
  }
  const server = createDownstreamServer(targets, {
    aggregate,
    name: aggregate ? 'mcp-full' : `mcp-full/${targets[0].name}`,
    version: VERSION,
    log,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator,
    onsessioninitialized: (id) => register(id, transport, server, route, 'opened'),
  });
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id && sessions.get(id)?.transport === transport) {
      sessions.delete(id);
      log.info(`session ${short(id)} closed`);
    }
    server.close().catch(() => {});
    own?.close().catch(() => {});
  };
  transport.onerror = (err) => log.debug(`session ${short(transport.sessionId ?? '-')} transport: ${err?.message ?? err}`);
  return { transport, server };
}

async function newSession(route, targets, aggregate) {
  const { transport, server } = makeTransport(route, targets, aggregate, () => randomUUID());
  await server.connect(transport);
  return transport;
}

/**
 * Re-create a session under an id this process does not know (the client kept
 * it across a redeploy, or the idle sweep dropped it). The SDK only marks a
 * transport initialised through an `initialize` request, so prime it directly.
 */
function resumeSession(id, route, targets, aggregate) {
  const pending = resuming.get(id);
  if (pending) return pending;
  const p = (async () => {
    const { transport, server } = makeTransport(route, targets, aggregate, () => id);
    await server.connect(transport);
    const inner = transport._webStandardTransport;
    if (!inner || typeof inner.handleRequest !== 'function') throw new Error('unsupported @modelcontextprotocol/sdk transport shape');
    inner.sessionId = id;
    inner._initialized = true;
    register(id, transport, server, route, 'resumed');
    return sessions.get(id);
  })().finally(() => resuming.delete(id));
  resuming.set(id, p);
  return p;
}

function isClosed(session) {
  return Boolean(session.transport._webStandardTransport?._closed);
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) {
      log.info(`session ${short(id)} idle, closing`);
      s.transport.close().catch(() => {});
    }
  }
}, Math.min(60 * 1000, SESSION_IDLE_MS)).unref();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function rpcError(res, status, code, message) {
  return json(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || '';
  let presented = '';
  if (/^bearer\s+/i.test(header)) presented = header.replace(/^bearer\s+/i, '').trim();
  else if (req.headers['x-api-key']) presented = String(req.headers['x-api-key']).trim();
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function applyCors(req, res) {
  if (!CORS_ORIGIN) return;
  res.setHeader('access-control-allow-origin', CORS_ORIGIN);
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-session-id, mcp-protocol-version, x-api-key, last-event-id');
  res.setHeader('access-control-expose-headers', 'mcp-session-id, mcp-protocol-version');
  if (CORS_ORIGIN !== '*') res.setHeader('vary', 'origin');
}

/** Parse "/mcp" or "/<server>/mcp" → { route, targets, aggregate } or null. */
function routeFor(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/mcp') return { route: '/mcp', targets: upstreams, aggregate: true };
  const m = clean.match(/^\/([a-z0-9-]+)\/mcp$/);
  if (m && byName.has(m[1])) return { route: clean, targets: [byName.get(m[1])], aggregate: false };
  return null;
}

function parseJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
}

function isInitialize(body) {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => m && m.method === 'initialize');
}

/** One-line description of a JSON-RPC body for the access log. */
function describeRpc(body) {
  if (!body) return '';
  const msgs = Array.isArray(body) ? body : [body];
  return msgs
    .map((m) => {
      if (!m || typeof m !== 'object') return '?';
      if (m.method === 'tools/call') return `tools/call ${m.params?.name ?? '?'}`;
      if (m.method) return m.method;
      if ('result' in m || 'error' in m) return `response#${m.id}`;
      return '?';
    })
    .join(',');
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------
/** POST requests (tool calls etc.) still being served; shutdown waits for them. */
let inflight = 0;

async function handleMcp(req, res, route, info) {
  const raw = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(raw) ? raw[0] : raw;
  info.sid = sessionId;
  let existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing && isClosed(existing)) {
    sessions.delete(sessionId);
    existing = undefined;
  }
  if (existing && existing.route !== route.route) {
    return rpcError(res, 400, -32000, `session ${short(sessionId)} belongs to ${existing.route}`);
  }

  const body = req.method === 'POST' ? parseJson(await readBody(req)) : undefined;
  info.rpc = describeRpc(body);

  // initialize always starts a fresh session, even if the client sent an old id
  // along with it (the SDK would answer 400 "already initialized" on a live one).
  if (req.method === 'POST' && isInitialize(body)) {
    const transport = await newSession(route.route, route.targets, route.aggregate);
    return transport.handleRequest(req, res, body);
  }

  if (!existing && sessionId) {
    if (!SESSION_ID_RE.test(sessionId)) return rpcError(res, 400, -32000, 'Bad Request: malformed Mcp-Session-Id');
    existing = await resumeSession(sessionId, route.route, route.targets, route.aggregate);
  }

  if (existing) {
    existing.lastSeen = Date.now();
    if (req.method === 'GET') {
      // A client re-opening its notification stream (after a proxy or network
      // drop) must not get 409 because we haven't noticed the old socket died.
      existing.transport.closeStandaloneSSEStream?.();
    }
    return existing.transport.handleRequest(req, res, body);
  }

  // No session id at all.
  if (req.method === 'POST') return handleStateless(req, res, route, body);
  if (req.method === 'DELETE') return rpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
  // GET without a session: there is no stream to attach to. 405 tells SDK
  // clients "no server-initiated stream here" and they carry on.
  res.setHeader('allow', 'POST, DELETE');
  return rpcError(res, 405, -32000, 'Method Not Allowed: open a session with initialize before GET');
}

/** A POST with no session at all: answer it with a throwaway server. */
async function handleStateless(req, res, route, body) {
  const server = createDownstreamServer(route.targets, {
    aggregate: route.aggregate,
    name: route.aggregate ? 'mcp-full' : `mcp-full/${route.targets[0].name}`,
    version: VERSION,
    log,
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  return transport.handleRequest(req, res, body);
}

let shuttingDown = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      const servers = upstreams.map((u) => u.health());
      const allUp = servers.every((s) => s.status === 'up');
      return json(res, allUp ? 200 : 207, {
        ok: allUp,
        version: VERSION,
        uptimeSeconds: Math.round(process.uptime()),
        sessions: sessions.size,
        inflight,
        draining: shuttingDown,
        servers,
        notEnabled: catalog.skipped,
      });
    }

    if (url.pathname === '/') {
      return json(res, 200, {
        name: 'mcp-full',
        version: VERSION,
        transport: 'streamable-http',
        auth: TOKEN ? 'Authorization: Bearer <MCP_GATEWAY_TOKEN>' : 'none',
        endpoints: {
          aggregate: '/mcp',
          servers: Object.fromEntries(upstreams.map((u) => [u.name, `/${u.name}/mcp`])),
          health: '/health',
        },
      });
    }

    const route = routeFor(url.pathname);
    if (!route) return json(res, 404, { error: 'not found' });

    if (!authorized(req)) {
      res.setHeader('www-authenticate', 'Bearer realm="mcp-full"');
      return json(res, 401, { error: 'unauthorized' });
    }

    if (!['GET', 'POST', 'DELETE'].includes(req.method || '')) {
      res.setHeader('allow', 'GET, POST, DELETE');
      return json(res, 405, { error: 'method not allowed' });
    }

    const info = { sid: undefined, rpc: '' };
    const started = Date.now();
    const isCall = req.method === 'POST';
    if (isCall) inflight += 1;
    res.once('close', () => {
      if (isCall) inflight -= 1;
      if (!ACCESS_LOG) return;
      const status = res.headersSent ? res.statusCode : 0;
      const ended = res.writableFinished ? '' : ' (client went away)';
      log.info(
        `${req.method} ${url.pathname} ${status} ${Date.now() - started}ms` +
          `${info.sid ? ` sid=${short(info.sid)}` : ''}${info.rpc ? ` ${info.rpc}` : ''}${ended}`
      );
    });
    await handleMcp(req, res, route, info);
  } catch (err) {
    log.error(`${req.method} ${url.pathname}: ${err?.stack ?? err}`);
    if (!res.headersSent) {
      rpcError(res, err?.status ?? 500, -32603, err?.message ?? 'internal error');
    } else {
      res.end();
    }
  }
});

server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 70 * 1000;

server.listen(PORT, HOST, () => {
  log.info(`mcp-full gateway v${VERSION} listening on http://${HOST}:${PORT}`);
  for (const u of upstreams) {
    const h = u.health();
    log.info(`  /${u.name}/mcp  ${h.status}${h.toolCount != null ? ` (${h.toolCount} tools)` : ''}${h.lastError ? `  ${h.lastError}` : ''}`);
  }
  log.info(`  /mcp  aggregate of ${upstreams.filter((u) => u.status === 'up').length}/${upstreams.length} servers`);
});

// ---------------------------------------------------------------------------
// Shutdown: stop accepting, let in-flight tool calls finish (up to DRAIN_MS),
// then close sessions and upstreams. Railway only honours this if the service
// has a draining window (railway.json deploy.drainingSeconds).
// ---------------------------------------------------------------------------
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, draining (${inflight} in flight, ${sessions.size} sessions)`);
  await stopTileRuns(`server shutdown (${signal})`);
  server.close();
  server.closeIdleConnections?.();
  const deadline = Date.now() + DRAIN_MS;
  while (inflight > 0 && Date.now() < deadline) await sleep(200);
  if (inflight > 0) log.warn(`${inflight} request(s) still in flight after ${DRAIN_MS}ms, closing anyway`);
  else log.info('drained, shutting down');
  await Promise.allSettled([...sessions.values()].map((s) => s.transport.close()));
  await Promise.allSettled(upstreams.map((u) => u.close()));
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error(`unhandledRejection: ${err?.stack ?? err}`));
