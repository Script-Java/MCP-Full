// Overture Places for scorer v2: the latest release (found through Overture's STAC catalog), cut to the DFW box,
// into public.overture_places (docs/migrations.sql section 8). Runs inside the container, where PORT and
// MCP_GATEWAY_TOKEN are set; the gateway starts it monthly (OVERTURE_CRON) and when no release is loaded yet:
//   node scripts/overture-load.mjs [--dry-run] [--force]
// --dry-run: download and count, write nothing (no gateway needed). --force: reload a release that is already loaded.
// While it refills the table, overture_meta.status is 'loading' and score_leads waits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { DuckDBInstance } from '@duckdb/node-api';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const BOX = { south: 32.55, west: -97.55, north: 33.6, east: -96.45 };
const STAC = 'https://stac.overturemaps.org/catalog.json';
// STAC is outside input and the URLs go into DuckDB SQL: only Overture's own bucket, no quotes.
const PARQUET_URL = /^https:\/\/overturemaps-us-west-2\.s3\.us-west-2\.amazonaws\.com\/release\/[\w.=/-]+\.parquet$/;
const BATCH = 500;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const getJson = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
};
const child = (doc, pick) => {
  const l = doc.links.find((x) => x.rel === 'child' && pick(x));
  if (!l) throw new Error(`STAC: no matching child in ${doc.id}`);
  return getJson(l.href);
};

// ---- gateway (supabase__execute_sql), as in lead-run.mjs ----
let sql = async () => { throw new Error('dry run: no database'); };
if (!DRY) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const c = new Client({ name: 'overture-load', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${process.env.PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_GATEWAY_TOKEN}`, 'X-MCP-Async': 'off' } },
  }));
  sql = async (query) => {
    const r = await c.callTool({ name: 'supabase__execute_sql', arguments: { query } }, undefined, { timeout: 200000 });
    const t = r.content?.[0]?.text ?? '';
    let body = t;
    try { body = JSON.parse(t).result ?? t; } catch {}
    const m = body.match(/<untrusted-data-([\w-]+)>\n([\s\S]*?)\n<\/untrusted-data-\1>/);
    if (!m) throw new Error(`sql failed: ${body.slice(0, 300)}`);
    return JSON.parse(m[2]);
  };
}
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/\0/g, '').replace(/'/g, "''")}'`);

// 1. Latest release -> places/place items whose bbox overlaps BOX -> their parquet files.
const root = await getJson(STAC);
const release = root.latest;
const relCat = await child(root, (l) => l.latest === true || l.href.includes(`/${release}/`));
const place = await child(await child(relCat, (l) => l.title === 'places'), (l) => l.title === 'place');
const files = [];
for (const l of place.links.filter((x) => x.rel === 'item')) {
  const item = await getJson(l.href);
  const [w, s, e, n] = item.bbox;
  if (w > BOX.east || e < BOX.west || s > BOX.north || n < BOX.south) continue;
  const href = item.assets?.aws?.href;
  if (!PARQUET_URL.test(href ?? '')) throw new Error(`unexpected parquet url: ${String(href).slice(0, 200)}`);
  files.push(href);
}
log(`release ${release}: ${files.length} of ${place.links.filter((x) => x.rel === 'item').length} place files overlap the box`);
if (!files.length) throw new Error('no place file overlaps the box');

if (!DRY && !FORCE) {
  const meta = (await sql('select release, status from overture_meta where id = 1'))[0];
  if (meta?.release === release && meta.status === 'ready') { log('already loaded; nothing to do'); process.exit(0); }
}

// 2. DuckDB: rows in the box -> NDJSON in tmp (points, so the bbox centre is the point).
const tmp = path.join(os.tmpdir(), `overture-${release}.ndjson`);
const db = await DuckDBInstance.create(':memory:', { memory_limit: '1GB', threads: '2' });
const duck = await db.connect();
await duck.run(`set extension_directory = ${lit(path.join(process.env.MCP_DATA_DIR || os.tmpdir(), 'duckdb-ext'))}`);
await duck.run('install httpfs; load httpfs;');
const t0 = Date.now();
await duck.run(`copy (
  select id, names."primary" as name, confidence, websites, socials, phones,
    [{'freeform': a.freeform, 'locality': a.locality, 'postcode': a.postcode, 'region': a.region} for a in addresses] as addresses,
    (bbox.xmin + bbox.xmax) / 2 as lng, (bbox.ymin + bbox.ymax) / 2 as lat
  from read_parquet([${files.map(lit).join(', ')}])
  where bbox.xmin <= ${BOX.east} and bbox.xmax >= ${BOX.west} and bbox.ymin <= ${BOX.north} and bbox.ymax >= ${BOX.south}
) to ${lit(tmp)} (format json)`);
log(`downloaded in ${Math.round((Date.now() - t0) / 1000)} s: ${(fs.statSync(tmp).size / 1e6).toFixed(0)} MB`);

const e164 = (p) => {
  const n = parsePhoneNumberFromString(String(p ?? ''), 'US');
  return n?.isPossible() ? n.number : null;
};

// 3. Refill overture_places in batches.
if (!DRY) {
  await sql(`insert into overture_meta (id, release, status, rows, started_at, loaded_at) values (1, ${lit(release)}, 'loading', null, now(), null)
    on conflict (id) do update set release = excluded.release, status = 'loading', rows = null, started_at = now(), loaded_at = null`);
  await sql('truncate overture_places');
}
let n = 0; let web = 0; let phoned = 0; let sample = null;
let batch = [];
const flush = async () => {
  if (!batch.length) return;
  if (!DRY) {
    await sql(`insert into overture_places select * from jsonb_populate_recordset(null::overture_places, ${lit(JSON.stringify(batch))}::jsonb)
      on conflict (id) do nothing`);
  }
  batch = [];
};
for await (const line of readline.createInterface({ input: fs.createReadStream(tmp) })) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  r.phones_e164 = [...new Set((r.phones ?? []).map(e164).filter(Boolean))];
  n++; if (r.websites?.length) web++; if (r.phones_e164.length) phoned++;
  sample ??= r;
  batch.push(r);
  if (batch.length >= BATCH) {
    await flush();
    if (n % 50000 === 0) log(`${n} rows`);
  }
}
await flush();
fs.rmSync(tmp, { force: true });

if (!DRY) {
  const [{ count }] = await sql('select count(*)::int as count from overture_places');
  await sql(`update overture_meta set status = 'ready', rows = ${Number(count)}, loaded_at = now() where id = 1`);
  log(`loaded ${count} rows`);
}
log('done', JSON.stringify({ release, rows: n, with_website: web, with_phone: phoned, dry_run: DRY, sample: DRY ? sample : undefined }));
process.exit(0);
