// Offline self-check for src/tile-run.js: node scripts/tile-run-check.mjs
// Pure helpers, then whole runs against fake harvest/supabase upstreams (no network, no database).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-run-'));
process.env.MCP_DATA_DIR = tmp;
process.env.TILE_RUN_MIN_DELAY_MS = '0';
process.env.TILE_RUN_MAX_DELAY_MS = '0';
delete process.env.TILE_RUN_CRON;
const T = await import('../src/tile-run.js');

// ---- CID conversion, normalisation, SQL literals ----
assert.equal(T.cidToDecimal('15206450886171335178'), '15206450886171335178');
assert.equal(T.cidToDecimal('0x1a2b'), '6699');
assert.equal(T.cidToDecimal(null, 'https://www.google.com/maps?cid=123456'), '123456');
assert.equal(T.cidToDecimal(null, 'https://www.google.com/maps/place/X/data=!4m7!3m6!1s0x864c3c:0xd3071d5d0a7c2c0a!8m2'), BigInt('0xd3071d5d0a7c2c0a').toString());
assert.equal(T.cidToDecimal(null, 'https://www.google.com/maps/place/X'), null);
assert.deepEqual(T.coordsFromUrl('https://www.google.com/maps/place/X/data=!3d33.2523966!4d-97.1083496!16s'), { lat: 33.2523966, lng: -97.1083496 });
assert.equal(T.nameNorm("Joe's Plumbing, LLC"), 'joe s plumbing');
assert.equal(T.phone10('+1 (214) 555-0101'), '2145550101');
assert.equal(T.phone10('555-0101'), null);
assert.equal(T.lit("O'Brien\0 Co"), "'O''Brien Co'");
assert.equal(T.lit(''), 'NULL');
assert.equal(T.lit(4.5), "'4.5'");
assert.equal(T.lit(NaN), 'NULL');

// ---- filters ----
const card = (o) => ({ name: 'Good Plumbing', maps_cid: '111', maps_url: 'https://www.google.com/maps?cid=111', rating: 4.8, review_count: 12,
  has_website: false, website_url: null, sponsored: false, address_line: '1 Main St', phone: '(214) 555-0101', category_label: 'Plumber',
  lat: 33.3, lng: -96.95, closed: false, ...o });
const spam = [{ lat: 33.2523966, lng: -97.1083496 }];
const f = T.filterCards([
  card({}),
  card({ name: 'Has Site', has_website: true, website_url: 'https://hassite.com/', phone: '2145550102' }),
  card({ name: 'Social', maps_cid: '222', has_website: true, website_url: 'https://www.facebook.com/socialco?ref=x', phone: '2145550103' }),
  card({ name: 'Linktree', maps_cid: '223', has_website: true, website_url: 'https://linktr.ee/x', phone: '2145550104' }),
  card({ name: 'Ad', maps_cid: '333', sponsored: true, phone: '2145550105' }),
  card({ name: 'Closed', maps_cid: '444', closed: true, phone: '2145550106' }),
  card({ name: 'No contact', maps_cid: '555', phone: null, address_line: null }),
  card({ name: 'No cid', maps_cid: null, maps_url: 'https://www.google.com/maps/place/x', phone: '2145550107' }),
  card({ name: 'Oklahoma', maps_cid: '666', lat: 36.9, lng: -97.0, phone: '2145550108' }),
  card({ name: 'Spam pin', maps_cid: '777', lat: 33.2525, lng: -97.1081, phone: '2145550109' }),
  card({ name: 'Same phone', maps_cid: '888' }),
  card({ name: 'No phone', maps_cid: '0x3e7', phone: null, lat: null, lng: null }),
], spam);
assert.deepEqual(f.cand.map((c) => c.name), ['Good Plumbing', 'Social', 'Linktree', 'No phone']);
assert.deepEqual({ ...f.stats }, { seen: 12, inserted: 0, dupes: 1, outOfArea: 2, closed: 1, incomplete: 2, websites: 1 });
assert.equal(f.cand[1].social, true);
assert.equal(f.cand[1].webHref, 'https://www.facebook.com/socialco');
assert.equal(f.cand[3].sourceId, '999');
assert.equal(f.cand[3].p10, null);

// ---- insert SQL ----
const [ins] = T.buildInserts([f.cand[0], f.cand[1]], { city: 'Aubrey, TX', category: 'plumber', lat: 33.3, lng: -96.95, zoom: 13 }, '2026-09-14.1');
assert.match(ins, /^insert into public\."no-Website-lead" \(name,category,address,phone,city,rating,review_count,google_maps_url,source_id,zip,name_norm,phone_e164,website_class,social_or_notes,found_on,state,selector_version\) values /);
assert.match(ins, /'Good Plumbing','Plumber','1 Main St','\(214\) 555-0101','Aubrey, TX','4.8','12','https:\/\/www\.google\.com\/maps\?cid=111','111',NULL,'good plumbing','\+12145550101','none',NULL,'plumber @33\.3,-96\.95,13z','harvested','2026-09-14\.1'\)/);
assert.match(ins, /'social_only','https:\/\/www\.facebook\.com\/socialco'/);
assert.match(ins, /on conflict \(source_id\) do nothing returning source_id$/);
assert.equal(T.buildInserts(Array(120).fill(f.cand[0]), { city: 'X', category: 'c', lat: 1, lng: 2, zoom: 13 }, 'v').length, 3); // 50 per statement

// ---- work picking / resume ----
const towns = [{ city: 'Aubrey', priority: 10, lat: 33.3, lng: -96.95 }, { city: 'Denton', priority: 90, lat: null, lng: null }];
let w = T.planWork([], towns, new Set());
assert.deepEqual([w.city, w.category, [...w.searched]], ['Aubrey', 'plumber', []]);
const logRows = [
  { city: 'Aubrey, TX', category: 'plumber', status: 'done', sub_area: 'center' },
  { city: 'Aubrey, TX', category: 'hvac contractor', status: 'partial', sub_area: 'center' },
  { city: 'Aubrey, TX', category: 'hvac contractor', status: 'partial', sub_area: 'NW' },
];
w = T.planWork(logRows, towns, new Set());
assert.deepEqual([w.city, w.category, [...w.searched].sort(), [...w.capped]], ['Aubrey, TX', 'hvac contractor', ['NW', 'center'], ['center']]);
w = T.planWork([...logRows, { city: 'Aubrey, TX', category: 'roofing contractor', status: 'partial', sub_area: 'reopened' }], towns, new Set(['aubrey|hvac contractor']));
assert.deepEqual([w.category, w.searched.size], ['roofing contractor', 0]);
// Partial sub-areas come first, even in a lower-priority town; reopened rows (no sub-areas) don't count.
w = T.planWork([
  { city: 'Aubrey', category: 'roofing contractor', status: 'partial', sub_area: 'reopened' },
  { city: 'Denton', category: 'electrician', status: 'partial', sub_area: 'center' },
  { city: 'Denton', category: 'electrician', status: 'partial', sub_area: 'NW' },
], towns, new Set());
assert.deepEqual([w.city, w.category, [...w.searched].sort()], ['Denton', 'electrician', ['NW', 'center']]);
// Sub-area paths: server names, agent free text, nesting, zoom, pending order.
assert.deepEqual(T.parseSubArea('center'), ['center']);
assert.deepEqual(T.parseSubArea('nw-ne'), ['NW-NE']);
assert.deepEqual(T.parseSubArea('g3-sw-ne'), ['g3-SW-NE']);
assert.deepEqual(T.parseSubArea('reopened'), []);
assert.deepEqual(T.parseSubArea('NW quadrant @33.183037,-96.878532,14z (child of center @33.1507,-96.8236,13z)').sort(), ['NW', 'center']);
assert.deepEqual(T.parseSubArea('SE quadrant @33.118363,-96.768668,14z (final quadrant)'), ['SE']);
assert.deepEqual([T.parentArea('NW'), T.parentArea('NW-NE'), T.parentArea('g3-SW'), T.parentArea('g3'), T.parentArea('center')], ['center', 'NW', 'g3', null, null]);
assert.deepEqual(['center', 'NW', 'NW-NE', 'g2', 'g2-SE', 'g2-SE-NW'].map(T.areaZoom), [13, 14, 15, 13, 14, 15]);
assert.deepEqual(T.pendingAreas(['center'], new Set(), new Set()), ['center']);
assert.deepEqual(T.pendingAreas(['center'], new Set(['center']), new Set()), []);
assert.deepEqual(T.pendingAreas(['center'], new Set(['center', 'NW']), new Set(['center', 'NW']), 15), ['NW-NW', 'NW-NE', 'NW-SW', 'NW-SE', 'NE', 'SW', 'SE']);
assert.deepEqual(T.pendingAreas(['center'], new Set(['center', 'NW', 'NW-NW']), new Set(['center', 'NW', 'NW-NW']), 15).slice(0, 2), ['NW-NE', 'NW-SW'], 'no split below max zoom');
assert.deepEqual(T.pendingAreas(['g0', 'g1'], new Set(['g0']), new Set()), ['g1']);
// Capped from cards_seen (a 14z quadrant with 120 cards gets split again on resume).
w = T.planWork([
  { city: 'Frisco', category: 'lawn care service', status: 'partial', sub_area: 'center', cards_seen: 119 },
  { city: 'Frisco', category: 'lawn care service', status: 'partial', sub_area: 'NW', cards_seen: 120, inserted: 2 },
  { city: 'Frisco', category: 'lawn care service', status: 'partial', sub_area: 'NE', cards_seen: 80 },
], [{ city: 'Frisco', priority: 100, lat: 33.15, lng: -96.82 }], new Set());
assert.deepEqual([...w.capped].sort(), ['NW', 'center']);
assert.deepEqual(T.pendingAreas(['center'], w.searched, w.capped, 15), ['NW-NW', 'NW-NE', 'NW-SW', 'NW-SE', 'SW', 'SE']);
// Below 13z a capped area with no new leads is not split; a 13z root always is.
w = T.planWork([
  { city: 'Frisco', category: 'tree service', status: 'partial', sub_area: 'center', cards_seen: 120, inserted: 0 },
  { city: 'Frisco', category: 'tree service', status: 'partial', sub_area: 'NW', cards_seen: 120, inserted: 0 },
], [{ city: 'Frisco', priority: 100, lat: 33.15, lng: -96.82 }], new Set());
assert.deepEqual([...w.capped], ['center']);
assert.deepEqual([T.splitWorthIt('center', 0), T.splitWorthIt('g2', 0), T.splitWorthIt('NW', 0), T.splitWorthIt('NW', 1), T.splitWorthIt('g2-SE', 3, 5)], [true, true, false, true, false]);
const allAubrey = new Set(T.CATEGORIES.map((c) => `aubrey|${c}`));
assert.equal(T.planWork([], towns, allAubrey).town.city, 'Denton');
assert.equal(T.CATEGORIES.length, 24);

// ---- cron (America/Chicago) ----
const every3h = T.parseCron('0 */3 * * *');
assert.equal(T.cronMatches(every3h, new Date('2026-10-09T14:00:00Z')), true);  // 09:00 CDT
assert.equal(T.cronMatches(every3h, new Date('2026-10-09T15:00:00Z')), false); // 10:00 CDT
assert.equal(T.cronMatches(every3h, new Date('2026-12-01T15:00:00Z')), true);  // 09:00 CST
assert.equal(T.cronMatches(every3h, new Date('2026-10-09T14:01:00Z')), false);
const firstOrMonday = T.parseCron('30 9 1 * 1');
assert.equal(T.cronMatches(firstOrMonday, new Date('2026-10-12T14:30:00Z')), true);  // Monday 12 Oct
assert.equal(T.cronMatches(firstOrMonday, new Date('2026-10-01T14:30:00Z')), true);  // the 1st (a Thursday)
assert.equal(T.cronMatches(firstOrMonday, new Date('2026-10-13T14:30:00Z')), false);
assert.throws(() => T.parseCron('0 */3 * *'));
assert.throws(() => T.parseCron('61 * * * *'));

// ---- whole runs against fakes ----
const db = {
  towns: [{ city: 'Aubrey', priority: 10, lat: 33.3, lng: -96.95, skip: false }],
  log: [{ city: 'Aubrey, TX', category: 'plumber', status: 'done', sub_area: 'center' }],
  existingPhones: ['2145550199'],
  queries: [],
  nextId: 100,
};
const rowsFor = (q) => {
  db.queries.push(q);
  if (/^insert into harvest_runs/.test(q)) return [{ id: 7 }];
  if (/from active_selectors/.test(q) && db.selectorsDown) throw new Error('connection refused');
  if (/from active_selectors/.test(q)) return [{ version: '2026-09-14.1', selectors: { feed: 'div[role="feed"]', website_btn: 'a[data-value="Website"]' } }];
  if (/from spam_coords/.test(q)) return spam;
  if (/from search_log$/.test(q)) { // only the selected columns, like Postgres
    const cols = q.match(/^select (.*) from search_log$/)[1].split(',').map((c) => c.trim());
    return db.log.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
  }
  if (/from harvest_towns/.test(q)) return db.towns;
  if (/^insert into search_log/.test(q)) return [{ id: db.nextId++ }];
  if (/ as p10 from /.test(q)) return db.existingPhones.filter((p) => q.includes(`'${p}'`)).map((p10) => ({ p10 }));
  if (/^select name_norm from/.test(q)) return [];
  if (/^insert into public\."no-Website-lead"/.test(q)) return (q.match(/'harvested'/g) ?? []).map((_, i) => ({ source_id: String(i) }));
  if (/^update /.test(q)) return [];
  throw new Error(`unexpected sql: ${q.slice(0, 80)}`);
};
// Fake Nominatim: boundary boxes per town (Big Town is larger than one 13z search).
const BBOX = { 'Big Town': ['32.6', '33.0', '-97.0', '-96.5'] };
const fetched = [];
globalThis.fetch = async (url) => {
  fetched.push(url);
  const city = decodeURIComponent(url.match(/q=([^&]+)/)[1]).replace(/, Texas$/, '');
  return { json: async () => [{ lat: '33.3', lon: '-96.95', boundingbox: BBOX[city] ?? ['33.28', '33.32', '-96.98', '-96.92'] }] };
};
const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const supabase = {
  callTool: async (name, { query }) => {
    assert.equal(name, 'execute_sql');
    const rows = rowsFor(query.trim());
    return reply({ result: `Below is the result of the SQL query. Use the data within the <untrusted-data-ab12> boundaries.\n\n<untrusted-data-ab12>\n${JSON.stringify(rows)}\n</untrusted-data-ab12>\n` });
  },
};
const harvestCalls = [];
let tiles = [];
const harvest = {
  callTool: async (name, args) => {
    harvestCalls.push([name, args]);
    if (name === 'subdivide_tile') {
      const k = 2 ** (args.zoom - 13);
      return reply({ children: [[1, -1], [1, 1], [-1, -1], [-1, 1]].map(([dy, dx]) => ({ lat: +(args.lat + dy * 0.0324 / k).toFixed(6), lng: +(args.lng + dx * 0.0549 / k).toFixed(6), zoom: args.zoom + 1 })) });
    }
    if (name === 'grid_tiles') {
      const big = args.north - args.south > 0.2;
      const pts = big ? [[32.65, -96.9], [32.65, -96.6], [32.95, -96.9], [32.95, -96.6]] : [[(args.south + args.north) / 2, (args.west + args.east) / 2]];
      return reply({ count: pts.length, tiles: pts.map(([lat, lng]) => ({ lat, lng, zoom: args.zoom })), truncated: false });
    }
    assert.equal(name, 'harvest_tile');
    return reply(tiles.shift() ?? { error: 'internal' });
  },
};
const logs = [];
T.initTileRuns({ harvest, supabase, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) } });

const runToEnd = async (max) => {
  const started = JSON.parse(T.startTileRun({ max_searches: max }).content[0].text);
  assert.equal(started.started, true);
  for (let i = 0; i < 200; i++) {
    const s = JSON.parse(T.tileRunStatus({}).content[0].text);
    if (!s.running) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('run did not finish');
};
const sv = '2026-09-14.1';
const quiet = (n, name) => ({ selector_version: sv, saturated: false, results: [card({ name, maps_cid: String(900 + n), phone: `21455501${10 + n}` }), card({ name: `${name} site`, has_website: true, website_url: 'https://x.com', maps_cid: '1' })] });

// Run 1: saturated centre -> four children -> next category challenged.
tiles = [
  { selector_version: sv, saturated: true, results: [
    card({}), card({ name: 'Has Site', has_website: true, website_url: 'https://hassite.com/' }),
    card({ name: 'Known', maps_cid: '5', phone: '214-555-0199' }), card({ name: 'Social', maps_cid: '222', has_website: true, website_url: 'https://instagram.com/s', phone: '2145550103' }),
  ] },
  quiet(1, 'NW Co'), quiet(2, 'NE Co'), quiet(3, 'SW Co'), quiet(4, 'SE Co'),
  { error: 'challenge_detected', retry_after_s: 900, selector_version: sv },
];
assert.equal(T.startTileRun({ max_searches: 0 }).isError, true);
const first = JSON.parse(T.startTileRun({ max_searches: 10 }).content[0].text);
assert.equal(T.startTileRun({}).isError, true, 'second concurrent run must be refused');
let s1;
for (let i = 0; i < 200 && !(s1 = JSON.parse(T.tileRunStatus({ run_id: first.run_id }).content[0].text), !s1.running); i++) await new Promise((r) => setTimeout(r, 10));
assert.deepEqual([s1.status, s1.searches, s1.inserted, s1.duplicates, s1.harvest_run_id], ['challenged', 6, 6, 1, 7]);
assert.match(s1.stop_reason, /^challenge_detected on roofing contractor Aubrey, TX center/);
const tileArgs = harvestCalls.filter(([n]) => n === 'harvest_tile').map(([, a]) => a);
assert.deepEqual(tileArgs[0], { category: 'hvac contractor', lat: 33.3, lng: -96.95, zoom: 13, limit: 120, extended: true });
assert.deepEqual(tileArgs.slice(1, 5).map((a) => [a.zoom, Math.sign(a.lat - 33.3), Math.sign(a.lng + 96.95)]), [[14, 1, -1], [14, 1, 1], [14, -1, -1], [14, -1, 1]]);
const searchLogInserts = db.queries.filter((q) => q.startsWith('insert into search_log'));
assert.equal(searchLogInserts.length, 5);
assert.match(searchLogInserts[0], /'Aubrey, TX','hvac contractor','center','13','4','2','1','0','partial','server; capped at 4 — next sub-area NW'/);
assert.match(searchLogInserts[1], /'NW','14',.*'partial','server; NW done — next sub-area NE'/);
assert.match(searchLogInserts[4], /'SE','14',.*'done','server; closed 0, incomplete 0'/);
const leadInserts = db.queries.filter((q) => q.startsWith('insert into public."no-Website-lead"'));
assert.match(leadInserts[0], /'hvac contractor @33\.3,-96\.95,13z','harvested','2026-09-14\.1'/);
assert.match(leadInserts[0], /'social_only','https:\/\/instagram\.com\/s'/);
assert.ok(!leadInserts.some((q) => q.includes("'Known'")), 'phone already in the table must not be inserted');
const runRow = db.queries.find((q) => q.startsWith('insert into harvest_runs'));
assert.match(runRow, /values \('server', 'server; /);
assert.match(db.queries.findLast((q) => q.startsWith('update harvest_runs')), /status='challenged'.*searches=6, cards_seen=12, inserted=6, duplicates=1, out_of_area=0 where id=7/s);
const selFile = JSON.parse(fs.readFileSync(T.SELECTORS_FILE, 'utf8'));
assert.equal(selFile.version, '2026-09-14.1');

// Run 2: two categories with 10+ cards and no website button -> selector_broken, nothing inserted, both reopened.
const noWeb = { selector_version: sv, saturated: false, results: Array.from({ length: 12 }, (_, i) => card({ name: `N${i}`, maps_cid: String(i + 10), phone: `21455502${10 + i}` })) };
tiles = [noWeb, noWeb];
db.queries.length = 0;
const s2 = await runToEnd(10);
assert.deepEqual([s2.status, s2.searches, s2.inserted], ['selector_broken', 2, 0]);
assert.ok(!db.queries.some((q) => q.startsWith('insert into public."no-Website-lead"')));
assert.match(db.queries.find((q) => q.startsWith('update search_log')), /set status='partial', sub_area='reopened'.* where id in \(\d+,\d+\)$/s);
assert.deepEqual(db.queries.filter((q) => q.startsWith('insert into search_log')).map((q) => q.match(/'(hvac contractor|roofing contractor)'/)[1]), ['hvac contractor', 'roofing contractor']);

// Run 3: selectors_stale stops at once; nothing logged for that search.
tiles = [{ error: 'selectors_stale', hint: 'results feed not found', selector_version: sv }];
db.queries.length = 0;
const s3 = await runToEnd(10);
assert.deepEqual([s3.status, s3.searches], ['selector_broken', 1]);
assert.ok(!db.queries.some((q) => q.startsWith('insert into search_log')));

// active_selectors unreadable: the copy is removed, so the harvest server uses its built-ins.
db.selectorsDown = true;
await T.refreshSelectors();
assert.equal(fs.existsSync(T.SELECTORS_FILE), false);
db.selectorsDown = false;
await T.refreshSelectors();
assert.equal(JSON.parse(fs.readFileSync(T.SELECTORS_FILE, 'utf8')).version, '2026-09-14.1');

// Run 4: dry run. Geocodes a town once (not saved), counts would-be inserts, writes nothing.
assert.equal(T.startTileRun({ dry_run: 'yes' }).isError, true);
fetched.length = 0;
db.towns = [{ city: 'Pilot Point', priority: 70, lat: null, lng: null, skip: false }];
db.log = [];
tiles = [
  { selector_version: sv, saturated: false, results: [card({ maps_cid: '41' }), card({ name: 'Two', maps_cid: '42', phone: '2145550142' }), card({ name: 'Site', has_website: true, website_url: 'https://s.com' })] },
  { error: 'challenge_detected', selector_version: sv },
];
db.queries.length = 0;
harvestCalls.length = 0;
const started4 = JSON.parse(T.startTileRun({ max_searches: 5, dry_run: true }).content[0].text);
assert.equal(started4.dry_run, true);
assert.match(started4.run_id, /-dry$/);
let s4;
for (let i = 0; i < 200 && !(s4 = JSON.parse(T.tileRunStatus({}).content[0].text), !s4.running); i++) await new Promise((r) => setTimeout(r, 10));
assert.deepEqual([s4.dry_run, s4.status, s4.searches, s4.inserted, s4.harvest_run_id], [true, 'challenged', 2, 2, null]);
assert.deepEqual(db.queries.filter((q) => /^(insert|update|delete)/i.test(q)), [], 'a dry run must not write');
assert.equal(fetched.length, 1, 'geocoded once per run');
assert.match(fetched[0], /q=Pilot%20Point%2C%20Texas/);
assert.deepEqual(harvestCalls.filter(([n]) => n === 'harvest_tile').map(([, a]) => [a.category, a.lat, a.lng]), [['plumber', 33.3, -96.95], ['hvac contractor', 33.3, -96.95]]);

// Run 5: a 116-card centre counts as capped even with saturated=false (reference CAP_THRESHOLD 115).
db.towns = [{ city: 'Aubrey', priority: 10, lat: 33.3, lng: -96.95, skip: false }];
tiles = [
  { selector_version: sv, saturated: false, results: Array.from({ length: 116 }, (_, i) => card({ name: `C${i}`, maps_cid: String(5000 + i), phone: `2145559${String(i).padStart(3, '0')}`, has_website: i % 2 === 0, website_url: i % 2 === 0 ? 'https://w.com' : null })) },
  { error: 'challenge_detected', selector_version: sv },
];
db.queries.length = 0;
harvestCalls.length = 0;
const s5 = await runToEnd(5);
assert.deepEqual([s5.status, s5.searches], ['challenged', 2]);
assert.equal(harvestCalls.filter(([n]) => n === 'harvest_tile')[1][1].zoom, 14, 'next search is the NW child');
assert.match(db.queries.find((q) => q.startsWith('insert into search_log')), /'partial','server; capped at 116 — next sub-area NW'/);

// Run 6: capped quadrant is split again (15z); a capped 15z area is not (max zoom).
const many = (n, base) => ({ selector_version: sv, saturated: false, results: Array.from({ length: n }, (_, i) => card({ name: `M${base}-${i}`, maps_cid: String(base + i), phone: `2146${String(base + i).padStart(6, '0')}`, has_website: i % 2 === 0, website_url: i % 2 === 0 ? 'https://w.com' : null })) });
db.log = [];
tiles = [many(116, 10000), many(118, 20000), many(116, 30000), many(3, 40000), many(3, 41000), many(3, 42000), many(3, 43000), many(3, 44000), many(3, 45000), { error: 'challenge_detected', selector_version: sv }];
db.queries.length = 0;
harvestCalls.length = 0;
const s6 = await runToEnd(20);
const logged6 = db.queries.filter((q) => q.startsWith('insert into search_log')).map((q) => q.match(/'plumber','([^']+)','(\d+)'/).slice(1).join('@'));
assert.deepEqual(logged6, ['center@13', 'NW@14', 'NW-NW@15', 'NW-NE@15', 'NW-SW@15', 'NW-SE@15', 'NE@14', 'SW@14', 'SE@14']);
const notes6 = db.queries.filter((q) => q.startsWith('insert into search_log'));
assert.match(notes6[2], /'partial','server; capped at 116 at max zoom 15 — next sub-area NW-NE'/);
assert.match(notes6[8], /'done','server; closed 0, incomplete 0'/);
assert.deepEqual([s6.searches, s6.status], [10, 'challenged']); // then on to the next category

// Run 6b: a capped 14z quadrant that found no new leads is not split.
db.towns = [{ city: 'Aubrey', priority: 10, lat: 33.3, lng: -96.95, skip: false }];
db.log = [{ city: 'Aubrey', category: 'plumber', status: 'partial', sub_area: 'center', cards_seen: 120, inserted: 3 }];
const known = many(116, 70000);
db.existingPhones = known.results.filter((c) => !c.has_website).map((c) => c.phone.slice(-10));
tiles = [known, { error: 'challenge_detected', selector_version: sv }];
db.queries.length = 0;
await runToEnd(5);
assert.match(db.queries.find((q) => q.startsWith('insert into search_log')), /'NW','14','116','0','58','0','partial','server; capped at 116, no new leads: not split — next sub-area NE'/);
db.existingPhones = ['2145550199'];

// Run 6c: resuming, a capped NW quadrant that found new leads (read back from search_log) is split.
db.log = [
  { city: 'Aubrey', category: 'plumber', status: 'partial', sub_area: 'center', cards_seen: 120, inserted: 3 },
  { city: 'Aubrey', category: 'plumber', status: 'partial', sub_area: 'NW', cards_seen: 120, inserted: 2 },
];
tiles = [many(3, 80000)];
db.queries.length = 0;
await runToEnd(1);
assert.match(db.queries.find((q) => q.startsWith('insert into search_log')), /'Aubrey','plumber','NW-NW','15'/);

// Run 7: a city+category already under way keeps its scheme, even in a town with a big boundary.
db.towns = [{ city: 'Big Town', priority: 5, lat: 32.8, lng: -96.75, skip: false }];
db.log = [{ city: 'Big Town', category: 'plumber', status: 'partial', sub_area: 'center', cards_seen: 120 }];
tiles = [many(3, 50000)];
db.queries.length = 0;
harvestCalls.length = 0;
await runToEnd(1);
assert.match(db.queries.find((q) => q.startsWith('insert into search_log')), /'Big Town','plumber','NW','14'/);

// Run 8: a fresh city+category in a big town is searched as a 13z grid over its boundary.
db.log = [];
tiles = [many(3, 60000), many(3, 61000), many(3, 62000), many(3, 63000), { error: 'challenge_detected', selector_version: sv }];
db.queries.length = 0;
harvestCalls.length = 0;
const s8 = await runToEnd(10);
const logged8 = db.queries.filter((q) => q.startsWith('insert into search_log')).map((q) => q.match(/'Big Town','plumber','([^']+)','(\d+)',.*'(done|partial)'/).slice(1).join('@'));
assert.deepEqual(logged8, ['g0@13@partial', 'g1@13@partial', 'g2@13@partial', 'g3@13@done']);
assert.deepEqual(harvestCalls.filter(([n]) => n === 'harvest_tile').slice(0, 4).map(([, a]) => [a.lat, a.lng, a.zoom]), [[32.65, -96.9, 13], [32.65, -96.6, 13], [32.95, -96.9, 13], [32.95, -96.6, 13]]);
assert.equal(s8.status, 'challenged');
assert.equal(fetched.filter((u) => u.includes('Big%20Town')).length, 1, 'boundary looked up once per process');

await T.stopTileRuns('test over');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('tile-run ok');
