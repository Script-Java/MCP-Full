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

// ---- Overture: website gate, points from confidence >= 0.7 ----
const ovp = (o) => ({ id: 'ov1', name: 'Good Plumbing', matched_by: 'phone', confidence: 0.85, socials: ['https://facebook.com/gp'], website: null, ...o });
r = S.scoreLead(good, { ...sig, overture: ovp() }, now);
assert.deepEqual([r.score, r.breakdown.overture.points, r.breakdown.overture.value.id], [109, 9, 'ov1']);
assert.deepEqual(r.breakdown.overture.value.socials, ['https://facebook.com/gp']);
assert.equal(S.scoreLead(good, { ...sig, overture: ovp({ confidence: 0.69 }) }, now).breakdown.overture.points, 0);
assert.equal(S.scoreLead(good, sig, now).breakdown.overture.points, 0);
r = S.scoreLead(good, { ...sig, overture: ovp({ confidence: 0.3, website: 'https://goodplumbing.com' }) }, now);
assert.deepEqual([r.score, r.tier, r.reject_reason], [0, 'rejected', 'has_website']);
assert.equal(S.realWebsite(['https://www.facebook.com/x', 'http://yelp.com/biz/x', 'goodplumbing.com']), 'goodplumbing.com');
assert.equal(S.realWebsite(['https://m.facebook.com/x', 'https://www.instagram.com/x', 'https://linktr.ee/x']), null);
assert.equal(S.realWebsite(null), null);

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
let leadPatch = {};
let meta = [{ release: '2026-09-23.1', status: 'ready', age_s: 100 }];
let places = [];
const leadRow = (id) => ({ source_id: id, name: `Lead ${id}`, city: 'Aubrey, TX', address: null, zip: null, phone: null, phone_e164: null,
  category: 'Plumber', review_count: '12', website_class: 'none', closed_status: null, newest_review_date: '2026-10-01',
  hours_present: true, photo_count: 3, geo_match: null, geo_county_fips: null, geocoded_at: null, geo_lat: null, geo_lng: null, tier: null,
  ...leadPatch[id] });
const rowsFor = (q) => {
  queries.push(q);
  if (/^select selectors, version from active_selectors/.test(q)) return [];
  if (/^select release, status/.test(q)) return meta;
  if (/^select phone_e164, source_id from/.test(q)) return [];
  if (/^select p\.id, p\.name/.test(q)) return places.filter((p) => p.phones_e164.some((ph) => q.includes(`'${ph}'`)));
  // the 150 m box is the SQL's job; here every place is near every lead, and the JS distance check decides
  if (/^select v\.id as lead_id/.test(q)) return [...q.matchAll(/\('(\w+)','[-\d.]+','[-\d.]+'\)/g)].flatMap((m) => places.map((p) => ({ ...p, lead_id: m[1] })));
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
    return reply(answers[args.maps_url.split(/[=/]/).at(-1)]); // ?cid=<id> or /maps/place/<id>
  },
};
T.initTileRuns({ harvest, supabase, log: { info() {}, warn() {}, error() {} } });
const ok = { closed_status: null, most_recent_review_date: '2026-10-01', hours_present: true, photo_count: 3, review_count: 12,
  address: '1 Main St, Aubrey, TX 76227', website_url: null };
const runBackfill = async (max, city) => {
  assert.equal(JSON.parse(S.startBackfill({ max, city }).content[0].text).started, true);
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
assert.equal(S.startBackfill({ city: 5 }).isError, true);

// city: only those cities (part before the comma, any case), oldest first; place links are candidates too.
queries.length = 0;
candidates = [{ source_id: 'k', google_maps_url: 'https://www.google.com/maps/place/K+Plumbing' }];
answers = { 'K+Plumbing': ok };
st = await runBackfill(3, 'Aubrey, Pilot Point');
assert.deepEqual([st.candidates, st.filled, st.cities], [1, 1, ['aubrey', 'pilot point']]);
const pick = queries.find((q) => /^select source_id, google_maps_url from/.test(q));
assert.match(pick, /lower\(trim\(split_part\(city, ',', 1\)\)\) = any\(array\['aubrey','pilot point'\]::text\[\]\)/);
assert.match(pick, /order by first_seen asc/);
assert.doesNotMatch(pick, /state/);
const urlRe = new RegExp(pick.match(/google_maps_url ~ '([^']+)'/)[1]);
for (const u of ['https://www.google.com/maps?cid=1', 'https://www.google.com/maps/place/X/@1,2', 'https://maps.app.goo.gl/abc']) assert.ok(urlRe.test(u), u);
for (const u of ['http://www.google.com/maps?cid=1', 'https://evil.com/maps', 'https://www.google.com.evil.com/']) assert.ok(!urlRe.test(u), u);
st = await runBackfill(1);
assert.match(queries.filter((q) => /^select source_id, google_maps_url from/.test(q)).at(-1), /order by first_seen desc/);

// score_leads skips rows with no signals unless force=true.
queries.length = 0;
await S.scoreLeads({ limit: 5 });
assert.match(queries.at(-1), /and signals_at is not null/);
await S.scoreLeads({ limit: 5, force: true });
assert.doesNotMatch(queries.at(-1), /signals_at is not null/);
assert.equal((await S.scoreLeadsTool({ force: 'yes' })).isError, true);

// Overture matching inside scoreLeads: phone first; else same name core within 150 m.
const near = (m) => 33.2 + m / 111320; // m metres north of the lead
leadPatch = {
  x: { phone_e164: '+12145550001', tier: 'qualified', name: 'Ex Plumbing' },
  y: { name: 'Yellow Rose Plumbing', geo_lat: 33.2, geo_lng: -96.9, tier: 'review' },
  z: { name: 'Zed Roofing', geo_lat: 33.2, geo_lng: -96.9 },
};
const place = (o) => ({ name: '?', confidence: 0.9, websites: null, socials: null, phones_e164: [], lat: 40, lng: -96.9, ...o });
places = [
  place({ id: 'p1', name: 'Something Else', phones_e164: ['+12145550001'], websites: ['https://explumbing.com'] }),
  place({ id: 'p2', name: 'YELLOW ROSE PLUMBING LLC', confidence: 0.8, lat: near(100), socials: ['https://facebook.com/yr'], websites: ['https://facebook.com/yr'] }),
  place({ id: 'p3', name: 'Zed Roofing', lat: near(300), websites: ['https://zed.com'] }), // too far
  place({ id: 'p4', name: 'Zen Roofing Co', lat: near(20), websites: ['https://zen.com'] }), // other name
];
queries.length = 0;
let sr = await S.scoreLeads({ limit: 5, ids: ['x', 'y', 'z'] });
assert.deepEqual(sr.overture, { release: '2026-09-23.1', matched: 2, website_gate: 1, dropped_for_website: 1, gained_points: 1 });
const scoredUpd = queries.find((q) => /^update .* set score=v\.score::int/s.test(q));
assert.match(scoredUpd, /website_class=coalesce\(v\.wc, t\.website_class\)/);
assert.match(scoredUpd, /\('x','0','rejected',.*'has_website',NULL,'website'\)/);
assert.match(scoredUpd, /"overture":\{"value":\{"id":"p2","name":"YELLOW ROSE PLUMBING LLC","matched_by":"name_150m","confidence":0.8,"socials":\["https:\/\/facebook.com\/yr"\],"website":null\},"points":8\}/);
assert.match(scoredUpd, /\('z',.*"overture":\{"value":null,"points":0\}/);
assert.match(scoredUpd, /scorer_version='v2'/);
// While the table is refilled (or missing): only unscored rows, no Overture lookup, scored as v1.
meta = [{ release: '2026-10-21.0', status: 'loading', age_s: 60 }];
queries.length = 0;
sr = await S.scoreLeads({ limit: 5, ids: ['x', 'y', 'z'] });
assert.equal(sr.scorer_version, 'v1');
assert.match(sr.overture, /^loading: scored without it/);
assert.ok(sr.scored > 0);
assert.doesNotMatch(queries.find((q) => /^select source_id,name,/.test(q)), /scorer_version is distinct/);
assert.ok(!queries.some((q) => /from overture_places|join overture_places/.test(q)));
const v1Upd = queries.find((q) => /^update .* set score=v\.score::int/s.test(q));
assert.match(v1Upd, /scorer_version='v1'/);
assert.match(v1Upd, /"overture":\{"value":"overture_places not loaded yet","points":0\}/);
meta = [{ release: '2026-09-23.1', status: 'ready', age_s: 100 }];

await T.stopTileRuns('test over');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('scorer ok');
