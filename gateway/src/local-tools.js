// Gateway-native tools (not from any upstream):
//  - job_result: slow calls. Some hosts (Paperclip) cut a tool call off at ~10 s.
//    Any call still running after MCP_ASYNC_AFTER_MS is parked as a job and the
//    client gets {"pending": true, "job_id"}; job_result fetches the real result.
//  - start_lead_run / lead_run_status: run scripts/lead-run.mjs server-side
//    (licence rosters -> Maps + website checks -> Supabase) without an agent loop.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 7 s: Paperclip cuts calls off at ~10 s (8 s measured OK, 13 s cut), so keep ~3 s of margin.
export const ASYNC_AFTER_MS = Number(process.env.MCP_ASYNC_AFTER_MS ?? 7000); // 0 = off
const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_JOBS = 200;
const MAX_WAIT_MS = 7000; // job_result itself must stay under the host's cut-off

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

/** @type {Map<string, {tool: string, started: number, promise: Promise<any>, result?: any, finishedAt?: number}>} */
const jobs = new Map();

function sweep() {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - (j.finishedAt ?? j.started) > JOB_TTL_MS) jobs.delete(id);
  // ponytail: oldest-first eviction past MAX_JOBS; a flood of slow calls could evict an unread result.
  while (jobs.size >= MAX_JOBS) jobs.delete(jobs.keys().next().value);
}

/**
 * Wait up to ASYNC_AFTER_MS for `promise` (which must resolve, never reject).
 * Still running: park it as a job and return a pending note instead.
 */
export async function withEarlyReturn(promise, tool, jobToolName, off) {
  if (!ASYNC_AFTER_MS || off) return promise;
  const PENDING = Symbol('pending');
  const first = await Promise.race([promise, sleep(ASYNC_AFTER_MS).then(() => PENDING)]);
  if (first !== PENDING) return first;
  sweep();
  const id = randomUUID();
  const job = { tool, started: Date.now(), promise };
  jobs.set(id, job);
  promise.then((r) => { job.result = r; job.finishedAt = Date.now(); });
  return text({
    pending: true,
    job_id: id,
    tool,
    note: `Still running after ${ASYNC_AFTER_MS / 1000}s. Call ${jobToolName} with {"job_id":"${id}"} for the result; repeat while it says pending.`,
  });
}

export const JOB_TOOL = {
  name: 'job_result',
  description:
    'Get the result of a tool call that answered {"pending": true, "job_id": ...}. Waits up to wait_s (max 7) for it to finish; ' +
    'if it is still running you get pending again, so call again. Results are kept 30 minutes (a server restart clears them).',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string' },
      wait_s: { type: 'number', description: 'Seconds to wait for completion, 0-7 (default 7).' },
    },
    required: ['job_id'],
  },
};

export async function jobResult(args) {
  const id = String(args?.job_id ?? '');
  const job = jobs.get(id);
  if (!job) return fail(`unknown or expired job_id "${id}" (kept 30 min; a server restart clears them)`);
  const wait = Math.min(Math.max(Number(args?.wait_s ?? 7) || 0, 0) * 1000, MAX_WAIT_MS);
  if (!('result' in job)) await Promise.race([job.promise, sleep(wait)]);
  if ('result' in job) return job.result;
  return text({ pending: true, job_id: id, tool: job.tool, elapsed_s: Math.round((Date.now() - job.started) / 1000) });
}

// ---- lead runs -----------------------------------------------------------
const SCRIPT = fileURLToPath(new URL('../scripts/lead-run.mjs', import.meta.url));
const RUN_DIR = path.join(process.env.MCP_DATA_DIR || '/data', 'lead-runs');
const TRADES = ['plumber', 'electrician'];
const MAX_LIMIT = 200;
/** @type {{id: string, trade: string, offset: number, limit: number, log: string, started: number, exitCode: number|null|undefined} | null} */
let current = null;

export const START_RUN_TOOL = {
  name: 'start_lead_run',
  description:
    'Start a server-side lead run and return at once: Texas licence roster (plumbers: TSBPE, electricians: TDLR; DFW) -> ' +
    'Google Maps lookup -> website check -> businesses with no website are saved to Supabase public."no-Website-lead" ' +
    '(found_on = license:tsbpe / license:tdlr; review_reason not_on_maps marks the weaker ones). About 20 s per business; ' +
    'one run at a time. Continue a roster with offset = the previous run\'s next_offset. Check progress with lead_run_status.',
  inputSchema: {
    type: 'object',
    properties: {
      trade: { type: 'string', enum: TRADES },
      offset: { type: 'integer', minimum: 0, description: 'Roster position to start at (default 0).' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Businesses to check (default 50, max ${MAX_LIMIT}).` },
    },
    required: ['trade'],
  },
};

export const RUN_STATUS_TOOL = {
  name: 'lead_run_status',
  description:
    'Progress of the current (or last) lead run, or of run_id: running, checked, saved, errors, next_offset, last log lines. ' +
    'With no run in this server process, lists recent run logs.',
  inputSchema: { type: 'object', properties: { run_id: { type: 'string' } } },
};

export function startLeadRun(args) {
  const trade = String(args?.trade ?? '');
  const offset = Number(args?.offset ?? 0);
  const limit = Number(args?.limit ?? 50);
  if (!TRADES.includes(trade)) return fail(`trade must be one of ${TRADES.join(', ')}`);
  if (!Number.isInteger(offset) || offset < 0) return fail('offset must be an integer >= 0');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return fail(`limit must be an integer 1-${MAX_LIMIT}`);
  if (current && current.exitCode === undefined) {
    return fail(`a lead run is already going (${current.id}); check lead_run_status, one run at a time`);
  }
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${trade}-${offset}`;
  const log = path.join(RUN_DIR, `${id}.log`);
  const fd = fs.openSync(log, 'a');
  // No shell: arguments are validated values passed as argv.
  const child = spawn(process.execPath, [SCRIPT, trade, String(offset), String(limit)], {
    cwd: path.dirname(path.dirname(SCRIPT)),
    env: process.env,
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  const run = { id, trade, offset, limit, log, started: Date.now(), exitCode: undefined };
  child.on('exit', (code) => { run.exitCode = code; });
  child.on('error', (err) => { run.exitCode = -1; fs.appendFileSync(log, `spawn error: ${err.message}\n`); });
  current = run;
  return text({ started: true, run_id: id, trade, offset, limit, expected_minutes: Math.ceil((limit * 20) / 60) });
}

/** True while a start_lead_run child is going (tile runs wait for it: same browser and budget). */
export const leadRunActive = () => Boolean(current && current.exitCode === undefined);

/** Pure: summarise a lead-run log. */
export function summariseLog(logText) {
  const lines = logText.split('\n').filter(Boolean);
  const count = (re) => lines.filter((l) => re.test(l)).length;
  const done = lines.find((l) => / done \{/.test(l));
  const next = done?.match(/next offset (\d+)/);
  return {
    checked: count(/ (SAVED|skip|maps_lookup error|web_presence error) /),
    saved: count(/ SAVED /),
    saved_on_maps: count(/ SAVED (?!tsbpe:|tdlr:)/),
    errors: count(/ (maps_lookup|web_presence) error /),
    finished: Boolean(done),
    stopped: lines.find((l) => /STOPPED: /.test(l))?.match(/STOPPED: (\w+)/)?.[1] ?? null,
    next_offset: next ? Number(next[1]) : null,
    last_lines: lines.slice(-8),
  };
}

export function leadRunStatus(args) {
  const want = args?.run_id ? String(args.run_id) : current?.id;
  if (!want) {
    const recent = fs.existsSync(RUN_DIR) ? fs.readdirSync(RUN_DIR).filter((f) => f.endsWith('.log')).sort().slice(-5) : [];
    return text({ running: false, note: 'no run started since the server last restarted', recent_logs: recent });
  }
  if (!/^[\w.-]+$/.test(want)) return fail('bad run_id');
  const log = path.join(RUN_DIR, `${want}.log`);
  if (!fs.existsSync(log)) return fail(`no log for run ${want}`);
  const isCurrent = current?.id === want;
  return text({
    run_id: want,
    running: isCurrent ? current.exitCode === undefined : false,
    exit_code: isCurrent ? current.exitCode ?? null : undefined,
    ...(isCurrent ? { trade: current.trade, offset: current.offset, limit: current.limit, elapsed_s: Math.round((Date.now() - current.started) / 1000) } : {}),
    ...summariseLog(fs.readFileSync(log, 'utf8')),
  });
}
