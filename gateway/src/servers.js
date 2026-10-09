// Catalog of upstream MCP servers bundled into this deployment.
// Every server runs as a stdio subprocess supervised by the gateway.

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const list = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Build the list of upstream server definitions from the environment.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ servers: Array<UpstreamDef>, skipped: Array<{name:string, reason:string}> }}
 */
export function buildServerCatalog(env = process.env) {
  const root = env.MCP_ROOT || '/app';
  const pybin = env.MCP_PYBIN || '/opt/pyenv/bin';
  const dataDir = env.MCP_DATA_DIR || '/data';
  const disabled = new Set(list(env.MCP_DISABLED_SERVERS));

  /** @type {Array<UpstreamDef>} */
  const servers = [];
  /** @type {Array<{name:string, reason:string}>} */
  const skipped = [];

  const add = (def) => {
    if (disabled.has(def.name)) {
      skipped.push({ name: def.name, reason: 'disabled via MCP_DISABLED_SERVERS' });
      return;
    }
    servers.push(def);
  };

  // ---- supabase/mcp -------------------------------------------------------
  if (env.SUPABASE_ACCESS_TOKEN) {
    const args = [`${root}/supabase/dist/cli.js`];
    if (env.SUPABASE_PROJECT_REF) args.push('--project-ref', env.SUPABASE_PROJECT_REF);
    if (truthy(env.SUPABASE_READ_ONLY)) args.push('--read-only');
    if (env.SUPABASE_FEATURES) args.push('--features', env.SUPABASE_FEATURES);
    if (env.SUPABASE_API_URL) args.push('--api-url', env.SUPABASE_API_URL);
    add({
      name: 'supabase',
      description: 'Supabase MCP server (supabase/mcp)',
      command: process.execPath,
      args,
      env: {
        SUPABASE_ACCESS_TOKEN: env.SUPABASE_ACCESS_TOKEN,
        ...(env.SUPABASE_CONTENT_API_URL ? { SUPABASE_CONTENT_API_URL: env.SUPABASE_CONTENT_API_URL } : {}),
      },
    });
  } else {
    skipped.push({ name: 'supabase', reason: 'SUPABASE_ACCESS_TOKEN not set' });
  }

  // ---- github/github-mcp-server -------------------------------------------
  if (env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    const args = ['stdio'];
    if (env.GITHUB_TOOLSETS) args.push('--toolsets', env.GITHUB_TOOLSETS);
    if (env.GITHUB_TOOLS) args.push('--tools', env.GITHUB_TOOLS);
    if (truthy(env.GITHUB_READ_ONLY)) args.push('--read-only');
    if (truthy(env.GITHUB_LOCKDOWN_MODE)) args.push('--lockdown-mode');
    if (env.GITHUB_HOST) args.push('--gh-host', env.GITHUB_HOST);
    add({
      name: 'github',
      description: 'GitHub MCP server (github/github-mcp-server)',
      command: env.GITHUB_MCP_BIN || `${root}/bin/github-mcp-server`,
      args,
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: env.GITHUB_PERSONAL_ACCESS_TOKEN },
    });
  } else {
    skipped.push({ name: 'github', reason: 'GITHUB_PERSONAL_ACCESS_TOKEN not set' });
  }

  // ---- microsoft/playwright-mcp ------------------------------------------
  {
    const args = [
      `${root}/playwright/cli.js`,
      '--headless',
      '--browser',
      env.PLAYWRIGHT_BROWSER || 'chromium',
      '--no-sandbox',
      '--isolated',
      '--output-dir',
      env.PLAYWRIGHT_OUTPUT_DIR || `${dataDir}/playwright-output`,
    ];
    if (env.PLAYWRIGHT_CAPS) args.push('--caps', env.PLAYWRIGHT_CAPS);
    if (env.PLAYWRIGHT_SNAPSHOT_MODE) args.push('--snapshot-mode', env.PLAYWRIGHT_SNAPSHOT_MODE); // full | none
    if (env.PLAYWRIGHT_VIEWPORT_SIZE) args.push('--viewport-size', env.PLAYWRIGHT_VIEWPORT_SIZE);
    if (env.PLAYWRIGHT_ALLOWED_ORIGINS) args.push('--allowed-origins', env.PLAYWRIGHT_ALLOWED_ORIGINS);
    if (env.PLAYWRIGHT_BLOCKED_ORIGINS) args.push('--blocked-origins', env.PLAYWRIGHT_BLOCKED_ORIGINS);
    if (truthy(env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS)) args.push('--ignore-https-errors');
    add({
      name: 'playwright',
      description: 'Playwright browser automation (microsoft/playwright-mcp)',
      command: process.execPath,
      args,
      env: {
        ...(env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH } : {}),
        // Railway's egress is a datacenter IP that Google blocks; a residential proxy fixes that.
        // Via env, not argv, so proxy credentials don't show up in `ps`.
        ...(env.PLAYWRIGHT_PROXY_SERVER ? { PLAYWRIGHT_MCP_PROXY_SERVER: env.PLAYWRIGHT_PROXY_SERVER } : {}),
        ...(env.PLAYWRIGHT_PROXY_BYPASS ? { PLAYWRIGHT_MCP_PROXY_BYPASS: env.PLAYWRIGHT_PROXY_BYPASS } : {}),
      },
      callTimeoutMs: 10 * 60 * 1000,
    });
  }

  // ---- modelcontextprotocol/servers (TypeScript) -------------------------
  const servDir = `${root}/servers/src`;

  add({
    name: 'filesystem',
    description: 'Filesystem access (modelcontextprotocol/servers)',
    command: process.execPath,
    args: [`${servDir}/filesystem/dist/index.js`, ...(list(env.FILESYSTEM_ROOTS).length ? list(env.FILESYSTEM_ROOTS) : [`${dataDir}/files`])],
    env: {},
  });

  add({
    name: 'memory',
    description: 'Knowledge-graph memory (modelcontextprotocol/servers)',
    command: process.execPath,
    args: [`${servDir}/memory/dist/index.js`],
    env: { MEMORY_FILE_PATH: env.MEMORY_FILE_PATH || `${dataDir}/memory.jsonl` },
  });

  add({
    name: 'sequentialthinking',
    description: 'Sequential thinking (modelcontextprotocol/servers)',
    command: process.execPath,
    args: [`${servDir}/sequentialthinking/dist/index.js`],
    env: {},
  });

  if (truthy(env.MCP_ENABLE_EVERYTHING)) {
    add({
      name: 'everything',
      description: 'Reference/test server exercising every MCP feature (modelcontextprotocol/servers)',
      command: process.execPath,
      args: [`${servDir}/everything/dist/index.js`, 'stdio'],
      env: {},
    });
  } else {
    skipped.push({ name: 'everything', reason: 'test server; set MCP_ENABLE_EVERYTHING=1 to enable' });
  }

  // ---- modelcontextprotocol/servers (Python) -----------------------------
  add({
    name: 'fetch',
    description: 'Web fetch → markdown (modelcontextprotocol/servers)',
    command: `${pybin}/mcp-server-fetch`,
    args: [
      ...(truthy(env.FETCH_IGNORE_ROBOTS_TXT) ? ['--ignore-robots-txt'] : []),
      ...(env.FETCH_USER_AGENT ? ['--user-agent', env.FETCH_USER_AGENT] : []),
      ...(env.FETCH_PROXY_URL ? ['--proxy-url', env.FETCH_PROXY_URL] : []),
    ],
    env: {},
  });

  add({
    name: 'git',
    description: 'Git repository tools (modelcontextprotocol/servers)',
    command: `${pybin}/mcp-server-git`,
    args: env.GIT_REPOSITORY ? ['--repository', env.GIT_REPOSITORY] : [],
    env: {},
  });

  // ---- nickclyde/duckduckgo-mcp-server (free, no API key) ------------------
  // Own venv: it needs mcp>=2, the servers above pin mcp<2.
  add({
    name: 'duckduckgo',
    description: 'DuckDuckGo web search + page fetch (nickclyde/duckduckgo-mcp-server)',
    command: env.MCP_DDG_BIN || '/opt/ddgenv/bin/duckduckgo-mcp-server',
    args: ['--transport', 'stdio'],
    env: {},
  });

  // ---- harvest/ (maps-harvest: Camoufox, licence rosters, web checks) ------
  // Maps tools worked from Railway's IP when tested (Camoufox); if Google starts
  // answering challenge_detected, set HARVEST_PROXY (residential proxy).
  add({
    name: 'harvest',
    description: 'Lead harvesting: Texas licence rosters, website checks, stealth browsing, Google Maps (harvest/, Camoufox)',
    command: env.MCP_HARVEST_PYTHON || '/opt/harvestenv/bin/python',
    args: [`${root}/harvest/server.py`],
    env: {
      HARVEST_HEADLESS: '1',
      // Written by the gateway from the active_selectors table (src/tile-run.js).
      HARVEST_SELECTORS_FILE: `${dataDir}/harvest/active-selectors.json`,
      XDG_CACHE_HOME: env.MCP_CAMOUFOX_CACHE || '/opt/camoufox-cache',
      ...(env.HARVEST_PROXY ? { HARVEST_PROXY: env.HARVEST_PROXY } : {}),
      ...(env.HARVEST_MAX_CALLS ? { HARVEST_MAX_CALLS: env.HARVEST_MAX_CALLS } : {}),
      ...(env.HARVEST_BUDGET_WINDOW_S ? { HARVEST_BUDGET_WINDOW_S: env.HARVEST_BUDGET_WINDOW_S } : {}),
      ...(env.HARVEST_CIRCUIT_RESET_S ? { HARVEST_CIRCUIT_RESET_S: env.HARVEST_CIRCUIT_RESET_S } : {}),
    },
    callTimeoutMs: 3 * 60 * 1000,
  });

  add({
    name: 'time',
    description: 'Time & timezone conversion (modelcontextprotocol/servers)',
    command: `${pybin}/mcp-server-time`,
    args: env.TZ ? ['--local-timezone', env.TZ] : [],
    env: {},
  });

  return { servers, skipped };
}

/**
 * @typedef {object} UpstreamDef
 * @property {string} name          Unique short name; used as tool prefix and URL path segment.
 * @property {string} description
 * @property {string} command
 * @property {string[]} args
 * @property {Record<string,string>} env
 * @property {number} [callTimeoutMs]
 */
