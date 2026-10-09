# mcp-full

A single deployment that runs many MCP servers behind one authenticated
Streamable HTTP gateway. Deployed on Railway as the `mcp-full` project
(`https://mcp-full-production-25f2.up.railway.app`).

## Endpoints

All MCP endpoints require `Authorization: Bearer <MCP_GATEWAY_TOKEN>`.

| Path | What |
| --- | --- |
| `/mcp` | Aggregate server: every upstream's tools, prefixed `<server>__<tool>` |
| `/<server>/mcp` | One upstream on its own |
| `/health`, `/healthz` | Status of each upstream (no auth) |
| `/` | JSON index of the endpoints above |

Upstreams (see `gateway/src/servers.js`): supabase, github, playwright,
filesystem, memory, sequentialthinking, fetch, git, duckduckgo, harvest, time,
plus the optional `everything` test server.

## Server-side Maps harvest (tile runs)

`gateway__start_tile_run {max_searches}` runs the Google Maps harvest from
`docs/harvester-reference.mjs` inside the gateway with no agent: towns from
`harvest_towns` x 24 categories, resumed from `search_log` (unfinished
sub-areas first), `harvest_tile` at 13z: the town point, or a 13z grid over the
town's boundary (Nominatim) for towns bigger than one search. An area with 115+
cards is split into its four `subdivide_tile` children, again down to
`TILE_RUN_MAX_ZOOM` (default 15); `sub_area` names the path (`center`, `NW`,
`NW-NE`, `g3`, `g3-SW`). New no-website leads go into
`"no-Website-lead"`, one `harvest_runs` row per run (`runner = 'server'`).
`gateway__tile_run_status` reports progress; logs go to `/data/tile-runs/`.
`dry_run: true` searches and counts but writes nothing to the database.
Set `TILE_RUN_CRON` (America/Chicago) to run it on a schedule. Tables:
`docs/migrations.sql`.

The harvest server allows `HARVEST_MAX_CALLS` (500) Maps calls per rolling
`HARVEST_BUDGET_WINDOW_S` (24 h); its circuit breaker (5 empty harvests in a
row) closes again after `HARVEST_CIRCUIT_RESET_S` (2 h). Google's own "no
results" page doesn't count as empty, and an empty feed that still has place
links is reported as `selectors_stale`.

Every 5 minutes the gateway copies the `active_selectors` row to
`/data/harvest/active-selectors.json`; the harvest server applies it over its
built-in selectors (`website_btn` maps to `card_website`, `rating` is ignored)
and falls back to the built-ins if it is missing or invalid. If the table
can't be read, the gateway removes the copy, so the built-ins apply.

## Tests

```sh
node gateway/scripts/local-tools-check.mjs
node gateway/scripts/tile-run-check.mjs
python harvest/test_presence.py && python harvest/test_selectors.py && python harvest/test_guard.py && python harvest/test_licenses.py
```

## Layout

| Path | Contents |
| --- | --- |
| `gateway/` | Node gateway: HTTP server, session handling, upstream supervisor, tile runs |
| `docs/` | Reference harvester and Supabase migrations (not deployed) |
| `harvest/` | Python MCP server for lead harvesting (Camoufox, licence rosters, Google Maps) |
| `entrypoint.sh` | Fixes `/data` volume ownership, then drops to the `node` user |
| `Dockerfile` | Builds the whole image |
| `docker/requirements-*.txt` | Exact pins for the three Python virtualenvs |
| `vendor/servers/` | Snapshot of `modelcontextprotocol/servers` that the image builds from |
| `vendor/playwright/`, `vendor/supabase/` | Pinned manifests for `@playwright/mcp@0.0.80` and `@supabase/mcp-server-supabase@0.12.0` |

## Run locally

```sh
docker build -t mcp-full .
docker run --rm -p 8080:8080 --env-file .env -v mcp-data:/data mcp-full
curl http://localhost:8080/health
node gateway/scripts/smoke.mjs http://localhost:8080 "$MCP_GATEWAY_TOKEN"
```

Copy `.env.example` to `.env` and fill in the tokens first.

## Deploy

```sh
railway link --project mcp-full
railway up -m "describe the change"
```

Railway mounts a volume at `/data` (memory graph, filesystem root, Playwright
output, lead runs).

## Recovery note

This repository was recovered on 2026-10-09 from the running Railway container,
because the code had never been pushed anywhere. `gateway/`, `harvest/` and
`entrypoint.sh` are byte-for-byte copies of what was deployed. The original
`Dockerfile` was not in the image, so the one here was rebuilt from what the
container holds (base image, packages, venv pins, file layout). It has not yet
been built and tested. The one guess is the GitHub MCP server version
(`GITHUB_MCP_VERSION`, set to v1.14.0), because the deployed binary carries no
version information.
