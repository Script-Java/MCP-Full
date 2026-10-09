# syntax=docker/dockerfile:1
#
# mcp-full: one container running the MCP gateway plus every upstream MCP server
# it supervises (see gateway/src/servers.js for the catalog).
#
# Reconstructed on 2026-10-09 from the running Railway deployment, because the
# original Dockerfile was never committed and is not stored in the image. Every
# version below is copied from that container except GITHUB_MCP_VERSION: the
# deployed binary was built from source without version metadata.

# ---- github/github-mcp-server (Go, built from source) ------------------------
FROM golang:1.27-bookworm AS github-mcp
ARG GITHUB_MCP_VERSION=v1.14.0
RUN git clone --depth 1 --branch "${GITHUB_MCP_VERSION}" https://github.com/github/github-mcp-server.git /src
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=mcp-full" \
      -o /out/github-mcp-server ./cmd/github-mcp-server

# ---- runtime -----------------------------------------------------------------
FROM node:22.23.3-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gosu tini python3 python3-venv xvfb \
 && rm -rf /var/lib/apt/lists/*

ENV MCP_ROOT=/app \
    MCP_PYBIN=/opt/pyenv/bin \
    MCP_DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    LOG_LEVEL=info \
    PORT=8080

# ---- Python servers: three venvs because their `mcp` pins conflict -----------
# /opt/pyenv      fetch, git, time (modelcontextprotocol/servers, mcp<2)
# /opt/ddgenv     duckduckgo-mcp-server (mcp>=2)
# /opt/harvestenv harvest/ (Camoufox + mcp 2.2)
COPY docker/requirements-pyenv.txt docker/requirements-ddgenv.txt docker/requirements-harvestenv.txt /tmp/req/
COPY vendor/servers/src/fetch /opt/src/fetch
COPY vendor/servers/src/git /opt/src/git
COPY vendor/servers/src/time /opt/src/time
RUN python3 -m venv /opt/pyenv \
 && /opt/pyenv/bin/pip install --no-cache-dir -r /tmp/req/requirements-pyenv.txt \
 && /opt/pyenv/bin/pip install --no-cache-dir --no-deps /opt/src/fetch /opt/src/git /opt/src/time \
 && python3 -m venv /opt/ddgenv \
 && /opt/ddgenv/bin/pip install --no-cache-dir -r /tmp/req/requirements-ddgenv.txt \
 && python3 -m venv /opt/harvestenv \
 && /opt/harvestenv/bin/pip install --no-cache-dir -r /tmp/req/requirements-harvestenv.txt \
 && /opt/harvestenv/bin/python -m playwright install-deps firefox \
 && XDG_CACHE_HOME=/opt/camoufox-cache /opt/harvestenv/bin/python -m camoufox fetch \
 && chmod -R a+rX /opt/camoufox-cache \
 && rm -rf /tmp/req

WORKDIR /app

# ---- modelcontextprotocol/servers (TypeScript: filesystem, memory, ...) ------
COPY vendor/servers /app/servers
RUN cd /app/servers && npm ci --no-audit --no-fund && npm run build

# ---- microsoft/playwright-mcp + Chromium -------------------------------------
COPY vendor/playwright/package-lock.json /tmp/playwright-lock.json
RUN cd /tmp && npm pack @playwright/mcp@0.0.80 --silent \
 && mkdir -p /app/playwright \
 && tar -xzf /tmp/playwright-mcp-0.0.80.tgz -C /app/playwright --strip-components=1 \
 && cp /tmp/playwright-lock.json /app/playwright/package-lock.json \
 && cd /app/playwright && npm install --omit=dev --no-audit --no-fund \
 && node node_modules/playwright/cli.js install --with-deps chromium \
 && rm -f /tmp/playwright-mcp-0.0.80.tgz /tmp/playwright-lock.json

# ---- supabase/mcp ------------------------------------------------------------
RUN cd /tmp && npm pack @supabase/mcp-server-supabase@0.12.0 --silent \
 && mkdir -p /app/supabase \
 && tar -xzf /tmp/supabase-mcp-server-supabase-0.12.0.tgz -C /app/supabase --strip-components=1 \
 && cd /app/supabase && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -f /tmp/supabase-mcp-server-supabase-0.12.0.tgz

# ---- gateway + harvest -------------------------------------------------------
COPY gateway/package.json gateway/package-lock.json /app/gateway/
RUN cd /app/gateway && npm ci --omit=dev --no-audit --no-fund
COPY gateway /app/gateway
COPY harvest /app/harvest
COPY entrypoint.sh /app/entrypoint.sh
COPY --from=github-mcp /out/github-mcp-server /app/bin/github-mcp-server

RUN chmod +x /app/entrypoint.sh \
 && mkdir -p /data \
 && chown -R node:node /app /data

WORKDIR /app/gateway
EXPOSE 8080

# Starts as root so entrypoint.sh can fix ownership of the Railway volume, then
# drops to the `node` user via gosu.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["node", "/app/gateway/src/index.js"]
