// Offline checks for src/scorer.js: node scripts/scorer-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-check-'));
process.env.MCP_DATA_DIR = tmp; // no permits file here: scoring runs with permits_loaded false
process.env.TILE_RUN_MIN_DELAY_MS = '0';
process.env.TILE_RUN_MAX_DELAY_MS = '0';
delete process.env.TILE_RUN_CRON;
const S = await import('../src/scorer.js');
const T = await import('../src/tile-run.js');

const now = Date.parse('2026-10-13T12:00:00Z');
const ago = (d) => new Date(now - d * 86400000).toISOString().slice(0, 10);
const good = {
  source_id: '1', name: 'Good Plumbing LLC', city: 'Aubrey, TX', address: '1 Main St', phone_e164: '+12148280101',
  category: 'Plumber', review_count: 30, website_class: 'none', closed_status: null, newest_review_date: ago(30),
  hours_present: true, photo_count: 4, geo_match: 'exact',
};
const sig = { inTarget: true, dupOf: null, permit: { source: 'sales_tax', taxpayer_number: '1', name: 'GOOD PLUMBING', similarity: 1 } };

// ---- full marks, tiers, points ----
let r = S.scoreLead(good, sig, now);
assert.equal(r.score, 100);
assert.equal(r.tier, 'qualified');
assert.equal(r.reject_reason, null);
assert.equal(Object.values(r.breakdown).reduce((a, x) => a + x.points, 0), 100);
r = S.scoreLead({ ...good, newest_review_date: ago(300), review_count: 12, photo_count: 0 }, { ...sig, permit: null }, now);
assert.equal(r.score, 100 - 8 - 3 - 5 - 10); // 12-month review 12, 10-24 reviews 7, no photos, no permit
assert.equal(r.tier, 'qualified');
r = S.scoreLead({ ...good, address: null, geo_match: null, newest_review_date: ago(500), review_count: 2, hours_present: false, photo_count: 0 }, { ...sig, permit: null }, now);
assert.equal(r.breakdown.address.points, 8); // hidden service-area
assert.equal(r.score, 8 + 10 + 5 + 2 + 0 + 0 + 5 + 10 + 0 + 10);
assert.equal(r.tier, 'review');
r = S.scoreLead({ ...good, geo_match: 'no_match', newest_review_date: null, review_count: 0, hours_present: false, photo_count: null, category: 'Bakery' }, { ...sig, permit: null, inTarget: null }, now);
assert.equal(r.score, 15);
assert.equal(r.tier, 'rejected');
assert.equal(r.reject_reason, 'low_score');
assert.equal(S.scoreLead({ ...good, geo_match: 'non_exact' }, sig, now).breakdown.address.points, 8);
assert.equal(S.scoreLead({ ...good, newest_review_date: ago(800) }, sig, now).breakdown.newest_review.points, 0);
assert.equal(S.scoreLead({ ...good, review_count: 5 }, sig, now).breakdown.review_count.points, 4);

// ---- gates ----
for (const [patch, s2, reason] of [
  [{ closed_status: 'permanent' }, sig, 'closed_permanently'],
  [{ closed_status: 'temporary' }, sig, 'closed_temporarily'],
  [{ website_class: 'website' }, sig, 'has_website'],
  [{}, { ...sig, inTarget: false }, 'outside_target_area'],
  [{}, { ...sig, dupOf: '9' }, 'duplicate_of:9'],
]) {
  r = S.scoreLead({ ...good, ...patch }, s2, now);
  assert.deepEqual([r.score, r.tier, r.reject_reason], [0, 'rejected', reason]);
  assert.ok(r.breakdown.raw_score > 0);
}
assert.equal(S.scoreLead({ ...good, website_class: 'social_only' }, sig, now).tier, 'qualified');

// ---- phone ----
assert.equal(S.phoneValid('+12148280101'), true);
assert.equal(S.phoneValid('(940) 377-9808'), true);
assert.equal(S.phoneValid('+11115550101'), false);
assert.equal(S.phoneValid('555-0101'), false);
assert.equal(S.scoreLead({ ...good, phone_e164: '+11115550101' }, sig, now).breakdown.phone_valid_unique.points, 0);

// ---- names, permits ----
assert.equal(S.permitNorm('A & B Plumbing, L.L.C.'), 'a b');
assert.equal(S.permitNorm('Smith Electrical Maintenance Services Co.'), 'smith');
assert.equal(S.permitNorm('Smith Roofing Company, Inc'), 'smith roofing'); // only the listed trade words are generic
assert.equal(S.cityNorm('Little Elm, TX'), 'little elm');
assert.equal(S.zipOf({ address: '92 Tecumseh Rd, Pilot Point, TX 76258', zip: null }), '76258');
assert.equal(S.zipOf({ address: '92 Tecumseh Rd', zip: '76201' }), '76201');
assert.equal(S.zipOf({ address: '92 Tecumseh Rd', zip: null }), null);
assert.equal(S.comptrollerCode('48121'), '061'); // Denton
assert.equal(S.comptrollerCode('48439'), '220'); // Tarrant
assert.ok(S.similarity('good plumbing', 'good plumbing services') < 0.8);
assert.ok(S.similarity('texas precision plumbing services', 'texas precision plumbing service') >= 0.8);
const db = new DatabaseSync(':memory:');
db.exec('create table tx_permits (source text, taxpayer_number text, name text, name_norm text, city text, zip text, county text)');
const ins = db.prepare('insert into tx_permits values (?, ?, ?, ?, ?, ?, ?)');
for (const [n, c, z, num] of [
  ['TEXAS PRECISION PLUMBING SERVICES LLC', 'denton', '76201', '123'], ['PRECISION AUTO', 'denton', '76201', '124'],
  ['TEXAS PRECISION PLUMBING SERVICES LLC', 'frisco', '75034', '125'], ['KNEE DEEP PLUMBING', 'krum', '76249', '126'],
  ['SMITH PLUMBING', 'denton', '76201', '127'],
]) ins.run('sales_tax', num, n, S.permitNorm(n), c, z, '061');
assert.equal(S.matchPermit(db, 'Texas Precision Plumbing Services LLC', 'Denton, TX')?.taxpayer_number, '123');
assert.equal(S.matchPermit(db, 'Texas Precision Plumbing Services LLC', 'Aubrey, TX'), null); // other city, no zip
assert.equal(S.matchPermit(db, 'Knee Deep Plumbing', 'Aubrey, TX', '76249')?.taxpayer_number, '126'); // other city, same zip
assert.equal(S.matchPermit(db, 'Precision Roofing', 'Denton, TX'), null);
assert.equal(S.matchPermit(db, 'Smith Plumbing Services LLC', 'Denton, TX')?.taxpayer_number, '127');
assert.equal(S.matchPermit(db, 'Smith Roofing', 'Denton, TX'), null);
assert.equal(S.matchPermit(db, 'Texas Precision Plumbing Service', 'Denton, TX')?.taxpayer_number, '123');
assert.equal(S.matchPermit(db, 'Texas Precision Plumbing Pros', 'Denton, TX'), null); // "texas precision pros": 0.87, below 0.9
assert.equal(S.nameMatch(S.permitNorm("Ben's Plumbing"), S.permitNorm('E&S PLUMBING LLC')), 0);
assert.equal(S.nameMatch(S.permitNorm('DRIP Plumbing'), S.permitNorm('DRIP PLUMBING LLC')), 1);
assert.equal(S.nameMatch(S.permitNorm('Plumbing Services'), S.permitNorm('PLUMBING SERVICES INC')), 0); // nothing left to compare

// ---- backfill stop rule ----
const stop = S.makeStopper();
assert.equal(stop(null), false);
assert.equal(stop('timeout'), false);
assert.equal(stop('selectors_stale'), false);
assert.equal(stop('selectors_stale'), false);
assert.equal(stop(null), false); // a success resets the stale streak
assert.equal(stop('selectors_stale'), false);
assert.equal(stop('selectors_stale'), false);
assert.equal(stop('selectors_stale'), true);
assert.equal(S.makeStopper()('challenge_detected'), true);
assert.equal(S.makeStopper()('budget_exhausted'), true);

// ---- census ----
assert.equal(S.streetOf('2601 Preston Rd, Ste 100, Frisco, TX'), '2601 Preston Rd');
assert.equal(S.streetOf('2601 Preston Rd Suite 100'), '2601 Preston Rd');
assert.equal(S.streetOf('2601 Preston Rd #4'), '2601 Preston Rd');
assert.deepEqual(S.geocodeParts({ address: '92 Tecumseh Rd, Pilot Point, TX 76258', city: 'Aubrey' }), ['92 Tecumseh Rd', 'pilot point', 'TX', '76258']);
assert.deepEqual(S.geocodeParts({ address: '92 Tecumseh Rd', city: 'Aubrey, TX', zip: null }), ['92 Tecumseh Rd', 'aubrey', 'TX', '']);
assert.deepEqual(S.geocodeParts({ address: '7460 Warren Pkwy #100, Frisco, TX 75034', city: 'Frisco' }), ['7460 Warren Pkwy', 'frisco', 'TX', '75034']);
const census = S.parseCensus([
  '"0","215 E McKinney St, Denton, TX, 76201","Match","Exact","215 E MCKINNEY ST, DENTON, TX, 76201","-97.130879225528,33.216606507904","103339020","L","48","121","020601","3021"',
  '"1","123 Nowhere Lane, Faketown, TX, ","No_Match"',
  '"2","1 Elm, Dallas, TX, ","Match","Non_Exact","1 ELM ST, DALLAS, TX, 75201","-96.79,32.77","1","R","48","113","1","1"',
].join('\n'));
assert.deepEqual(census.get('0'), { match: 'exact', lat: 33.216606507904, lng: -97.130879225528, county_fips: '48121' });
assert.deepEqual(census.get('1'), { match: 'no_match' });
assert.equal(census.get('2').match, 'non_exact');
assert.equal(census.get('2').county_fips, '48113');

// ---- backfill job + score_leads force, against fake harvest / supabase servers ----
const queries = [];
let candidates = [];
let answers = {};
const leadRow = (id) => ({ source_id: id, name: `Lead ${id}`, city: 'Aubrey, TX', address: null, zip: null, phone: null, phone_e164: null,
  category: 'Plumber', review_count: '12', website_class: 'none', closed_status: null, newest_review_date: '2026-10-01',
  hours_present: true, photo_count: 3, geo_match: null, geo_county_fips: null, geocoded_at: null });
const rowsFor = (q) => {
  queries.push(q);
  if (/^select selectors, version from active_selectors/.test(q)) return [];
  if (/^select source_id, google_maps_url from/.test(q)) return candidates;
  if (/^select source_id,name,city,/.test(q)) return [...q.matchAll(/'(\w+)'/g)].map((m) => m[1]).filter((id) => /^[a-z]$/.test(id)).map(leadRow);
  if (/^update /.test(q)) return [];
  throw new Error(`unexpected sql: ${q.slice(0, 80)}`);
};
const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const supabase = {
  callTool: async (name, { query }) => reply({ result: `<untrusted-data-ab12>\n${JSON.stringify(rowsFor(query.trim()))}\n</untrusted-data-ab12>` }),
};
const harvestCalls = [];
const harvest = {
  callTool: async (name, args) => {
    harvestCalls.push([name, args.maps_url]);
    assert.equal(name, 'check_operating');
    return reply(answers[args.maps_url.split('=')[1]]);
  },
};
T.initTileRuns({ harvest, supabase, log: { info() {}, warn() {}, error() {} } });
const ok = { closed_status: null, most_recent_review_date: '2026-10-01', hours_present: true, photo_count: 3, review_count: 12,
  address: '1 Main St, Aubrey, TX 76227', website_url: null };
const runBackfill = async (max) => {
  assert.equal(JSON.parse(S.startBackfill({ max }).content[0].text).started, true);
  for (let i = 0; i < 300; i++) {
    const s = JSON.parse(S.backfillStatus().content[0].text);
    if (!s.running) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('backfill did not finish');
};
const cand = (id) => ({ source_id: id, google_maps_url: `https://www.google.com/maps?cid=${id}` });

// 3 leads: one times out (skipped, left for later), two are filled and re-scored together.
candidates = ['a', 'b', 'c'].map(cand);
answers = { a: ok, b: { error: 'timeout' }, c: { ...ok, website_url: 'https://www.facebook.com/c' } };
let st = await runBackfill(3);
assert.deepEqual([st.candidates, st.checked, st.filled, st.errors, st.scored, st.stop_reason], [3, 3, 2, 1, 2, 'done']);
assert.match(queries.find((q) => /^select source_id, google_maps_url from/.test(q)), /signals_at is null/);
assert.doesNotMatch(queries.find((q) => /^select source_id, google_maps_url from/.test(q)), /state = 'harvested'/); // any state
const fills = queries.filter((q) => /^update .* set closed_status=/s.test(q));
assert.equal(fills.length, 2);
assert.match(fills[0], /newest_review_date='2026-10-01'.*hours_present='true'.*photo_count='3'.*review_count=coalesce\('12'/s);
assert.match(fills[1], /website_class=coalesce\('social_only'/);
assert.match(fills[0], /where source_id='a'/);
const rescoreSelect = queries.find((q) => /^select source_id,name,city,/.test(q));
assert.match(rescoreSelect, /source_id = any\(array\['a','c'\]::text\[\]\)/);
assert.ok(queries.some((q) => /^update .* set score=v\.score::int/s.test(q) && q.includes("'a'") && q.includes("'c'")));

// A Google challenge stops it at once; selectors_stale only on the third in a row.
queries.length = 0; harvestCalls.length = 0;
candidates = ['d', 'e', 'f'].map(cand);
answers = { d: { error: 'challenge_detected' }, e: ok, f: ok };
st = await runBackfill(3);
assert.deepEqual([st.checked, st.filled, st.stop_reason], [1, 0, 'harvest challenge_detected']);
candidates = ['g', 'h', 'i', 'j'].map(cand);
answers = { g: { error: 'selectors_stale' }, h: { error: 'selectors_stale' }, i: { error: 'selectors_stale' }, j: ok };
st = await runBackfill(4);
assert.deepEqual([st.checked, st.errors, st.stop_reason], [3, 3, 'harvest selectors_stale']);
assert.equal(S.startBackfill({ max: 0 }).isError, true);

// score_leads skips rows with no signals unless force=true.
queries.length = 0;
await S.scoreLeads({ limit: 5 });
assert.match(queries.at(-1), /and signals_at is not null/);
await S.scoreLeads({ limit: 5, force: true });
assert.doesNotMatch(queries.at(-1), /signals_at is not null/);
assert.equal((await S.scoreLeadsTool({ force: 'yes' })).isError, true);

await T.stopTileRuns('test over');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('scorer ok');
