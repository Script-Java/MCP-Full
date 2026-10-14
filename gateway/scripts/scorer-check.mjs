// Offline checks for src/scorer.js: node scripts/scorer-check.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as S from '../src/scorer.js';

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
assert.equal(S.permitNorm('A & B Plumbing, L.L.C.'), 'a b plumbing');
assert.equal(S.cityNorm('Little Elm, TX'), 'little elm');
assert.equal(S.comptrollerCode('48121'), '061'); // Denton
assert.equal(S.comptrollerCode('48439'), '220'); // Tarrant
assert.ok(S.similarity('good plumbing', 'good plumbing services') < 0.8);
assert.ok(S.similarity('texas precision plumbing services', 'texas precision plumbing service') >= 0.8);
const db = new DatabaseSync(':memory:');
db.exec('create table tx_permits (source text, taxpayer_number text, name text, name_norm text, city text, county text)');
const ins = db.prepare('insert into tx_permits values (?, ?, ?, ?, ?, ?)');
for (const [n, c] of [['TEXAS PRECISION PLUMBING SERVICES LLC', 'denton'], ['PRECISION AUTO', 'denton'], ['TEXAS PRECISION PLUMBING SERVICES LLC', 'frisco']]) {
  ins.run('sales_tax', '123', n, S.permitNorm(n), c, '061');
}
assert.equal(S.matchPermit(db, 'Texas Precision Plumbing Services LLC', 'Denton, TX')?.taxpayer_number, '123');
assert.equal(S.matchPermit(db, 'Texas Precision Plumbing Services LLC', 'Aubrey, TX'), null); // other city
assert.equal(S.matchPermit(db, 'Precision Roofing', 'Denton, TX'), null);
assert.equal(S.nameMatch(S.permitNorm("Ben's Plumbing"), S.permitNorm('E&S PLUMBING LLC')), 0);
assert.ok(S.nameMatch(S.permitNorm('DRIP Plumbing'), S.permitNorm('DRIP PLUMBING LLC')) === 1);
assert.ok(S.nameMatch(S.permitNorm('Plumbing Services'), S.permitNorm('PLUMBING SERVICES INC')) === 1);

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

console.log('scorer ok');
