// Licence-roster lead run (harvest/LEADSCRAPER.md steps 3a-6) through this gateway.
// Runs inside the container, where PORT and MCP_GATEWAY_TOKEN are set:
//   node scripts/lead-run.mjs <plumber|electrician> [offset=0] [limit=20] [--dry-run]
// Long runs: nohup node scripts/lead-run.mjs plumber 0 100 > /data/lead-runs/x.log 2>&1 &
// Each kept lead is inserted as soon as it qualifies (ON CONFLICT DO NOTHING), so
// an interrupted run keeps what it found. Stops on the harvest guard errors.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
const DRY = process.argv.includes('--dry-run');
const [trade = 'plumber', offsetArg = '0', limitArg = '20'] = args;
const SRC = { plumber: ['tsbpe', 'Plumber'], electrician: ['tdlr', 'Electrician'] }[trade];
if (!SRC) { console.error('trade must be plumber or electrician'); process.exit(2); }
const [src, category] = SRC;
const STOP = new Set(['challenge_detected', 'circuit_open', 'budget_exhausted', 'selectors_stale']);
const TABLE = 'public."no-Website-lead"';

const c = new Client({ name: 'lead-run', version: '1' });
await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${process.env.PORT}/mcp`), {
  // X-MCP-Async: off -- this script can wait; give it real results, not pending job handles.
  requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_GATEWAY_TOKEN}`, "X-MCP-Async": "off" } },
}));
const tool = async (name, a) => {
  const r = await c.callTool({ name, arguments: a }, undefined, { timeout: 200000 });
  const t = r.content?.[0]?.text ?? '';
  try { return JSON.parse(t); } catch { return { raw: t, isError: r.isError }; }
};
// supabase execute_sql answers {"result": "...<untrusted-data-ID>\n[rows]\n</untrusted-data-ID>"}.
const sql = async (query) => {
  const r = await tool('supabase__execute_sql', { query });
  const text = r.result ?? r.raw ?? '';
  // The intro sentence also names the tag ("...within the below <untrusted-data-ID> boundaries"),
  // so match the real block: tag, newline, rows, newline, matching closing tag.
  const m = text.match(/<untrusted-data-([\w-]+)>\n([\s\S]*?)\n<\/untrusted-data-\1>/);
  if (!m) throw new Error(`sql failed: ${(text || JSON.stringify(r)).slice(0, 300)}`);
  return JSON.parse(m[2]);
};
const lit = (v) => (v === null || v === undefined || v === '') ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
const digits = (p) => String(p ?? '').replace(/\D/g, '').slice(-10);
const e164 = (p) => (digits(p).length === 10 ? `+1${digits(p)}` : null);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const L = await tool('harvest__license_leads', { trade, offset: Number(offsetArg), limit: Number(limitArg) });
if (L.error) { log('license_leads error:', L.error); process.exit(1); }
log(`${trade}: ${L.total} DFW licensees, checking ${L.results.length} from offset ${offsetArg}${DRY ? ' (dry run)' : ''}`);

const tally = { already_in_table: 0, maps_has_site: 0, web_has_site: 0, saved: 0, not_saved_dupe: 0, errors: 0 };
let stopped = null;
for (const r of L.results) {
  const tag = r.business_name.slice(0, 36).padEnd(36);
  const phone164 = e164(r.phone);
  if (phone164 && (await sql(`select 1 from ${TABLE} where phone_e164 = ${lit(phone164)} limit 1`)).length) {
    tally.already_in_table++; log(`${tag} skip  phone already in table`); continue;
  }
  const m = await tool('harvest__maps_lookup', { name: r.business_name, city: r.city ?? '', phone: r.phone ?? '', ...(r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : {}) });
  if (m.error) {
    tally.errors++; log(`${tag} maps_lookup error ${m.error}`);
    if (STOP.has(m.error)) { stopped = m.error; break; }
    continue;
  }
  const li = m.found ? m.listing : null;
  if (li?.has_website) { tally.maps_has_site++; log(`${tag} skip  on Maps with website`); continue; }
  const w = await tool('harvest__web_presence', { name: r.business_name, city: r.city ?? '', phone: r.phone ?? '' });
  if (w.error) {
    tally.errors++; log(`${tag} web_presence error ${w.error}`);
    if (STOP.has(w.error)) { stopped = w.error; break; }
    continue;
  }
  if (w.verdict === 'likely_has_website') { tally.web_has_site++; log(`${tag} skip  has site ${w.candidate_websites?.[0]?.url}`); continue; }

  const phone = li?.phone ?? r.phone;
  const reviews = li?.review_count ?? null;
  const name = li?.name ?? r.business_name;
  const reasons = [
    li ? null : 'not_on_maps',                     // weaker lead: may trade under another name
    reviews === 0 ? 'zero_reviews' : null,
    w.verdict === 'unknown' || w.search_blocked ? 'website_check_pending' : null,
  ].filter(Boolean).join(',');
  const row = {
    source_id: li?.maps_cid ?? `${src}:${r.license_number}`, name, name_norm: name.toLowerCase(),
    phone, phone_e164: e164(phone), category: li?.category_label ?? category,
    address: li?.address_line ?? r.address, city: r.city, zip: r.zip,
    rating: li?.rating ?? null, review_count: reviews, google_maps_url: li?.maps_url ?? null,
    found_on: `license:${src}`, website_class: w.facebook || w.instagram ? 'social_only' : 'none',
    social_or_notes: [w.facebook, w.instagram, ...(w.emails ?? []), r.owner_name ? `owner: ${r.owner_name}` : null, `licence ${r.license_number}`].filter(Boolean).join('; '),
    review_reason: reasons || null, selector_version: w.selector_version,
  };
  if (DRY) { tally.saved++; log(`${tag} KEEP  (dry run) ${reasons || 'on Maps, no website'}`); continue; }
  const cols = Object.keys(row);
  const ins = await sql(`insert into ${TABLE} (${cols.join(',')}) values (${cols.map((k) => lit(row[k])).join(',')}) on conflict (source_id) do nothing returning source_id`);
  if (ins.length) { tally.saved++; log(`${tag} SAVED ${row.source_id} ${reasons || 'on Maps, no website'}`); }
  else { tally.not_saved_dupe++; log(`${tag} skip  source_id ${row.source_id} already saved`); }
}

const s = await tool('harvest__harvest_status', {});
log('done', JSON.stringify(tally), stopped ? `STOPPED: ${stopped}` : '', `| next offset ${Number(offsetArg) + L.results.length}`,
  `| harvest calls ${s.calls}/${s.max_calls}, cooldown ${s.challenge_cooldown_remaining_s}s`);
await c.close();
if (stopped) process.exit(3);
