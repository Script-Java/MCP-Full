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

## Layout

| Path | Contents |
| --- | --- |
| `gateway/` | Node gateway: HTTP server, session handling, upstream supervisor |
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
