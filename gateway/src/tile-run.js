// Server-side Google Maps tile run: docs/harvester-reference.mjs ported onto this gateway.
// harvest_towns x CATEGORIES -> harvest_tile at 13z (the four subdivide_tile children
// when saturated) -> filter, dedupe -> public."no-Website-lead", logged in search_log
// and harvest_runs. No agent loop, no AI tokens: the harvest and supabase upstreams are
// called over the gateway's own stdio connections.
//  - start_tile_run / tile_run_status: one run at a time, log in /data/tile-runs/<id>.log
//  - TILE_RUN_CRON (America/Chicago) starts runs on a schedule; off when unset
//  - every 5 min the active_selectors row is copied to the harvest server's selectors file
import fs from 'node:fs';
import path from 'node:path';
import { leadRunActive } from './local-tools.js';

const DATA_DIR = process.env.MCP_DATA_DIR || '/data';
const RUN_DIR = path.join(DATA_DIR, 'tile-runs');
export const SELECTORS_FILE = path.join(DATA_DIR, 'harvest', 'active-selectors.json');
const TABLE = 'public."no-Website-lead"';
const MAX_SEARCHES_CAP = 200;
const DEFAULT_MAX_SEARCHES = Number(process.env.TILE_RUN_MAX_SEARCHES || 30);
const MAX_MINUTES = Number(process.env.TILE_RUN_MAX_MINUTES || 45);
const MIN_DELAY_MS = Number(process.env.TILE_RUN_MIN_DELAY_MS ?? 12000);
const MAX_DELAY_MS = Number(process.env.TILE_RUN_MAX_DELAY_MS ?? 30000);
const SELECTOR_REFRESH_MS = 5 * 60 * 1000;
const CRON_TZ = 'America/Chicago';

export const CATEGORIES = [
  'plumber', 'hvac contractor', 'roofing contractor', 'electrician', 'landscaping service',
  'lawn care service', 'tree service', 'pest control service', 'fence contractor',
  'concrete contractor', 'painter', 'handyman', 'garage door service', 'pressure washing service',
  'auto repair shop', 'appliance repair service', 'flooring contractor', 'junk removal service',
  'locksmith', 'welding service', 'mobile mechanic', 'towing service', 'septic service', 'moving company',
];
// subdivide_tile returns its children in this order (north row west->east, then south row).
const SUB_AREAS = ['NW', 'NE', 'SW', 'SE'];
const TX_BOX = { minLat: 25.83, maxLat: 36.51, minLng: -106.65, maxLng: -93.5 };
const SOCIAL_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|linktr\.ee)$/i;
const INSERT_COLS = ['name', 'category', 'address', 'phone', 'city', 'rating', 'review_count', 'google_maps_url',
  'source_id', 'zip', 'name_norm', 'phone_e164', 'website_class', 'social_or_notes', 'found_on', 'state', 'selector_version'];

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pure helpers (gateway/scripts/tile-run-check.mjs) --------------------
const norm = (s) => (s || '').toLowerCase().replace(/,\s*tx$/i, '').trim();

export function nameNorm(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(llc|inc|corp|co)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export const phone10 = (p) => {
  const d = String(p ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
};

/** A Maps CID as a decimal string: harvest_tile gives decimal; hex (0x...) and ?cid= URLs are converted. */
export function cidToDecimal(cid, mapsUrl) {
  const s = String(cid ?? '').trim();
  if (/^\d{1,20}$/.test(s)) return BigInt(s).toString(10);
  if (/^0x[0-9a-f]{1,16}$/i.test(s)) return BigInt(s).toString(10);
  const m = String(mapsUrl ?? '').match(/[?&]cid=(\d{1,20})\b/) ?? String(mapsUrl ?? '').match(/0x[0-9a-f]+:(0x[0-9a-f]{1,16})/i);
  return m ? BigInt(m[1]).toString(10) : null;
}

export function coordsFromUrl(url) {
  const m = String(url ?? '').match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}

function websiteParts(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, href: u.origin + u.pathname };
  } catch {
    return { host: null, href: null };
  }
}

/** SQL literal. Card text is untrusted: quotes doubled, NULs dropped; '' and null -> NULL. */
export function lit(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'NULL';
    return `'${v}'`;
  }
  return `'${String(v).replace(/\0/g, '').replace(/'/g, "''")}'`;
}
const textArray = (vals) => `array[${vals.map(lit).join(',')}]::text[]`;

/**
 * Card filters (reference processCards, first half): websites (social links kept),
 * sponsored, closed, incomplete, outside Texas / within ~50 m of a spam pin, in-search dupes.
 */
export function filterCards(cards, spam) {
  const stats = { seen: cards.length, inserted: 0, dupes: 0, outOfArea: 0, closed: 0, incomplete: 0, websites: 0 };
  const cand = [];
  const seenInBatch = new Set();
  for (const c of cards) {
    const web = c.has_website ? websiteParts(c.website_url) : { host: null, href: null };
    const social = Boolean(c.has_website && web.host && SOCIAL_HOSTS.test(web.host));
    if (c.has_website && !social) { stats.websites++; continue; }
    if (c.sponsored) continue;
    if (c.closed) { stats.closed++; continue; }
    const sourceId = cidToDecimal(c.maps_cid, c.maps_url);
    if (!c.name || !sourceId || (!c.phone && !c.address_line)) { stats.incomplete++; continue; }
    const ll = c.lat != null && c.lng != null ? { lat: Number(c.lat), lng: Number(c.lng) } : coordsFromUrl(c.maps_url);
    if (ll) {
      const inTx = ll.lat >= TX_BOX.minLat && ll.lat <= TX_BOX.maxLat && ll.lng >= TX_BOX.minLng && ll.lng <= TX_BOX.maxLng;
      const isSpam = spam.some((s) => Math.abs(Number(s.lat) - ll.lat) < 0.0005 && Math.abs(Number(s.lng) - ll.lng) < 0.0005);
      if (!inTx || isSpam) { stats.outOfArea++; continue; }
    }
    const p10 = phone10(c.phone);
    const key = p10 || `n:${nameNorm(c.name)}`;
    if (seenInBatch.has(key)) { stats.dupes++; continue; }
    seenInBatch.add(key);
    cand.push({
      name: c.name, category: c.category_label ?? null, address: c.address_line ?? null, phone: c.phone ?? null,
      rating: c.rating ?? null, reviews: c.review_count ?? null, sourceId, p10, nn: nameNorm(c.name),
      social, webHref: social ? web.href || web.host : null,
    });
  }
  return { stats, cand };
}

/** Insert statements, 50 rows each, for candidates that passed dedupe. */
export function buildInserts(fresh, ctx, selectorVersion) {
  const out = [];
  for (let i = 0; i < fresh.length; i += 50) {
    const values = fresh.slice(i, i + 50).map((c) => `(${[
      c.name, c.category, c.address, c.phone, ctx.city, c.rating, c.reviews,
      `https://www.google.com/maps?cid=${c.sourceId}`, c.sourceId,
      (c.address || '').match(/\b(7[5-9]\d{3})\b/)?.[1] || null,
      c.nn, c.p10 ? `+1${c.p10}` : null,
      c.social ? 'social_only' : 'none', c.social ? c.webHref : null,
      `${ctx.category} @${ctx.lat},${ctx.lng},${ctx.zoom}z`, 'harvested', selectorVersion,
    ].map(lit).join(',')})`);
    out.push(`insert into ${TABLE} (${INSERT_COLS.join(',')}) values ${values.join(',')} on conflict (source_id) do nothing returning source_id`);
  }
  return out;
}

/**
 * What to search next (reference nextWork, minus the geocoding): a city+category with sub-areas
 * already searched but no 'done' row comes first, then towns by priority x CATEGORIES.
 */
export function planWork(logRows, towns, sessionDone) {
  const sample = logRows.find((r) => r.city);
  const cityLabel = (c) => (sample && /,\s*tx$/i.test(sample.city) ? `${c}, TX` : c);
  const byKey = new Map();
  for (const r of logRows) {
    const k = `${norm(r.city)}|${(r.category || '').toLowerCase()}`;
    if (!byKey.has(k)) byKey.set(k, { done: false, subs: new Set() });
    const e = byKey.get(k);
    if (r.status === 'done') e.done = true;
    const s = (r.sub_area || 'center').toLowerCase();
    for (const a of ['nw', 'ne', 'sw', 'se']) if (new RegExp(`\\b${a}\\b`).test(s)) e.subs.add(a.toUpperCase());
    if (/center|full|whole/.test(s)) e.subs.add('center');
  }
  for (const partialOnly of [true, false]) {
    for (const t of towns) {
      for (const cat of CATEGORIES) {
        const key = `${norm(t.city)}|${cat}`;
        const e = byKey.get(key);
        if (e?.done || sessionDone.has(key) || (partialOnly && !e?.subs.size)) continue;
        return { key, town: t, city: cityLabel(t.city), category: cat, already: e ? e.subs : new Set() };
      }
    }
  }
  return null;
}

// Minimal 5-field cron: minute hour day-of-month month day-of-week; *, a-b, lists, /step.
const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
export function parseCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron needs 5 fields: minute hour day-of-month month day-of-week');
  return parts.map((field, i) => {
    const [lo, hi] = CRON_RANGES[i];
    const set = new Set();
    for (const item of field.split(',')) {
      const m = item.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
      if (!m) throw new Error(`bad cron field "${field}"`);
      let [a, b] = m[1] === '*' ? [lo, hi] : m[1].split('-').map(Number);
      if (b === undefined) b = m[2] ? hi : a;
      const step = m[2] ? Number(m[2]) : 1;
      if (a < lo || b > hi || a > b || step < 1) throw new Error(`cron field "${field}" out of range ${lo}-${hi}`);
      for (let v = a; v <= b; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    return { set, any: field === '*' };
  });
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function cronMatches(fields, date, tz = CRON_TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  const [mi, h, dom, mon, dow] = fields;
  if (!mi.set.has(Number(p.minute)) || !h.set.has(Number(p.hour)) || !mon.set.has(Number(p.month))) return false;
  const domOk = dom.set.has(Number(p.day));
  const dowOk = dow.set.has(WEEKDAYS.indexOf(p.weekday));
  // Classic cron: when both day fields are restricted, either may match.
  return dom.any || dow.any ? domOk && dowOk : domOk || dowOk;
}

// ---- upstream access --------------------------------------------------------
/** @type {{harvest?: any, supabase?: any, log: any} | null} */
let deps = null;

async function callJson(up, name, args) {
  try {
    const r = await up.callTool(name, args);
    const t = r.content?.[0]?.text ?? '';
    try { return JSON.parse(t); } catch { return { raw: t, isError: r.isError }; }
  } catch (err) {
    return { error: 'internal', reason: String(err?.message ?? err).slice(0, 300) };
  }
}

// supabase execute_sql answers {"result": "...<untrusted-data-ID>\n[rows]\n</untrusted-data-ID>"}.
async function sql(query) {
  const r = await callJson(deps.supabase, 'execute_sql', { query });
  const body = r.result ?? r.raw ?? '';
  const m = body.match(/<untrusted-data-([\w-]+)>\n([\s\S]*?)\n<\/untrusted-data-\1>/);
  if (!m) throw new Error(`sql failed: ${(body || JSON.stringify(r)).slice(0, 300)}`);
  return JSON.parse(m[2]);
}

let lastGeocode = 0;
async function geocode(city) {
  const wait = lastGeocode + 1100 - Date.now(); // Nominatim policy: max 1 request/second
  if (wait > 0) await sleep(wait);
  lastGeocode = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(`${city}, Texas`)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'unasystems-harvester/1.0 (lead research)' }, signal: AbortSignal.timeout(20000) });
  const [hit] = await res.json();
  if (!hit || !Number.isFinite(Number(hit.lat)) || !Number.isFinite(Number(hit.lon))) throw new Error(`could not geocode ${city}`);
  return { lat: Number(hit.lat), lng: Number(hit.lon) };
}

/** Copy the active_selectors row to the harvest server's file; no row, or table unreadable: remove it (built-ins). */
export async function refreshSelectors() {
  if (!deps?.supabase) return;
  try {
    const rows = await sql('select selectors, version from active_selectors limit 1');
    if (!rows.length) {
      fs.rmSync(SELECTORS_FILE, { force: true });
      return;
    }
    const body = JSON.stringify({ version: rows[0].version, selectors: rows[0].selectors });
    let old = null;
    try { old = fs.readFileSync(SELECTORS_FILE, 'utf8'); } catch {}
    if (old === body) return;
    fs.mkdirSync(path.dirname(SELECTORS_FILE), { recursive: true });
    fs.writeFileSync(`${SELECTORS_FILE}.tmp`, body);
    fs.renameSync(`${SELECTORS_FILE}.tmp`, SELECTORS_FILE);
    deps.log.info(`[tile-run] active_selectors ${rows[0].version} copied to ${SELECTORS_FILE}`);
  } catch (err) {
    deps.log.warn(`[tile-run] active_selectors unreadable, harvest falls back to built-in selectors: ${err?.message ?? err}`);
    try { fs.rmSync(SELECTORS_FILE, { force: true }); } catch {}
  }
}

// ---- the run ----------------------------------------------------------------
/** @type {any} */
let current = null;

export const START_TILE_RUN_TOOL = {
  name: 'start_tile_run',
  description:
    'Start a server-side Google Maps harvest run and return at once: towns from harvest_towns (priority order) x 24 trade ' +
    'categories, resuming from search_log; each search is harvest_tile at 13z, split into four 14z sub-areas when saturated. ' +
    'Businesses with no website (or only Facebook/Instagram/Linktree) go to public."no-Website-lead"; one harvest_runs row ' +
    'per run (runner server). Stops at once on a Google challenge or a broken selector. 12-30 s pause between searches; ' +
    'one run at a time. dry_run=true searches and reports but writes nothing to the database. Check progress with tile_run_status.',
  inputSchema: {
    type: 'object',
    properties: {
      max_searches: { type: 'integer', minimum: 1, maximum: MAX_SEARCHES_CAP, description: `Maps searches this run (default ${DEFAULT_MAX_SEARCHES}).` },
      dry_run: { type: 'boolean', description: 'Search and count what would be inserted, but write nothing (no leads, search_log, harvest_runs or geocodes).' },
    },
  },
};

export const TILE_RUN_STATUS_TOOL = {
  name: 'tile_run_status',
  description:
    'Progress of the current (or last) tile run, or of run_id: running, status, stop_reason, searches, cards_seen, inserted, ' +
    'duplicates, out_of_area, last log lines. With no run in this server process, lists recent run logs.',
  inputSchema: { type: 'object', properties: { run_id: { type: 'string' } } },
};

export function startTileRun(args, trigger = 'tool') {
  const max = Number(args?.max_searches ?? DEFAULT_MAX_SEARCHES);
  if (!Number.isInteger(max) || max < 1 || max > MAX_SEARCHES_CAP) return fail(`max_searches must be an integer 1-${MAX_SEARCHES_CAP}`);
  if (args?.dry_run !== undefined && typeof args.dry_run !== 'boolean') return fail('dry_run must be true or false');
  const dry = args?.dry_run === true;
  if (!deps?.harvest || !deps?.supabase) return fail('tile runs need the harvest and supabase servers (is SUPABASE_ACCESS_TOKEN set?)');
  if (current?.running) return fail(`a tile run is already going (${current.id}); check tile_run_status, one run at a time`);
  if (leadRunActive()) return fail('a lead run (start_lead_run) is going; it shares the Maps browser and budget, start the tile run after it');
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-tiles-${max}${dry ? '-dry' : ''}`;
  const file = path.join(RUN_DIR, `${id}.log`);
  const rec = {
    id, trigger, dry, maxSearches: max, file, started: Date.now(), running: true, harvestRunId: null,
    status: 'running', stopReason: null, selectorVersion: null, stopRequested: null,
    totals: { searches: 0, seen: 0, inserted: 0, dupes: 0, outOfArea: 0 },
    log: (...a) => fs.appendFileSync(file, `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}\n`),
  };
  current = rec;
  runLoop(rec).catch((err) => deps.log.error(`[tile-run] ${err?.stack ?? err}`));
  return text({ started: true, run_id: id, max_searches: max, dry_run: dry, trigger, expected_minutes: Math.ceil((max * 50) / 60) });
}

async function runLoop(rec) {
  const { totals } = rec;
  const minutes = () => (Date.now() - rec.started) / 60000;
  const where = (category, city, subArea) => `${category} ${city} ${subArea}`;
  let status = 'ok';
  let stopReason = null;
  rec.log(`tile run ${rec.id}: max ${rec.maxSearches} searches (${rec.trigger})${rec.dry ? ', DRY RUN: nothing is written' : ''}`);
  const geocoded = new Map(); // dry runs don't save geocodes, so remember them for the run
  try {
    const [run] = rec.dry ? [] : await sql(`insert into harvest_runs (runner, notes) values ('server', ${lit(`server; ${rec.id} (${rec.trigger})`)}) returning id`);
    rec.harvestRunId = run?.id ?? null;
    await refreshSelectors();
    const spam = await sql('select lat, lng from spam_coords');
    const sessionDone = new Set();
    let zeroWebsiteStreak = 0;
    const zeroWebsiteIds = [];

    const logSearch = async (ctx, stats, st, notes) => {
      if (rec.dry) return null;
      const [row] = await sql(`insert into search_log (city, category, sub_area, zoom, cards_seen, inserted, duplicates_skipped, out_of_area, status, notes) values (${
        [ctx.city, ctx.category, ctx.subArea, ctx.zoom, stats.seen, stats.inserted, stats.dupes, stats.outOfArea, st, notes].map(lit).join(',')}) returning id`);
      return row?.id ?? null;
    };

    outer: while (totals.searches < rec.maxSearches) {
      if (rec.stopRequested) break;
      if (minutes() > MAX_MINUTES) { stopReason = 'time cap'; break; }
      const work = planWork(await sql('select city, category, status, sub_area from search_log'),
        await sql('select * from harvest_towns where not skip order by priority'), sessionDone);
      if (!work) { stopReason = 'town list exhausted — add towns to harvest_towns'; break; }
      const { key, town, city, category, already } = work;
      if (town.lat == null || town.lng == null) {
        if (!geocoded.has(town.city)) {
          const g = await geocode(town.city);
          geocoded.set(town.city, g);
          if (!rec.dry) await sql(`update harvest_towns set lat=${lit(g.lat)}, lng=${lit(g.lng)}, updated_at=now() where city=${lit(town.city)}`);
          rec.log(`geocoded ${town.city}: ${g.lat},${g.lng}`);
        }
        Object.assign(town, geocoded.get(town.city));
      }
      const lat = Number(town.lat);
      const lng = Number(town.lng);

      // Centre first at 13z. If it was saturated (now or in an earlier partial run), do the four children.
      let needQuadrants = already.size > 0;
      let children = null;
      const pending = already.has('center') ? [] : [{ subArea: 'center', lat, lng, zoom: 13 }];
      const nextArea = async () => {
        if (pending.length) return pending.shift();
        if (!needQuadrants) return null;
        const name = SUB_AREAS.find((s) => !already.has(s));
        if (!name) return null;
        if (!children) {
          const sub = await callJson(deps.harvest, 'subdivide_tile', { lat, lng, zoom: 13 });
          if (!Array.isArray(sub.children) || sub.children.length !== 4) throw new Error(`subdivide_tile failed: ${JSON.stringify(sub).slice(0, 200)}`);
          children = sub.children;
        }
        const c = children[SUB_AREAS.indexOf(name)];
        return { subArea: name, lat: c.lat, lng: c.lng, zoom: c.zoom };
      };

      let didAny = false;
      for (let next = await nextArea(); next; next = await nextArea()) {
        didAny = true;
        if (totals.searches >= rec.maxSearches || minutes() > MAX_MINUTES || rec.stopRequested) break outer;
        if (totals.searches > 0) await sleep(MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS)); // be gentle with Maps
        if (rec.stopRequested) break outer;
        const ctx = { city, category, ...next };
        const res = await callJson(deps.harvest, 'harvest_tile',
          { category, lat: next.lat, lng: next.lng, zoom: next.zoom, limit: 120, extended: true });
        totals.searches++;
        if (res.selector_version) rec.selectorVersion = res.selector_version;
        if (res.error || !Array.isArray(res.results)) {
          const code = res.error ?? 'internal';
          const at = where(category, city, next.subArea);
          if (code === 'challenge_detected' || code === 'circuit_open') { status = 'challenged'; stopReason = `${code} on ${at}`; }
          else if (code === 'selectors_stale') { status = 'selector_broken'; stopReason = `selectors_stale (${res.hint ?? 'feed not found'}) on ${at}`; }
          else if (code === 'budget_exhausted') { status = 'stopped'; stopReason = `harvest budget exhausted (${res.calls ?? '?'} calls; resets when the harvest server restarts)`; }
          else { status = 'error'; stopReason = `harvest_tile ${code}${res.reason ? ` (${res.reason})` : ''} on ${at}`; }
          rec.log(`${at} → ${code}, stopping`);
          break outer;
        }
        const cards = res.results;

        // Website selector sanity check BEFORE inserting: 10+ cards and zero website buttons
        // means the selector is probably broken, and every card would look like a lead.
        if (cards.length >= 10 && !cards.some((c) => c.has_website)) {
          zeroWebsiteStreak++;
          totals.seen += cards.length;
          zeroWebsiteIds.push(await logSearch(ctx, { seen: cards.length, inserted: 0, dupes: 0, outOfArea: 0 }, 'done',
            'server; website button matched 0 cards — category skipped, nothing inserted'));
          sessionDone.add(key);
          rec.log(`${where(category, city, next.subArea)} → ${cards.length} cards, none with a website: nothing inserted`);
          if (zeroWebsiteStreak >= 2) {
            // Probably a broken selector, not two genuinely odd categories: reopen both so they get retried after the fix.
            const ids = zeroWebsiteIds.map(String).filter((x) => /^\d+$/.test(x));
            if (ids.length && !rec.dry) await sql(`update search_log set status='partial', sub_area='reopened', notes=notes || ' (reopened: selector suspected broken)' where id in (${ids.join(',')})`);
            status = 'selector_broken';
            stopReason = `website button matched 0 cards on 2 categories in a row (selectors ${res.selector_version})`;
            break outer;
          }
          break;
        }
        zeroWebsiteStreak = 0;
        zeroWebsiteIds.length = 0;

        const stats = await processCards(cards, ctx, spam, res.selector_version, rec.dry);
        totals.seen += stats.seen; totals.inserted += stats.inserted; totals.dupes += stats.dupes; totals.outOfArea += stats.outOfArea;

        if (next.subArea === 'center' && res.saturated) needQuadrants = true;
        already.add(next.subArea);
        const remaining = needQuadrants ? SUB_AREAS.filter((s) => !already.has(s)) : [];
        const finished = remaining.length === 0;
        await logSearch(ctx, stats, finished ? 'done' : 'partial',
          finished ? `server; closed ${stats.closed}, incomplete ${stats.incomplete}`
                   : `server; ${next.subArea === 'center' ? `capped at ${stats.seen}` : `${next.subArea} done`} — next sub-area ${remaining[0]}`);
        rec.log(`${city} | ${category} | ${next.subArea} → seen ${stats.seen}, new ${stats.inserted}, dupes ${stats.dupes}, out ${stats.outOfArea}`);
        if (finished) { sessionDone.add(key); break; }
      }
      if (!didAny) { // every sub-area was already logged but nobody marked it done
        await logSearch({ city, category, subArea: 'all', zoom: 14 }, { seen: 0, inserted: 0, dupes: 0, outOfArea: 0 }, 'done', 'server; all sub-areas already searched');
        sessionDone.add(key);
      }
    }
    if (!stopReason) stopReason = 'search cap';
  } catch (err) {
    status = 'error';
    stopReason = String(err?.message || err).slice(0, 500);
  } finally {
    if (rec.stopRequested) { status = 'stopped'; stopReason = rec.stopRequested; }
    rec.status = status;
    rec.stopReason = stopReason;
    rec.running = false;
    rec.finished = Date.now();
    await finishRow(rec).catch((err) => rec.log(`harvest_runs update failed: ${err?.message ?? err}`));
    rec.log('done', JSON.stringify(summary(rec)));
  }
}

async function processCards(cards, ctx, spam, selectorVersion, dry) {
  const { stats, cand } = filterCards(cards, spam);
  if (!cand.length) return stats;
  const phones = cand.map((c) => c.p10).filter(Boolean);
  const names = cand.filter((c) => !c.p10).map((c) => c.nn);
  const existingPhones = new Set();
  const existingNames = new Set();
  if (phones.length) {
    const rows = await sql(`select right(regexp_replace(phone, '\\D', '', 'g'), 10) as p10 from ${TABLE}
       where right(regexp_replace(phone, '\\D', '', 'g'), 10) = any(${textArray(phones)})`);
    rows.forEach((r) => existingPhones.add(r.p10));
  }
  if (names.length) {
    const rows = await sql(`select name_norm from ${TABLE} where name_norm = any(${textArray(names)})`);
    rows.forEach((r) => existingNames.add(r.name_norm));
  }
  const fresh = cand.filter((c) => (c.p10 ? !existingPhones.has(c.p10) : !existingNames.has(c.nn)));
  stats.dupes += cand.length - fresh.length;
  if (dry) stats.inserted = fresh.length; // would-be inserts (a concurrent source_id clash could lower it)
  else for (const q of buildInserts(fresh, ctx, selectorVersion)) stats.inserted += (await sql(q)).length;
  return stats;
}

function finishRow(rec) {
  if (rec.harvestRunId == null || !/^\d+$/.test(String(rec.harvestRunId))) return Promise.resolve();
  const t = rec.totals;
  return sql(`update harvest_runs set finished_at=now(), status=${lit(rec.status)}, stop_reason=${lit(rec.stopReason)}, selector_version=${lit(rec.selectorVersion)},
    searches=${t.searches}, cards_seen=${t.seen}, inserted=${t.inserted}, duplicates=${t.dupes}, out_of_area=${t.outOfArea} where id=${rec.harvestRunId}`);
}

const summary = (rec) => ({
  dry_run: Boolean(rec.dry), status: rec.status, stop_reason: rec.stopReason, harvest_run_id: rec.harvestRunId, selector_version: rec.selectorVersion,
  searches: rec.totals.searches, cards_seen: rec.totals.seen, inserted: rec.totals.inserted,
  duplicates: rec.totals.dupes, out_of_area: rec.totals.outOfArea,
});

export function tileRunStatus(args) {
  const want = args?.run_id ? String(args.run_id) : current?.id;
  const schedule = process.env.TILE_RUN_CRON || null;
  if (!want) {
    const recent = fs.existsSync(RUN_DIR) ? fs.readdirSync(RUN_DIR).filter((f) => f.endsWith('.log')).sort().slice(-5) : [];
    return text({ running: false, note: 'no tile run started since the server last restarted', schedule, recent_logs: recent });
  }
  if (!/^[\w.-]+$/.test(want)) return fail('bad run_id');
  const file = path.join(RUN_DIR, `${want}.log`);
  if (!fs.existsSync(file)) return fail(`no log for run ${want}`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const isCurrent = current?.id === want;
  let state;
  if (isCurrent) state = summary(current);
  else {
    const done = lines.findLast((l) => / done \{/.test(l));
    try { state = done ? JSON.parse(done.slice(done.indexOf('{'))) : { status: 'unknown (log has no final line; server restarted mid-run?)' }; }
    catch { state = { status: 'unknown' }; }
  }
  return text({
    run_id: want,
    running: isCurrent ? current.running : false,
    ...(isCurrent ? { trigger: current.trigger, max_searches: current.maxSearches, elapsed_s: Math.round(((current.finished ?? Date.now()) - current.started) / 1000) } : {}),
    ...state,
    schedule,
    last_lines: lines.slice(-8),
  });
}

// ---- lifecycle ----------------------------------------------------------------
const timers = [];

/** Called once by index.js after the upstreams are up. */
export function initTileRuns({ harvest, supabase, log }) {
  deps = { harvest, supabase, log };
  if (!harvest || !supabase) {
    log.info('[tile-run] needs the harvest and supabase servers; start_tile_run disabled');
    return;
  }
  refreshSelectors();
  timers.push(setInterval(refreshSelectors, SELECTOR_REFRESH_MS));

  const expr = process.env.TILE_RUN_CRON;
  if (!expr) return;
  let fields;
  try { fields = parseCron(expr); } catch (err) {
    log.warn(`[tile-run] TILE_RUN_CRON "${expr}" ignored: ${err.message}`);
    return;
  }
  log.info(`[tile-run] schedule "${expr}" (${CRON_TZ}), ${DEFAULT_MAX_SEARCHES} searches per run`);
  let lastMinute = -1;
  timers.push(setInterval(() => {
    const minute = Math.floor(Date.now() / 60000);
    if (minute === lastMinute || !cronMatches(fields, new Date())) return;
    lastMinute = minute;
    if (current?.running) return log.info(`[tile-run] schedule: ${current.id} still running, skipped`);
    const r = startTileRun({}, 'cron');
    log.info(`[tile-run] schedule: ${r.content[0].text}`);
  }, 20 * 1000));
}

/** Shutdown: mark a running run stopped (the process is about to exit) and stop the timers. */
export async function stopTileRuns(reason) {
  timers.splice(0).forEach(clearInterval);
  if (!current?.running) return;
  current.stopRequested = reason;
  current.status = 'stopped';
  current.stopReason = reason;
  current.log(`STOPPED: ${reason}`);
  await Promise.race([finishRow(current).catch(() => {}), sleep(3000)]);
}
