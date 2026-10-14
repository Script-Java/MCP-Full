// Lead scorer for public."no-Website-lead" (scorer_version v1). No AI, no paid APIs:
//  - enrichLeads: one harvest check_operating per harvested lead (newest review, hours, photos,
//    closed status, website) -> stored on the row, so scoring itself never browses
//  - geocode: US Census Geocoder batch endpoint (free, no key) -> exact / non-exact, lat/lng, county
//  - phone: libphonenumber (offline); duplicates = same phone_e164 as an older row
//  - Comptroller: active sales-tax + franchise-tax permit holders for the target counties, pulled
//    nightly from data.texas.gov (Socrata) into a local SQLite table tx_permits on the volume
//  - score_leads(limit) tool; tile runs call enrichLeads + scoreLeads when they finish
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { callHarvest, cronMatches, lit, parseCron, sql } from './tile-run.js';

export const SCORER_VERSION = 'v1';
const TABLE = 'public."no-Website-lead"';
const DATA_DIR = process.env.MCP_DATA_DIR || '/data';
export const PERMITS_DB = path.join(DATA_DIR, 'tx_permits.db');
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

/**
 * lead: a no-Website-lead row. sig: {inTarget: true|false|null, dupOf: source_id|null, permit: {...}|null}.
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

  const gate = lead.closed_status === 'permanent' ? 'closed_permanently'
    : lead.closed_status === 'temporary' ? 'closed_temporarily'
    : lead.website_class === 'website' ? 'has_website'
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
export const permitNorm = (s) => String(s ?? '').toLowerCase().replace(/['’]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ')
  .replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
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
const MATCH_MIN = 0.8;
// Generic trade words: "Ben's Plumbing" vs "E&S Plumbing" share them, so the rest of the name must match too.
const GENERIC = /\b(plumbing|plumber|plumbers|electric|electrical|electrician|roofing|hvac|heating|cooling|air|ac|lawn|care|landscaping|landscape|tree|pest|control|fence|fencing|concrete|painting|painter|handyman|garage|door|doors|pressure|washing|auto|repair|repairs|appliance|flooring|junk|removal|locksmith|welding|mobile|mechanic|towing|septic|moving|movers|service|services|solutions|pros|professional|contractor|contractors|construction|group|enterprises|texas|tx|dfw|dallas|north)\b/g;
const distinctive = (nn) => nn.replace(GENERIC, ' ').replace(/\s+/g, ' ').trim();
/** Same business name? Whole name and its non-generic part must both be MATCH_MIN similar. */
export function nameMatch(a, b) {
  const s = similarity(a, b);
  if (s < MATCH_MIN) return 0;
  const da = distinctive(a); const db = distinctive(b);
  return !da && !db ? s : similarity(da, db) >= MATCH_MIN ? s : 0;
}

// ---- Comptroller permits (SQLite on the volume) ---------------------------------
let permitsDb = null;
function openPermits() {
  if (permitsDb) return permitsDb;
  if (!fs.existsSync(PERMITS_DB)) return null;
  permitsDb = new DatabaseSync(PERMITS_DB, { readOnly: true });
  return permitsDb;
}

/** Best permit for a lead in its city, or null. ponytail: LIKE scan per lead on the city index; fine for 1M rows x 1000 leads. */
export function matchPermit(db, name, city) {
  const nn = permitNorm(name);
  const c = cityNorm(city);
  const tok = nn.split(' ').filter((w) => w.length >= 3).sort((x, y) => y.length - x.length)[0];
  if (!tok || !c) return null;
  const rows = db.prepare('select source, taxpayer_number, name, name_norm from tx_permits where city = ? and name_norm like ?')
    .all(c, `%${tok}%`);
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
    db.exec('create table tx_permits (source text, taxpayer_number text, name text, name_norm text, city text, county text)');
    const ins = db.prepare('insert into tx_permits values (?, ?, ?, ?, ?, ?)');
    const codes = TARGET_FIPS.map(comptrollerCode);
    let n = 0;
    const add = (source, num, name, city, county) => {
      const nn = permitNorm(name);
      if (nn) { ins.run(source, num ?? null, name, nn, cityNorm(city), county); n++; }
    };
    try {
      for await (const rows of sodaPages('jrea-zgmq', 'taxpayer_number,taxpayer_name,outlet_name,outlet_city,outlet_county_code',
        `outlet_county_code in (${codes.map((c) => `'${c}'`).join(',')})`)) {
        db.exec('begin');
        for (const r of rows) {
          add('sales_tax', r.taxpayer_number, r.outlet_name || r.taxpayer_name, r.outlet_city, r.outlet_county_code);
          if (r.taxpayer_name && r.outlet_name && permitNorm(r.taxpayer_name) !== permitNorm(r.outlet_name)) {
            add('sales_tax', r.taxpayer_number, r.taxpayer_name, r.outlet_city, r.outlet_county_code);
          }
        }
        db.exec('commit');
      }
      for await (const rows of sodaPages('9cir-efmm', 'taxpayer_number,taxpayer_name,taxpayer_city,taxpayer_county_code',
        `taxpayer_county_code in (${codes.map(Number).join(',')}) and right_to_transact_business_code='A' and current_exempt_reason_code is null`)) {
        db.exec('begin');
        for (const r of rows) add('franchise_tax', r.taxpayer_number, r.taxpayer_name, r.taxpayer_city, String(r.taxpayer_county_code).padStart(3, '0'));
        db.exec('commit');
      }
      db.exec('create index tx_permits_city on tx_permits (city)');
      db.close();
      permitsDb?.close();
      permitsDb = null;
      fs.renameSync(tmp, PERMITS_DB);
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
/** check_operating for up to `max` not-yet-judged (state harvested) leads with no signals. Stops on guard errors. */
export async function enrichLeads(max = ENRICH_MAX, log = () => {}) {
  if (!(max > 0)) return { enriched: 0 };
  const rows = await sql(`select source_id, google_maps_url from ${TABLE} where city is not null and signals_at is null
    and state = 'harvested' and google_maps_url like 'https://www.google.com/maps?cid=%' order by first_seen desc limit ${Math.floor(max)}`);
  let enriched = 0;
  for (const r of rows) {
    const s = await callHarvest('check_operating', { maps_url: r.google_maps_url });
    if (s.error) {
      log(`enrich ${r.source_id} → ${s.error}`);
      if (HARVEST_STOP.has(s.error)) return { enriched, stopped: s.error };
      continue;
    }
    let host = null;
    try { host = s.website_url ? new URL(s.website_url).hostname : null; } catch {}
    const web = s.website_url ? (host && SOCIAL_HOSTS.test(host) ? 'social_only' : 'website') : null;
    await sql(`update ${TABLE} set closed_status=${lit(s.closed_status)}, newest_review_date=${lit(s.most_recent_review_date)},
      hours_present=${lit(s.hours_present)}, address=coalesce(${lit(s.address)}, address), geocoded_at=null, photo_count=${lit(s.photo_count)}, review_count=coalesce(${lit(s.review_count)}, review_count),
      website_class=coalesce(${lit(web)}, website_class), signals_at=now(), scored_at=null
      where source_id=${lit(r.source_id)}`);
    enriched++;
  }
  return { enriched };
}

// ---- scoring run --------------------------------------------------------------------
const COLS = ['source_id', 'name', 'city', 'address', 'zip', 'phone', 'phone_e164', 'category', 'review_count', 'website_class',
  'closed_status', 'newest_review_date', 'hours_present', 'photo_count', 'geo_match', 'geo_county_fips', 'geocoded_at'];

/**
 * Score up to `limit` rows that are unscored (or scored by another version). A row with a Maps link waits for
 * its listing signals, and a row with an address for its geocode, so nothing is scored (or routed) on half the data.
 */
export async function scoreLeads({ limit = 200 } = {}, log = () => {}) {
  let rows = await sql(`select ${COLS.join(',')} from ${TABLE} where city is not null
    and (scored_at is null or scorer_version is distinct from ${lit(SCORER_VERSION)})
    and (signals_at is not null or google_maps_url is null)
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

  // 3. Comptroller permits + target area, then the score.
  const db = openPermits();
  const vals = [];
  const tiers = { qualified: 0, review: 0, rejected: 0 };
  for (const r of rows) {
    const first = r.phone_e164 ? firstByPhone.get(r.phone_e164) : null;
    const geoKnown = r.geo_match === 'exact' || r.geo_match === 'non_exact';
    const inTarget = geoKnown && r.geo_county_fips ? TARGET_FIPS.includes(r.geo_county_fips)
      : db ? cityKnown(db, r.city) : null; // no geocode: the town must have permit holders in a target county
    const sig = { inTarget, dupOf: first && first !== r.source_id ? first : null, permit: db ? matchPermit(db, r.name, r.city) : null };
    const s = scoreLead(r, sig);
    if (!db) s.breakdown.comptroller.value = 'tx_permits not loaded yet';
    tiers[s.tier]++;
    vals.push(`(${[r.source_id, s.score, s.tier, JSON.stringify(s.breakdown), s.reject_reason, sig.dupOf].map(lit).join(',')})`);
  }
  for (let i = 0; i < vals.length; i += 100) {
    await sql(`update ${TABLE} t set score=v.score::int, tier=v.tier, score_breakdown=v.b::jsonb, reject_reason=v.rr, duplicate_of=v.dup,
      scored_at=now(), scorer_version=${lit(SCORER_VERSION)}
      from (values ${vals.slice(i, i + 100).join(',')}) as v(id, score, tier, b, rr, dup) where t.source_id = v.id`);
  }
  return { scored: rows.length, ...tiers, geocoded: toGeo.filter((r) => r.geo_match).length, waiting_for_geocode: waiting,
    geocode_error: geoError, permits_loaded: Boolean(db) };
}

// ---- MCP tool + nightly job ------------------------------------------------------------
export const SCORE_LEADS_TOOL = {
  name: 'score_leads',
  description:
    `Score unscored rows of public."no-Website-lead" (city not null) with scorer ${SCORER_VERSION}: Census geocode, phone check, ` +
    'duplicate check, Comptroller permit match, Maps signals already on the row. Writes score, tier (qualified >= 70, review 45-69, ' +
    'rejected < 45 or a gate: closed, real website, outside the target counties, duplicate), score_breakdown, reject_reason. ' +
    'No browsing; tile runs call it automatically at the end.',
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: 'Rows to score (default 200).' } },
  },
};

let scoring = null;
export async function scoreLeadsTool(args) {
  const limit = Number(args?.limit ?? 200);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return fail(`limit must be an integer 1-${MAX_LIMIT}`);
  if (scoring) return fail('a scoring run is already going; try again shortly');
  scoring = scoreLeads({ limit });
  try { return text(await scoring); } catch (err) { return fail(`score_leads failed: ${String(err?.message ?? err).slice(0, 300)}`); }
  finally { scoring = null; }
}

/** Called once by index.js: nightly tx_permits refresh (and once now if the table is missing). */
export function initScorer({ supabase, log }) {
  if (!supabase) return;
  const refresh = () => refreshPermits(log).catch((err) => log.warn(`[scorer] tx_permits refresh failed: ${err?.message ?? err}`));
  if (!fs.existsSync(PERMITS_DB)) refresh();
  let fields;
  try { fields = parseCron(PERMITS_CRON); } catch (err) { log.warn(`[scorer] PERMITS_CRON ignored: ${err.message}`); return; }
  let lastMinute = -1;
  setInterval(() => {
    const minute = Math.floor(Date.now() / 60000);
    if (minute === lastMinute || !cronMatches(fields, new Date())) return;
    lastMinute = minute;
    refresh();
  }, 20 * 1000).unref();
}
