// Lead scorer for public."no-Website-lead" (scorer_version v1). No AI, no paid APIs:
//  - enrichLeads: one harvest check_operating per harvested lead (newest review, hours, photos,
//    closed status, website) -> stored on the row, so scoring itself never browses
//  - geocode: US Census Geocoder batch endpoint (free, no key) -> exact / non-exact, lat/lng, county
//  - phone: libphonenumber (offline); duplicates = same phone_e164 as an older row
//  - Comptroller: active sales-tax + franchise-tax permit holders for the target counties, pulled
//    nightly from data.texas.gov (Socrata) into a local SQLite table tx_permits on the volume
//  - Overture Places (v2): public.overture_places, loaded monthly by scripts/overture-load.mjs; a lead matched by
//    phone, else name within 150 m: a real website there is the has_website gate, confidence >= 0.7 adds up to 10 points
//  - score_leads(limit, force) tool; tile runs call enrichLeads + scoreLeads when they finish
//  - start_signals_backfill / signals_backfill_status: check_operating for older leads with no signals
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { leadRunActive } from './local-tools.js';
import { MAX_DELAY_MS, MIN_DELAY_MS, callHarvest, cronMatches, lit, parseCron, sql, tileRunActive } from './tile-run.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SCORER_VERSION = 'v2';
const TABLE = 'public."no-Website-lead"';
const DATA_DIR = process.env.MCP_DATA_DIR || '/data';
export const PERMITS_DB = path.join(DATA_DIR, 'tx_permits_v2.db');
const MAX_LIMIT = 1000;
// Target counties as 5-digit FIPS (Census). Default: DFW core (Collin, Dallas, Denton, Tarrant).
export const TARGET_FIPS = (process.env.SCORE_TARGET_COUNTIES || '48085,48113,48121,48439')
  .split(',').map((s) => s.trim()).filter((s) => /^48\d{3}$/.test(s));
// The Comptroller numbers counties alphabetically (Denton = 061); Census FIPS are the odd numbers (121).
export const comptrollerCode = (fips) => String((Number(fips.slice(2)) + 1) / 2).padStart(3, '0');
const PERMITS_CRON = process.env.PERMITS_CRON || '30 3 * * *'; // America/Chicago, nightly
const ENRICH_MAX = Number(process.env.TILE_RUN_ENRICH_MAX ?? 30);
const HARVEST_STOP = new Set(['challenge_detected', 'circuit_open', 'budget_exhausted', 'selectors_stale']);
const SOCIAL_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|linktr\.ee)$/i;
// Maps category labels of the 24 tile-run trades (and the licence runs' Plumber / Electrician).
const TRADE_RE = /plumb|hvac|air condition|heating|furnace|roof|electric|landscap|lawn|tree|pest|exterminat|fence|concrete|paint|handyman|garage door|pressure wash|power wash|auto repair|mechanic|appliance|floor|junk|locksmith|weld|tow|septic|moving|mover/i;

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

// ---- pure scoring (gateway/scripts/scorer-check.mjs) -------------------------
export function phoneValid(phone) {
  const p = parsePhoneNumberFromString(String(phone ?? ''), 'US');
  return Boolean(p?.isValid());
}

const DAY = 86400000;
const reviewAgeDays = (d, now) => (d ? Math.floor((now - new Date(d).getTime()) / DAY) : null);

const OVERTURE_MIN_CONF = 0.7;
/**
 * lead: a no-Website-lead row. sig: {inTarget: true|false|null, dupOf: source_id|null, permit: {...}|null,
 * overture: {id, name, matched_by, confidence, socials, website}|null}.
 * Returns {score, tier, reject_reason, breakdown}; breakdown has every check's value and points.
 */
export function scoreLead(lead, sig, now = Date.now()) {
  const b = {};
  const put = (check, value, points) => { b[check] = { value, points }; return points; };
  let score = 0;

  const geo = lead.geo_match;
  const hasAddress = Boolean(String(lead.address ?? '').trim());
  score += put('address', hasAddress ? geo ?? 'not_geocoded' : 'service_area',
    !hasAddress ? 8 : geo === 'exact' ? 15 : geo === 'non_exact' ? 8 : 0);
  score += put('target_area', sig.inTarget, sig.inTarget ? 10 : 0);

  const age = reviewAgeDays(lead.newest_review_date, now);
  score += put('newest_review', lead.newest_review_date ? `${lead.newest_review_date} (${age} d)` : null,
    age == null ? 0 : age < 183 ? 20 : age < 365 ? 12 : age < 730 ? 5 : 0);
  const rc = Number(lead.review_count ?? 0);
  score += put('review_count', lead.review_count ?? null, rc >= 25 ? 10 : rc >= 10 ? 7 : rc >= 3 ? 4 : rc >= 1 ? 2 : 0);
  score += put('hours', Boolean(lead.hours_present), lead.hours_present ? 5 : 0);
  // ponytail: Maps' panel shows only the total photo count, so any photo counts; owner-only needs the photo viewer.
  score += put('photos', lead.photo_count ?? null, Number(lead.photo_count) > 0 ? 5 : 0);
  const phone = lead.phone_e164 || lead.phone;
  score += put('phone', phone || null, phone ? 5 : 0);
  const valid = phone ? phoneValid(phone) : false;
  score += put('phone_valid_unique', { valid, duplicate_of: sig.dupOf ?? null }, valid && !sig.dupOf ? 10 : 0);
  score += put('comptroller', sig.permit ?? null, sig.permit ? 10 : 0);
  score += put('trade_category', lead.category ?? null, TRADE_RE.test(lead.category ?? '') ? 10 : 0);
  const o = sig.overture;
  score += put('overture', o ? { id: o.id, name: o.name, matched_by: o.matched_by, confidence: o.confidence, socials: o.socials ?? [], website: o.website } : null,
    o?.confidence >= OVERTURE_MIN_CONF ? Math.round(o.confidence * 10) : 0);

  const gate = lead.closed_status === 'permanent' ? 'closed_permanently'
    : lead.closed_status === 'temporary' ? 'closed_temporarily'
    : lead.website_class === 'website' || o?.website ? 'has_website'
    : sig.inTarget === false ? 'outside_target_area'
    : sig.dupOf ? `duplicate_of:${sig.dupOf}`
    : null;
  b.gate = { value: gate, points: gate ? -score : 0 };
  if (gate) return { score: 0, tier: 'rejected', reject_reason: gate, breakdown: { ...b, raw_score: score } };
  const tier = score >= 70 ? 'qualified' : score >= 45 ? 'review' : 'rejected';
  return { score, tier, reject_reason: tier === 'rejected' ? 'low_score' : null, breakdown: b };
}

// ---- names ---------------------------------------------------------------------
const SUFFIX = /\b(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|lp|llp|pllc|pc|dba|the|and|of)\b/g;
// Generic trade words dropped too: "Smith Plumbing Services LLC" and "SMITH PLUMBING" compare as "smith".
const GENERIC = /\b(maintenance|electric|electrical|plumbing|services|service)\b/g;
/** Name core for permit matching: lower case, punctuation, legal suffixes and generic trade words removed. */
export const permitNorm = (s) => String(s ?? '').toLowerCase().replace(/['’]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ')
  .replace(SUFFIX, ' ').replace(GENERIC, ' ').replace(/\s+/g, ' ').trim();
export const zipOf = (lead) => String(lead.address ?? '').match(/\b(7[5-9]\d{3})\b/)?.[1] ?? (/^\d{5}$/.test(String(lead.zip ?? '')) ? String(lead.zip) : null);
export const cityNorm = (s) => String(s ?? '').toLowerCase().replace(/,\s*tx$/i, '').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();

function bigrams(s) {
  const t = s.replace(/\s/g, '');
  const m = new Map();
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); }
  return m;
}
/** Dice coefficient on character bigrams, 0..1. */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a); const B = bigrams(b);
  let inter = 0; let n = 0;
  for (const [g, c] of A) { inter += Math.min(c, B.get(g) ?? 0); n += c; }
  for (const c of B.values()) n += c;
  return n ? (2 * inter) / n : 0;
}
const MATCH_MIN = 0.9;
/** Similarity of two name cores (permitNorm output) if >= MATCH_MIN, else 0. An empty core never matches. */
export const nameMatch = (a, b) => {
  const s = a && b ? similarity(a, b) : 0;
  return s >= MATCH_MIN ? s : 0;
};

// ---- Comptroller permits (SQLite on the volume) ---------------------------------
// v2 adds zip and the stricter name core; the v1 file is deleted on the first v2 download.
const PERMITS_DB_V1 = path.join(DATA_DIR, 'tx_permits.db');
let permitsDb = null;
function openPermits() {
  if (permitsDb) return permitsDb;
  if (!fs.existsSync(PERMITS_DB)) return null;
  permitsDb = new DatabaseSync(PERMITS_DB, { readOnly: true });
  return permitsDb;
}

/**
 * Best permit with the same city or zip and a name core >= MATCH_MIN similar, or null.
 * ponytail: LIKE scan per lead on the city / zip index; fine for 1M rows x 1000 leads.
 */
export function matchPermit(db, name, city, zip = null) {
  const nn = permitNorm(name);
  const c = cityNorm(city);
  const tok = nn.split(' ').filter((w) => w.length >= 3).sort((x, y) => y.length - x.length)[0];
  if (!tok || (!c && !zip)) return null;
  const rows = db.prepare('select source, taxpayer_number, name, name_norm from tx_permits where (city = ? or zip = ?) and name_norm like ?')
    .all(c || null, zip || null, `%${tok}%`);
  let best = null;
  for (const r of rows) {
    const s = nameMatch(nn, r.name_norm);
    if (s && (!best || s > best.similarity)) best = { source: r.source, taxpayer_number: r.taxpayer_number, name: r.name, similarity: Math.round(s * 100) / 100 };
  }
  return best;
}
const cityKnown = (db, city) => Boolean(db.prepare('select 1 from tx_permits where city = ? limit 1').get(cityNorm(city)));

const SODA = 'https://data.texas.gov/resource';
async function* sodaPages(dataset, select, where) {
  for (let offset = 0; ; offset += 50000) {
    const q = new URLSearchParams({ $select: select, $where: where, $order: ':id', $limit: '50000', $offset: String(offset) });
    const res = await fetch(`${SODA}/${dataset}.json?${q}`, { signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error(`${dataset} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const rows = await res.json();
    if (!rows.length) return;
    yield rows;
    if (rows.length < 50000) return;
  }
}

let permitsRefreshing = null;
/** Download active sales-tax and franchise-tax permit holders for TARGET_FIPS into a fresh tx_permits.db, then swap it in. */
export function refreshPermits(log) {
  permitsRefreshing ??= (async () => {
    const tmp = `${PERMITS_DB}.tmp`;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.rmSync(tmp, { force: true });
    const db = new DatabaseSync(tmp);
    db.exec('create table tx_permits (source text, taxpayer_number text, name text, name_norm text, city text, zip text, county text)');
    const ins = db.prepare('insert into tx_permits values (?, ?, ?, ?, ?, ?, ?)');
    const codes = TARGET_FIPS.map(comptrollerCode);
    let n = 0;
    const add = (source, num, name, city, zip, county) => {
      const nn = permitNorm(name);
      if (nn) { ins.run(source, num ?? null, name, nn, cityNorm(city), String(zip ?? '').slice(0, 5) || null, county); n++; }
    };
    try {
      for await (const rows of sodaPages('jrea-zgmq', 'taxpayer_number,taxpayer_name,outlet_name,outlet_city,outlet_zip_code,outlet_county_code',
        `outlet_county_code in (${codes.map((c) => `'${c}'`).join(',')})`)) {
        db.exec('begin');
        for (const r of rows) {
          add('sales_tax', r.taxpayer_number, r.outlet_name || r.taxpayer_name, r.outlet_city, r.outlet_zip_code, r.outlet_county_code);
          if (r.taxpayer_name && r.outlet_name && permitNorm(r.taxpayer_name) !== permitNorm(r.outlet_name)) {
            add('sales_tax', r.taxpayer_number, r.taxpayer_name, r.outlet_city, r.outlet_zip_code, r.outlet_county_code);
          }
        }
        db.exec('commit');
      }
      for await (const rows of sodaPages('9cir-efmm', 'taxpayer_number,taxpayer_name,taxpayer_city,taxpayer_zip,taxpayer_county_code',
        `taxpayer_county_code in (${codes.map(Number).join(',')}) and right_to_transact_business_code='A' and current_exempt_reason_code is null`)) {
        db.exec('begin');
        for (const r of rows) add('franchise_tax', r.taxpayer_number, r.taxpayer_name, r.taxpayer_city, r.taxpayer_zip, String(r.taxpayer_county_code).padStart(3, '0'));
        db.exec('commit');
      }
      db.exec('create index tx_permits_city on tx_permits (city)');
      db.exec('create index tx_permits_zip on tx_permits (zip)');
      db.close();
      permitsDb?.close();
      permitsDb = null;
      fs.renameSync(tmp, PERMITS_DB);
      fs.rmSync(PERMITS_DB_V1, { force: true });
      log?.info(`[scorer] tx_permits refreshed: ${n} rows for counties ${TARGET_FIPS.join(',')}`);
      return n;
    } catch (err) {
      try { db.close(); } catch {}
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  })().finally(() => { permitsRefreshing = null; });
  return permitsRefreshing;
}

// ---- Overture Places (public.overture_places, filled monthly by scripts/overture-load.mjs) ------------
// Not a business's own site: social profiles, link pages and directories (Overture lists all of these as websites).
const LISTING_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|linktr\.ee|twitter\.com|x\.com|linkedin\.com|youtube\.com|tiktok\.com|yelp\.com|nextdoor\.com|yellowpages\.com|bbb\.org|angi\.com|homeadvisor\.com|thumbtack\.com|houzz\.com|mapquest\.com|business\.site)$/i;
/** First URL that is a real website (not social / directory), or null. */
export function realWebsite(urls) {
  for (const u of urls ?? []) {
    try {
      if (!LISTING_HOSTS.test(new URL(/^https?:\/\//i.test(u) ? u : `http://${u}`).hostname)) return u;
    } catch {}
  }
  return null;
}
const M_PER_DEG = 111320;
const NEAR_M = 150;
const metres = (a, b) => Math.hypot((b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat) * M_PER_DEG;

/**
 * Overture place per lead: same phone (E.164) first (highest confidence wins), else the most similar name core
 * (permitNorm, >= MATCH_MIN) within NEAR_M of the lead's Census point. Map(source_id -> place + matched_by + website).
 */
export async function matchOverture(rows) {
  const out = new Map();
  const cols = 'p.id, p.name, p.confidence, p.websites, p.socials, p.phones_e164, p.lat, p.lng';
  const set = (r, p, by) => out.set(r.source_id, { ...p, matched_by: by, website: realWebsite(p.websites) });
  const phones = [...new Set(rows.map((r) => r.phone_e164).filter(Boolean))];
  const byPhone = phones.length
    ? await sql(`select ${cols} from overture_places p where p.phones_e164 && array[${phones.map(lit).join(',')}]::text[]`) : [];
  for (const r of rows) {
    const hits = r.phone_e164 ? byPhone.filter((p) => p.phones_e164?.includes(r.phone_e164)) : [];
    if (hits.length) set(r, hits.reduce((a, b) => (b.confidence > a.confidence ? b : a)), 'phone');
  }
  const geo = rows.filter((r) => !out.has(r.source_id) && r.geo_lat != null && r.geo_lng != null && permitNorm(r.name));
  if (!geo.length) return out;
  const dLat = NEAR_M / M_PER_DEG;
  const dLng = dLat / Math.cos((34 * Math.PI) / 180); // DFW is below 34° N, so this box always holds the 150 m circle
  const near = await sql(`select v.id as lead_id, ${cols} from (values ${geo.map((r) => `(${[r.source_id, r.geo_lat, r.geo_lng].map(lit).join(',')})`).join(',')})
      as v(id, lat, lng)
    join overture_places p on p.lat between v.lat::float8 - ${dLat} and v.lat::float8 + ${dLat}
      and p.lng between v.lng::float8 - ${dLng} and v.lng::float8 + ${dLng}`);
  for (const r of geo) {
    const nn = permitNorm(r.name);
    const here = { lat: Number(r.geo_lat), lng: Number(r.geo_lng) };
    let best = null;
    for (const p of near) {
      if (p.lead_id !== r.source_id || metres(here, { lat: Number(p.lat), lng: Number(p.lng) }) > NEAR_M) continue;
      const s = nameMatch(nn, permitNorm(p.name));
      if (s && (!best || s > best.s || (s === best.s && p.confidence > best.p.confidence))) best = { s, p };
    }
    if (best) set(r, best.p, 'name_150m');
  }
  return out;
}

/** 'ready' (with release), 'loading' (a load started in the last 3 h), or null (never loaded / table missing / stale). */
export async function overtureState() {
  let m;
  try {
    [m] = await sql('select release, status, extract(epoch from now() - started_at)::int as age_s from overture_meta where id = 1');
  } catch { return null; }
  if (m?.status === 'ready') return { status: 'ready', release: m.release };
  if (m?.status === 'loading' && m.age_s < 3 * 3600) return { status: 'loading', release: m.release };
  return null;
}

// ---- Census batch geocoder ---------------------------------------------------------
const CENSUS = 'https://geocoding.geo.census.gov/geocoder/geographies/addressbatch';
const csvField = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
/** Street line for the geocoder: first comma part, suite / unit / # dropped (they make Census miss). */
export const streetOf = (address) => String(address ?? '').split(',')[0]
  .replace(/\s+(ste|suite|unit|apt|bldg|#)\s*\.?\s*[\w-]+$/i, '').replace(/\s+#\s*[\w-]+$/, '').trim();

/** Census answer CSV -> Map(id -> {match, lat, lng, county_fips}). */
export function parseCensus(body) {
  const out = new Map();
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
    if (f.length < 3) continue;
    if (f[2] !== 'Match' && f[2] !== 'Tie') { out.set(f[0], { match: 'no_match' }); continue; }
    const [lng, lat] = (f[5] ?? '').split(',').map(Number);
    out.set(f[0], {
      match: f[2] === 'Match' && f[3] === 'Exact' ? 'exact' : 'non_exact',
      lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
      county_fips: f[8] && f[9] ? `${f[8]}${f[9]}` : null,
    });
  }
  return out;
}

/**
 * Geocoder input for a lead. A full listing address ("92 Tecumseh Rd, Pilot Point, TX 76258") brings its own city
 * and zip; a bare card street falls back to the search town, which is often the wrong city (then Census misses).
 */
export function geocodeParts(lead) {
  const parts = String(lead.address ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const zip = String(lead.address ?? '').match(/\b(7[5-9]\d{3})\b/)?.[1] ?? lead.zip ?? '';
  const city = parts.length >= 3 && /^(tx|texas)\b/i.test(parts[parts.length - 1]) ? parts[parts.length - 2] : lead.city;
  return [streetOf(lead.address), cityNorm(city), 'TX', zip];
}

export async function geocode(rows) {
  if (!rows.length) return new Map();
  const csv = rows.map((r, i) => [i, ...geocodeParts(r)].map(csvField).join(',')).join('\n');
  const form = new FormData();
  form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'leads.csv');
  form.append('benchmark', 'Public_AR_Current');
  form.append('vintage', 'Current_Current');
  const res = await fetch(CENSUS, { method: 'POST', body: form, signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`census geocoder ${res.status}`);
  const body = await res.text();
  const byIdx = parseCensus(body);
  if (!byIdx.size) throw new Error(`census answered no rows: ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
  // Rows missing from the answer stay un-geocoded (retried next run), never 'no_match'.
  return new Map(rows.flatMap((r, i) => (byIdx.has(String(i)) ? [[r.source_id, byIdx.get(String(i))]] : [])));
}

// ---- enrichment (Maps listing signals) ------------------------------------------------
// Any URL check_operating accepts (harvest _ALLOWED_MAPS_HOSTS): cards with no cid are saved as /maps/place/... links.
const NEEDS_SIGNALS = `city is not null and signals_at is null
  and google_maps_url ~ '^https://(www\\.google\\.com|google\\.com|maps\\.google\\.com|maps\\.app\\.goo\\.gl)/'`;

/** One check_operating for a lead; on success its signals are stored and it is queued for re-scoring. Returns the harvest answer. */
async function fillSignals(r) {
  const s = await callHarvest('check_operating', { maps_url: r.google_maps_url });
  if (s.error) return s;
  let host = null;
  try { host = s.website_url ? new URL(s.website_url).hostname : null; } catch {}
  const web = s.website_url ? (host && SOCIAL_HOSTS.test(host) ? 'social_only' : 'website') : null;
  await sql(`update ${TABLE} set closed_status=${lit(s.closed_status)}, newest_review_date=${lit(s.most_recent_review_date)},
    hours_present=${lit(s.hours_present)}, address=coalesce(${lit(s.address)}, address), geocoded_at=null, photo_count=${lit(s.photo_count)},
    review_count=coalesce(${lit(s.review_count)}, review_count), website_class=coalesce(${lit(web)}, website_class), signals_at=now(), scored_at=null
    where source_id=${lit(r.source_id)}`);
  return s;
}

/** Stop a run of check_operating calls? Guard errors stop at once; selectors_stale is often one removed listing, so 3 in a row. */
export function makeStopper() {
  let stale = 0;
  return (code) => {
    if (code === 'selectors_stale') return ++stale >= 3;
    stale = 0;
    return Boolean(code) && HARVEST_STOP.has(code);
  };
}

/** check_operating for up to `max` not-yet-judged (state harvested) leads with no signals (end of a tile run). */
export async function enrichLeads(max = ENRICH_MAX, log = () => {}) {
  if (!(max > 0)) return { enriched: 0 };
  const rows = await sql(`select source_id, google_maps_url from ${TABLE} where ${NEEDS_SIGNALS} and state = 'harvested'
    order by first_seen desc limit ${Math.floor(max)}`);
  const stop = makeStopper();
  let enriched = 0;
  for (const r of rows) {
    const s = await fillSignals(r);
    if (s.error) log(`enrich ${r.source_id} → ${s.error}`);
    else enriched++;
    if (stop(s.error)) return { enriched, stopped: s.error };
  }
  return { enriched };
}

// ---- scoring run --------------------------------------------------------------------
const COLS = ['source_id', 'name', 'city', 'address', 'zip', 'phone', 'phone_e164', 'category', 'review_count', 'website_class',
  'closed_status', 'newest_review_date', 'hours_present', 'photo_count', 'geo_match', 'geo_county_fips', 'geocoded_at',
  'geo_lat', 'geo_lng', 'tier'];

/**
 * Score up to `limit` rows that are unscored (or scored by another version). Rows without listing signals are
 * skipped unless `force`, and a row with an address waits for its geocode, so nothing is scored (or routed) on
 * half the data. `ids`: only these source_ids (the backfill re-scores what it just filled).
 * Overture never blocks: while overture_places is missing, empty or reloading, rows are scored without it as v1
 * (only unscored rows, so v2 scores are never downgraded); once it is ready, v1 rows are re-scored as v2.
 */
export async function scoreLeads({ limit = 200, force = false, ids = null } = {}, log = () => {}) {
  const ov = await overtureState();
  if (!ov) startOvertureLoad(log);
  const ready = ov?.status === 'ready';
  const version = ready ? SCORER_VERSION : 'v1';
  let rows = await sql(`select ${COLS.join(',')} from ${TABLE} where city is not null
    and (scored_at is null ${ready ? `or scorer_version is distinct from ${lit(SCORER_VERSION)}` : ''})
    ${force ? '' : 'and signals_at is not null'}
    ${ids ? `and source_id = any(array[${ids.map(lit).join(',')}]::text[])` : ''}
    order by first_seen desc limit ${limit}`);
  if (!rows.length) return { scored: 0 };

  // 1. Geocode rows with an address that were never geocoded.
  const toGeo = rows.filter((r) => String(r.address ?? '').trim() && !r.geocoded_at);
  let geoError = null;
  try {
    const geo = await geocode(toGeo);
    const vals = [];
    for (const r of toGeo) {
      const g = geo.get(r.source_id);
      if (!g) continue;
      Object.assign(r, { geo_match: g.match, geo_county_fips: g.county_fips ?? null });
      vals.push(`(${[r.source_id, g.match, g.lat ?? null, g.lng ?? null, g.county_fips ?? null].map(lit).join(',')})`);
    }
    if (vals.length) {
      await sql(`update ${TABLE} t set geo_match=v.m, geo_lat=v.lat::float8, geo_lng=v.lng::float8, geo_county_fips=v.c, geocoded_at=now()
        from (values ${vals.join(',')}) as v(id, m, lat, lng, c) where t.source_id = v.id`);
    }
  } catch (err) { geoError = String(err?.message ?? err); log(`geocode failed: ${geoError}`); }
  const waiting = rows.filter((r) => String(r.address ?? '').trim() && !r.geo_match).length;
  rows = rows.filter((r) => !String(r.address ?? '').trim() || r.geo_match);

  // 2. Duplicates: another row with the same phone that was seen first (ties: lower source_id).
  const phones = [...new Set(rows.map((r) => r.phone_e164).filter(Boolean))];
  const firstByPhone = new Map();
  if (phones.length) {
    const all = await sql(`select phone_e164, source_id from ${TABLE} where phone_e164 = any(array[${phones.map(lit).join(',')}]::text[])
      order by first_seen nulls last, source_id`);
    for (const r of all) if (!firstByPhone.has(r.phone_e164)) firstByPhone.set(r.phone_e164, r.source_id);
  }

  // 3. Overture match, Comptroller permits + target area, then the score.
  const overture = ready && rows.length ? await matchOverture(rows) : new Map();
  const db = openPermits();
  const vals = [];
  const tiers = { qualified: 0, review: 0, rejected: 0 };
  const ovCount = { matched: overture.size, website_gate: 0, dropped_for_website: 0, gained_points: 0 };
  for (const r of rows) {
    const first = r.phone_e164 ? firstByPhone.get(r.phone_e164) : null;
    const geoKnown = r.geo_match === 'exact' || r.geo_match === 'non_exact';
    const inTarget = geoKnown && r.geo_county_fips ? TARGET_FIPS.includes(r.geo_county_fips)
      : db ? cityKnown(db, r.city) : null; // no geocode: the town must have permit holders in a target county
    const sig = { inTarget, dupOf: first && first !== r.source_id ? first : null, permit: db ? matchPermit(db, r.name, r.city, zipOf(r)) : null,
      overture: overture.get(r.source_id) ?? null };
    const s = scoreLead(r, sig);
    if (!db) s.breakdown.comptroller.value = 'tx_permits not loaded yet';
    if (!ready) s.breakdown.overture.value = 'overture_places not loaded yet';
    // An Overture website the Maps listing did not show: the row now has a website too.
    const ovSite = Boolean(sig.overture?.website) && r.website_class !== 'website';
    if (ovSite && s.reject_reason === 'has_website') {
      ovCount.website_gate++;
      if (r.tier === 'qualified' || r.tier === 'review') ovCount.dropped_for_website++;
    }
    if (!s.breakdown.gate.value && s.breakdown.overture.points > 0) ovCount.gained_points++;
    tiers[s.tier]++;
    vals.push(`(${[r.source_id, s.score, s.tier, JSON.stringify(s.breakdown), s.reject_reason, sig.dupOf, ovSite ? 'website' : null].map(lit).join(',')})`);
  }
  for (let i = 0; i < vals.length; i += 100) {
    await sql(`update ${TABLE} t set score=v.score::int, tier=v.tier, score_breakdown=v.b::jsonb, reject_reason=v.rr, duplicate_of=v.dup,
      website_class=coalesce(v.wc, t.website_class), scored_at=now(), scorer_version=${lit(version)}
      from (values ${vals.slice(i, i + 100).join(',')}) as v(id, score, tier, b, rr, dup, wc) where t.source_id = v.id`);
  }
  return { scored: rows.length, scorer_version: version, ...tiers,
    overture: ready ? { release: ov.release, ...ovCount } : `${ov?.status ?? 'not loaded'}: scored without it (v1), re-scored as v2 once loaded`, geocoded: toGeo.filter((r) => r.geo_match).length,
    waiting_for_geocode: waiting, geocode_error: geoError, permits_loaded: Boolean(db) };
}

// ---- MCP tool + nightly job ------------------------------------------------------------
export const SCORE_LEADS_TOOL = {
  name: 'score_leads',
  description:
    `Score unscored rows of public."no-Website-lead" (city not null) with scorer ${SCORER_VERSION}: Census geocode, phone check, ` +
    'duplicate check, Comptroller permit match, Overture Places match (phone, else name within 150 m), Maps signals already on the ' +
    'row. Writes score, tier (qualified >= 70, review 45-69, rejected < 45 or a gate: closed, real website on Maps or Overture, ' +
    'outside the target counties, duplicate), score_breakdown, reject_reason; an Overture website also sets website_class. ' +
    'While overture_places is not loaded, rows are scored without it (scorer_version v1) and re-scored with it once it is. ' +
    'Re-score everything by calling it until scored is 0. ' +
    'No browsing: rows with no Maps listing signals yet (signals_at null) are skipped unless force=true; ' +
    'start_signals_backfill fills them. Tile runs call it automatically at the end.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: 'Rows to score (default 200).' },
      force: { type: 'boolean', description: 'Also score rows with no listing signals (they lose the review, hours and photo points).' },
    },
  },
};

let scoring = null;
export async function scoreLeadsTool(args) {
  const limit = Number(args?.limit ?? 200);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return fail(`limit must be an integer 1-${MAX_LIMIT}`);
  if (args?.force !== undefined && typeof args.force !== 'boolean') return fail('force must be true or false');
  if (scoring) return fail('a scoring run is already going; try again shortly');
  scoring = scoreLeads({ limit, force: args?.force === true });
  try { return text(await scoring); } catch (err) { return fail(`score_leads failed: ${String(err?.message ?? err).slice(0, 300)}`); }
  finally { scoring = null; }
}

// ---- signals backfill -----------------------------------------------------------------
// check_operating for leads (any state, scored or not) with no listing signals, at the tile-run pace (12-30 s
// between calls), re-scoring every 25. Waits while a tile or lead run uses the Maps browser; one backfill at a time.
const BACKFILL_DIR = path.join(DATA_DIR, 'backfill');
const BACKFILL_CAP = 1000;
let backfill = null;

export const START_BACKFILL_TOOL = {
  name: 'start_signals_backfill',
  description:
    'Start a background job and return at once: harvest check_operating for up to max leads of public."no-Website-lead" with no ' +
    'Maps listing signals (signals_at null, any state, scored or not), at the normal harvest pace (12-30 s between calls, about ' +
    '35 s per lead). Fills newest_review_date, hours_present, photo_count, closed_status, review_count (and the full address and ' +
    'website), then re-scores them. Pauses while a tile or lead run is going; stops on a Google challenge or an exhausted budget. ' +
    'Each lead is one Maps call against the daily harvest budget. Check progress with signals_backfill_status.',
  inputSchema: {
    type: 'object',
    properties: {
      max: { type: 'integer', minimum: 1, maximum: BACKFILL_CAP, description: 'Leads to check (default 100).' },
      city: {
        type: 'string',
        description: 'Only leads in this city, or a comma-separated list ("Aubrey" or "Aubrey, Pilot Point"); oldest first. ' +
          'Default: every city, newest first.',
      },
    },
  },
};

export const BACKFILL_STATUS_TOOL = {
  name: 'signals_backfill_status',
  description: 'Progress of the current (or last) signals backfill: running, checked, filled, errors, scored, stop_reason, last log lines.',
  inputSchema: { type: 'object', properties: {} },
};

const backfillSummary = (b) => ({
  run_id: b.id, running: b.running, max: b.max, cities: b.cities.length ? b.cities : 'all', candidates: b.candidates, checked: b.checked, filled: b.filled, errors: b.errors,
  scored: b.scored, waiting_for: b.waitingFor, stop_reason: b.stopReason, elapsed_s: Math.round(((b.finished ?? Date.now()) - b.started) / 1000),
});

export function startBackfill(args) {
  const max = Number(args?.max ?? 100);
  if (!Number.isInteger(max) || max < 1 || max > BACKFILL_CAP) return fail(`max must be an integer 1-${BACKFILL_CAP}`);
  if (args?.city !== undefined && typeof args.city !== 'string') return fail('city must be a string');
  const cities = [...new Set(String(args?.city ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (cities.length > 50 || cities.some((c) => c.length > 60)) return fail('city: at most 50 names of up to 60 characters');
  if (backfill?.running) return fail(`a backfill is already going (${backfill.id}); check signals_backfill_status`);
  fs.mkdirSync(BACKFILL_DIR, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-backfill-${max}`;
  const file = path.join(BACKFILL_DIR, `${id}.log`);
  const b = {
    id, max, cities, file, started: Date.now(), running: true, candidates: null, checked: 0, filled: 0, errors: 0, scored: 0,
    waitingFor: null, stopReason: null,
    log: (...a) => fs.appendFileSync(file, `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}\n`),
  };
  backfill = b;
  runBackfill(b).catch((err) => { b.stopReason = `error: ${String(err?.message ?? err).slice(0, 300)}`; b.log(b.stopReason); })
    .finally(() => { b.running = false; b.finished = Date.now(); b.log('done', JSON.stringify(backfillSummary(b))); });
  return text({ started: true, run_id: id, max, cities: cities.length ? cities : 'all', expected_minutes: Math.ceil((max * 35) / 60) });
}

async function runBackfill(b) {
  // city is "Aubrey" or "Aubrey, TX": compare the part before the comma.
  const inCities = b.cities.length ? `and lower(trim(split_part(city, ',', 1))) = any(array[${b.cities.map(lit).join(',')}]::text[])` : '';
  const rows = await sql(`select source_id, google_maps_url from ${TABLE} where ${NEEDS_SIGNALS} ${inCities}
    order by first_seen ${b.cities.length ? 'asc' : 'desc'} nulls last limit ${b.max}`);
  b.candidates = rows.length;
  b.log(`backfill ${b.id}: ${rows.length} leads with no listing signals${b.cities.length ? ` in ${b.cities.join(', ')}` : ''}`);
  const stop = makeStopper();
  let batch = [];
  const rescore = async () => {
    if (!batch.length) return;
    const s = await scoreLeads({ limit: batch.length, ids: batch }, (m) => b.log(m));
    b.scored += s.scored;
    b.log(`re-scored ${JSON.stringify(s)}`);
    batch = [];
  };
  for (const r of rows) {
    for (;;) { // the Maps browser and budget are shared: tile and lead runs go first
      b.waitingFor = tileRunActive() ? 'tile run' : leadRunActive() ? 'lead run' : null;
      if (!b.waitingFor) break;
      await sleep(30000);
    }
    if (b.checked > 0) await sleep(MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
    const s = await fillSignals(r);
    b.checked++;
    if (s.error) { b.errors++; b.log(`${r.source_id} → ${s.error}`); }
    else { b.filled++; batch.push(r.source_id); }
    if (stop(s.error)) { b.stopReason = `harvest ${s.error}`; break; }
    if (batch.length >= 25) await rescore();
  }
  await rescore();
  b.stopReason ??= 'done';
}

export function backfillStatus() {
  if (!backfill) return text({ running: false, note: 'no backfill started since the server last restarted' });
  const lines = fs.existsSync(backfill.file) ? fs.readFileSync(backfill.file, 'utf8').split('\n').filter(Boolean) : [];
  return text({ ...backfillSummary(backfill), last_lines: lines.slice(-8) });
}

// ---- Overture load (separate process: DuckDB and ~400k rows stay out of the gateway) ----------------
const OVERTURE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'overture-load.mjs');
const OVERTURE_DIR = path.join(DATA_DIR, 'overture');
const OVERTURE_CRON = process.env.OVERTURE_CRON || '0 4 3 * *'; // America/Chicago, 3rd of the month (Overture releases monthly)
let overtureChild = null;
let overtureAutoAt = 0;
/** Spawn scripts/overture-load.mjs unless one is running. auto: started because nothing is loaded; at most once an hour. */
function startOvertureLoad(log = () => {}, auto = true) {
  if (overtureChild || (auto && Date.now() - overtureAutoAt < 3600000)) return;
  if (auto) overtureAutoAt = Date.now();
  fs.mkdirSync(OVERTURE_DIR, { recursive: true });
  const file = path.join(OVERTURE_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const fd = fs.openSync(file, 'a');
  overtureChild = spawn(process.execPath, [OVERTURE_SCRIPT], { cwd: path.dirname(path.dirname(OVERTURE_SCRIPT)), env: process.env, stdio: ['ignore', fd, fd] });
  overtureChild.on('exit', (code) => { overtureChild = null; fs.closeSync(fd); if (code) log(`overture load exited ${code}; see ${file}`); });
  overtureChild.on('error', (err) => { overtureChild = null; fs.appendFileSync(file, `spawn error: ${err.message}\n`); });
  log(`overture load started: ${file}`);
}

/** Called once by index.js: nightly tx_permits refresh (and once now if the table is missing), monthly Overture load. */
export function initScorer({ supabase, log }) {
  if (!supabase) return;
  const refresh = () => refreshPermits(log).catch((err) => log.warn(`[scorer] tx_permits refresh failed: ${err?.message ?? err}`));
  if (!fs.existsSync(PERMITS_DB)) refresh();
  const crons = [];
  for (const [name, expr, run] of [['PERMITS_CRON', PERMITS_CRON, refresh],
    ['OVERTURE_CRON', OVERTURE_CRON, () => startOvertureLoad((m) => log.info(`[scorer] ${m}`), false)]]) {
    try { crons.push([parseCron(expr), run]); } catch (err) { log.warn(`[scorer] ${name} ignored: ${err.message}`); }
  }
  let lastMinute = -1;
  setInterval(() => {
    const minute = Math.floor(Date.now() / 60000);
    if (minute === lastMinute) return;
    lastMinute = minute;
    for (const [fields, run] of crons) if (cronMatches(fields, new Date())) run();
  }, 20 * 1000).unref();
}
