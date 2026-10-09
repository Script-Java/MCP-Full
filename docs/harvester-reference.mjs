// Script-based harvester for "no-Website-lead".
// Same rules as the LeadScraper agent's playbook, but no AI in the loop:
// it scrolls the Google Maps results feed, reads the cards, dedupes, inserts, and logs.
//
// Env:
//   DATABASE_URL   Supabase Postgres connection string (Session pooler, port 5432)
//   MAX_SEARCHES   searches per run (default 30)
//   MAX_MINUTES    wall-clock cap per run (default 45)
//   HEADLESS       "false" to watch the browser (default true)
//   DRY_RUN        "true" = browse and report, but write nothing to the database

import { chromium } from 'playwright';
import pg from 'pg';

const MAX_SEARCHES = Number(process.env.MAX_SEARCHES || 30);
const MAX_MINUTES = Number(process.env.MAX_MINUTES || 45);
const HEADLESS = process.env.HEADLESS !== 'false';
const DRY_RUN = process.env.DRY_RUN === 'true';
const MAPS_BASE = process.env.MAPS_BASE || 'https://www.google.com'; // override only for local tests
const PG_SSL = process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false };
const sessionDone = new Set(); // keys finished this run (keeps DRY_RUN from repeating work)

const CATEGORIES = [
  'plumber', 'hvac contractor', 'roofing contractor', 'electrician', 'landscaping service',
  'lawn care service', 'tree service', 'pest control service', 'fence contractor',
  'concrete contractor', 'painter', 'handyman', 'garage door service', 'pressure washing service',
  'auto repair shop', 'appliance repair service', 'flooring contractor', 'junk removal service',
  'locksmith', 'welding service', 'mobile mechanic', 'towing service', 'septic service', 'moving company',
];

// When a 13z search hits Maps' ~120-result cap, redo it at 14z in four quadrants.
const SUB_AREAS = [
  { name: 'NW', dLat: 0.03, dLng: -0.045 },
  { name: 'NE', dLat: 0.03, dLng: 0.045 },
  { name: 'SW', dLat: -0.03, dLng: -0.045 },
  { name: 'SE', dLat: -0.03, dLng: 0.045 },
];
const CAP_THRESHOLD = 115;
const TX_BOX = { minLat: 25.83, maxLat: 36.51, minLng: -106.65, maxLng: -93.5 };
const SOCIAL_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|linktr\.ee)$/i;
const DEFAULT_SELECTORS = {
  feed: 'div[role="feed"]',
  card: 'div[role="article"]',
  card_link: 'a.hfpxzc',
  website_btn: 'a[data-value="Website"]',
  rating: 'span.MW4etd',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.random() * (max - min));
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
  const d = (p || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
};
export const hexToDec = (hex) => BigInt(hex).toString(10);

// ---------- page-side extraction (runs inside the browser) ----------
function extractCards(sel) {
  const clean = (s) => (s || '').replace(/[-]/g, '').replace(/\s+/g, ' ').trim();
  const phoneRe = /(\+1[\s-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
  const hoursRe = /^(open|closed|closes|opens|open 24 hours|temporarily closed|permanently closed)\b/i;
  // Match cards inside the feed element: a card selector that itself starts with the feed
  // (e.g. 'div[role="feed"] > div > div[jsaction]') would never match as `${feed} ${card}`.
  const feedEl = document.querySelector(sel.feed);
  const cards = feedEl ? [...feedEl.querySelectorAll(sel.card)] : [];
  return cards.map((c) => {
    const link = c.querySelector(sel.card_link) || c.querySelector('a[href*="/maps/place/"]');
    const href = link ? link.getAttribute('href') || '' : '';
    const ids = href.match(/!1s(0x[0-9a-f]+):(0x[0-9a-f]+)/i);
    const ll = href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    const web = c.querySelector(sel.website_btn);
    let webHost = null; let webHref = null;
    try { if (web) { const u = new URL(web.href); webHost = u.hostname; webHref = u.origin + u.pathname; } } catch { webHost = null; }
    const lines = c.innerText.split('\n').map(clean).filter(Boolean);
    const name = clean(link?.getAttribute('aria-label')) || lines[0] || null;
    const ratingEl = c.querySelector(sel.rating);
    let rating = ratingEl ? clean(ratingEl.textContent) : null;
    let reviews = null;
    const rl = lines.find((l) => /^\d\.\d\s*\(\d[\d,]*\)$/.test(l));
    if (rl) { const m = rl.match(/^(\d\.\d)\s*\((\d[\d,]*)\)$/); rating = rating || m[1]; reviews = m[2].replace(/,/g, ''); }
    if (lines.some((l) => /^no reviews$/i.test(l))) reviews = '0';
    let phone = null;
    for (const l of lines) { const m = l.match(phoneRe); if (m) { phone = m[0]; break; } }
    let category = null; let address = null;
    const catLine = lines.find((l, i) => i > 0 && l !== name && !hoursRe.test(l) && !phoneRe.test(l)
      && !/^\d\.\d/.test(l) && !/^(no reviews|website|directions|sponsored|call)$/i.test(l));
    if (catLine) {
      const parts = catLine.split(' · ').map(clean);
      category = parts[0] || null;
      address = parts.slice(1).join(' · ') || null;
    }
    return {
      name, category, address, phone, rating, reviews,
      hex: ids ? ids[2] : null,
      lat: ll ? Number(ll[1]) : null,
      lng: ll ? Number(ll[2]) : null,
      hasWebsite: !!web,
      webHost,
      webHref,
      closed: lines.some((l) => /^(permanently|temporarily) closed/i.test(l)),
      sponsored: lines.some((l) => /^sponsored$/i.test(l)),
    };
  });
}

// ---------- database ----------
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: PG_SSL, max: 2 });
const q = (text, params) => pool.query(text, params);

async function loadSelectors() {
  const { rows } = await q('select selectors, version from active_selectors limit 1');
  if (!rows.length) throw new Error('active_selectors is empty');
  return { sel: { ...DEFAULT_SELECTORS, ...rows[0].selectors }, version: rows[0].version };
}

async function geocode(city) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(`${city}, Texas`)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'unasystems-harvester/1.0 (lead research)' } });
  const [hit] = await res.json();
  if (!hit) throw new Error(`could not geocode ${city}`);
  await sleep(1100); // Nominatim policy: max 1 request/second
  return { lat: Number(hit.lat), lng: Number(hit.lon) };
}

// Decide what to search next, using search_log exactly like the agent does.
async function nextWork() {
  const { rows: log } = await q('select city, category, status, sub_area from search_log');
  const sample = log.find((r) => r.city);
  const cityLabel = (c) => (sample && /,\s*tx$/i.test(sample.city) ? `${c}, TX` : c);
  const byKey = new Map();
  for (const r of log) {
    const k = `${norm(r.city)}|${(r.category || '').toLowerCase()}`;
    if (!byKey.has(k)) byKey.set(k, { done: false, subs: new Set() });
    const e = byKey.get(k);
    if (r.status === 'done') e.done = true;
    const s = (r.sub_area || 'center').toLowerCase();
    for (const a of ['nw', 'ne', 'sw', 'se']) if (new RegExp(`\\b${a}\\b`).test(s)) e.subs.add(a.toUpperCase());
    if (/center|full|whole/.test(s)) e.subs.add('center');
  }
  const { rows: towns } = await q('select * from harvest_towns where not skip order by priority');
  for (const t of towns) {
    for (const cat of CATEGORIES) {
      const key = `${norm(t.city)}|${cat}`;
      const e = byKey.get(key);
      if (e?.done || sessionDone.has(key)) continue;
      if (t.lat == null) {
        const g = await geocode(t.city);
        if (!DRY_RUN) await q('update harvest_towns set lat=$1, lng=$2, updated_at=now() where city=$3', [g.lat, g.lng, t.city]);
        Object.assign(t, g);
      }
      return { key, town: t, city: cityLabel(t.city), category: cat, already: e ? e.subs : new Set() };
    }
  }
  return null;
}

async function loadSpam() {
  const { rows } = await q('select lat, lng from spam_coords');
  return rows;
}

// ---------- one search ----------
async function runSearch(page, sel, { category, city, lat, lng, zoom }) {
  const town = city.replace(/,\s*TX$/i, '');
  const url = `${MAPS_BASE}/maps/search/${encodeURIComponent(`${category} near ${town} TX`).replace(/%20/g, '+')}/@${lat},${lng},${zoom}z?hl=en`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const challenged = async () => /\/sorry\/|consent\.google/.test(page.url())
    || (await page.locator('text=/unusual traffic|not a robot/i').count()) > 0;
  if (await challenged()) return { challenged: true };
  try {
    await page.waitForSelector(sel.feed, { timeout: 20000 });
  } catch {
    if (await challenged()) return { challenged: true };
    return { feedMissing: true };
  }
  let last = -1; let stable = 0;
  for (let i = 0; i < 60 && stable < 3; i++) {
    const count = await page.evaluate(({ feed, card }) => {
      const f = document.querySelector(feed);
      if (f) f.scrollTop = f.scrollHeight;
      return f ? f.querySelectorAll(card).length : 0;
    }, sel);
    const atEnd = await page.locator("text=/You've reached the end of the list/i").count();
    if (count >= 150 || atEnd) break;
    stable = count === last ? stable + 1 : 0;
    last = count;
    await sleep(1500);
  }
  if (await challenged()) return { challenged: true };
  const cards = await page.evaluate(extractCards, sel);
  // No cards but the feed holds place links: the card selectors are broken, don't log it as done.
  if (!cards.length && (await page.locator(`${sel.feed} a[href*="/maps/place/"]`).count()) > 0) return { feedMissing: true };
  return { cards };
}

// ---------- filter, dedupe, insert ----------
async function processCards(cards, ctx, spam, selectorVersion) {
  const stats = { seen: cards.length, inserted: 0, dupes: 0, outOfArea: 0, closed: 0, incomplete: 0, websites: 0 };
  const cand = [];
  const seenInBatch = new Set();
  for (const c of cards) {
    if (c.hasWebsite && !(c.webHost && SOCIAL_HOSTS.test(c.webHost))) { stats.websites++; continue; }
    if (c.sponsored) continue;
    if (c.closed) { stats.closed++; continue; }
    if (!c.name || !c.hex || (!c.phone && !c.address)) { stats.incomplete++; continue; }
    if (c.lat != null) {
      const inTx = c.lat >= TX_BOX.minLat && c.lat <= TX_BOX.maxLat && c.lng >= TX_BOX.minLng && c.lng <= TX_BOX.maxLng;
      const isSpam = spam.some((s) => Math.abs(s.lat - c.lat) < 0.0005 && Math.abs(s.lng - c.lng) < 0.0005);
      if (!inTx || isSpam) { stats.outOfArea++; continue; }
    }
    const p10 = phone10(c.phone);
    const key = p10 || `n:${nameNorm(c.name)}`;
    if (seenInBatch.has(key)) { stats.dupes++; continue; }
    seenInBatch.add(key);
    cand.push({ ...c, p10, nn: nameNorm(c.name), sourceId: hexToDec(c.hex) });
  }
  if (!cand.length) return stats;

  const phones = cand.map((c) => c.p10).filter(Boolean);
  const names = cand.filter((c) => !c.p10).map((c) => c.nn);
  const existingPhones = new Set();
  const existingNames = new Set();
  if (phones.length) {
    const { rows } = await q(
      `select right(regexp_replace(phone, '\\D', '', 'g'), 10) as p10 from "no-Website-lead"
       where right(regexp_replace(phone, '\\D', '', 'g'), 10) = any($1)`, [phones]);
    rows.forEach((r) => existingPhones.add(r.p10));
  }
  if (names.length) {
    const { rows } = await q('select name_norm from "no-Website-lead" where name_norm = any($1)', [names]);
    rows.forEach((r) => existingNames.add(r.name_norm));
  }
  const fresh = cand.filter((c) => (c.p10 ? !existingPhones.has(c.p10) : !existingNames.has(c.nn)));
  stats.dupes += cand.length - fresh.length;
  if (!fresh.length || DRY_RUN) { if (DRY_RUN) stats.inserted = fresh.length; return stats; }

  const cols = ['name', 'category', 'address', 'phone', 'city', 'rating', 'review_count', 'google_maps_url',
    'source_id', 'zip', 'name_norm', 'phone_e164', 'website_class', 'social_or_notes', 'found_on', 'state', 'selector_version'];
  for (let i = 0; i < fresh.length; i += 50) {
    const batch = fresh.slice(i, i + 50);
    const values = []; const params = [];
    batch.forEach((c, j) => {
      const social = c.hasWebsite;
      params.push(
        c.name, c.category, c.address, c.phone, ctx.city, c.rating, c.reviews,
        `https://www.google.com/maps?cid=${c.sourceId}`, c.sourceId,
        (c.address || '').match(/\b(7[5-9]\d{3})\b/)?.[1] || null,
        c.nn, c.p10 ? `+1${c.p10}` : null,
        social ? 'social_only' : 'none', social ? (c.webHref || c.webHost) : null,
        `${ctx.category} @${ctx.lat},${ctx.lng},${ctx.zoom}z`, 'harvested', selectorVersion,
      );
      values.push(`(${cols.map((_, k) => `$${j * cols.length + k + 1}`).join(',')})`);
    });
    const { rowCount } = await q(
      `insert into "no-Website-lead" (${cols.join(',')}) values ${values.join(',')}
       on conflict (source_id) do nothing`, params);
    stats.inserted += rowCount;
  }
  return stats;
}

async function logSearch(ctx, stats, status, notes) {
  if (DRY_RUN) return null;
  const { rows } = await q(`insert into search_log (city, category, sub_area, zoom, cards_seen, inserted, duplicates_skipped, out_of_area, status, notes)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [ctx.city, ctx.category, ctx.subArea, ctx.zoom, stats.seen, stats.inserted, stats.dupes, stats.outOfArea, status, notes]);
  return rows[0]?.id ?? null;
}

// ---------- main ----------
async function main() {
  const t0 = Date.now();
  const { rows: [run] } = DRY_RUN ? { rows: [{ id: null }] } : await q("insert into harvest_runs (runner) values ('script') returning id");
  const totals = { searches: 0, seen: 0, inserted: 0, dupes: 0, outOfArea: 0 };
  let status = 'ok'; let stopReason = null; let selectorVersion = null;
  const browser = await chromium.launch({ headless: HEADLESS });
  try {
    const ctxB = await browser.newContext({ locale: 'en-US', timezoneId: 'America/Chicago', viewport: { width: 1280, height: 900 } });
    const page = await ctxB.newPage();
    const { sel, version } = await loadSelectors();
    selectorVersion = version;
    const spam = await loadSpam();
    let zeroWebsiteStreak = 0; const zeroWebsiteIds = [];

    outer: while (totals.searches < MAX_SEARCHES) {
      if ((Date.now() - t0) / 60000 > MAX_MINUTES) { stopReason = 'time cap'; break; }
      const work = await nextWork();
      if (!work) { stopReason = 'town list exhausted — add towns to harvest_towns'; break; }
      const { key, town, city, category, already } = work;

      // Center first at 13z. If it was capped (now or in an earlier partial), do the quadrants at 14z.
      let needQuadrants = already.size > 0;
      const pending = already.has('center') ? [] : [{ subArea: 'center', lat: town.lat, lng: town.lng, zoom: 13 }];
      const nextArea = () => {
        if (pending.length) return pending.shift();
        if (!needQuadrants) return null;
        const q4 = SUB_AREAS.find((s) => !already.has(s.name));
        return q4 ? { subArea: q4.name, lat: +(town.lat + q4.dLat).toFixed(6), lng: +(town.lng + q4.dLng).toFixed(6), zoom: 14 } : null;
      };
      let didAny = false;
      for (let next = nextArea(); next; next = nextArea()) {
        didAny = true;
        if (totals.searches >= MAX_SEARCHES || (Date.now() - t0) / 60000 > MAX_MINUTES) break outer;
        const ctx = { city, category, ...next };
        const res = await runSearch(page, sel, ctx);
        totals.searches++;
        if (res.challenged) { status = 'challenged'; stopReason = `CAPTCHA/unusual-traffic on ${category} ${city} ${next.subArea}`; break outer; }
        if (res.feedMissing) { status = 'selector_broken'; stopReason = `feed or card selectors did not resolve (${sel.feed} / ${sel.card}) on ${category} ${city}`; break outer; }

        // Website selector sanity check BEFORE inserting: 10+ cards and zero website buttons
        // means the selector is probably broken, and every card would look like a lead.
        if (res.cards.length >= 10 && !res.cards.some((c) => c.hasWebsite)) {
          zeroWebsiteStreak++;
          totals.seen += res.cards.length;
          const logId = await logSearch(ctx, { seen: res.cards.length, inserted: 0, dupes: 0, outOfArea: 0 }, 'done',
            'script; website button matched 0 cards — category skipped, nothing inserted');
          zeroWebsiteIds.push(logId);
          sessionDone.add(key);
          if (zeroWebsiteStreak >= 2) {
            // Probably a broken selector, not two genuinely odd categories: reopen both so they get retried after the fix.
            if (!DRY_RUN) await q(`update search_log set status='partial', sub_area='reopened', notes=notes || ' (reopened: selector suspected broken)' where id = any($1)`, [zeroWebsiteIds.filter(Boolean)]);
            status = 'selector_broken'; stopReason = `website_btn matched 0 cards on 2 categories in a row (${sel.website_btn})`; break outer;
          }
          break;
        }
        zeroWebsiteStreak = 0; zeroWebsiteIds.length = 0;

        const stats = await processCards(res.cards, ctx, spam, version);
        totals.seen += stats.seen; totals.inserted += stats.inserted; totals.dupes += stats.dupes; totals.outOfArea += stats.outOfArea;

        if (next.subArea === 'center' && stats.seen >= CAP_THRESHOLD) needQuadrants = true;
        already.add(next.subArea);
        const remaining = needQuadrants ? SUB_AREAS.filter((s) => !already.has(s.name)) : [];
        const finished = remaining.length === 0;
        await logSearch(ctx, stats, finished ? 'done' : 'partial',
          finished ? `script; closed ${stats.closed}, incomplete ${stats.incomplete}`
                   : `script; ${next.subArea === 'center' ? `capped at ${stats.seen}` : `${next.subArea} done`} — next sub-area ${remaining[0].name}`);
        console.log(`${city} | ${category} | ${next.subArea} → seen ${stats.seen}, new ${stats.inserted}, dupes ${stats.dupes}, out ${stats.outOfArea}`);
        await jitter(Number(process.env.MIN_DELAY_MS ?? 12000), Number(process.env.MAX_DELAY_MS ?? 30000)); // be gentle with Maps
        if (finished) { sessionDone.add(key); break; }
      }
      if (!didAny) { // every sub-area was already logged but nobody marked it done
        await logSearch({ city, category, subArea: 'all', zoom: 14 }, { seen: 0, inserted: 0, dupes: 0, outOfArea: 0 }, 'done', 'script; all sub-areas already searched');
        sessionDone.add(key);
      }
    }
    if (!stopReason) stopReason = 'search cap';
  } catch (err) {
    status = 'error'; stopReason = String(err?.message || err).slice(0, 500);
    console.error(err);
  } finally {
    await browser.close();
    if (!DRY_RUN && run.id) {
      await q(`update harvest_runs set finished_at=now(), status=$1, stop_reason=$2, selector_version=$3,
               searches=$4, cards_seen=$5, inserted=$6, duplicates=$7, out_of_area=$8 where id=$9`,
        [status, stopReason, selectorVersion, totals.searches, totals.seen, totals.inserted, totals.dupes, totals.outOfArea, run.id]);
    }
    console.log(JSON.stringify({ status, stopReason, ...totals }));
    await pool.end();
    process.exitCode = status === 'ok' ? 0 : 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
export { extractCards, processCards };
