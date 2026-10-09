// Builds an MCP `Server` that fronts one or more upstreams.
// In aggregate mode every tool/prompt is namespaced `<upstream>__<name>`.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ASYNC_AFTER_MS, JOB_TOOL, RUN_STATUS_TOOL, START_RUN_TOOL,
  jobResult, leadRunStatus, startLeadRun, withEarlyReturn,
} from './local-tools.js';

const SEP = '__';
// Cap on the text a single tool result may carry back to the client. Page
// snapshots (Playwright) can run to hundreds of KB, which some hosts can't take.
const MAX_RESULT_CHARS = Number(process.env.MCP_MAX_RESULT_CHARS || 120000);

function capResult(result) {
  if (!MAX_RESULT_CHARS || !result || !Array.isArray(result.content)) return result;
  let budget = MAX_RESULT_CHARS;
  let omitted = 0;
  const content = [];
  for (const item of result.content) {
    if (item?.type !== 'text' || typeof item.text !== 'string') {
      content.push(item);
      continue;
    }
    if (item.text.length <= budget) {
      budget -= item.text.length;
      content.push(item);
    } else {
      omitted += item.text.length - Math.max(budget, 0);
      if (budget > 0) content.push({ ...item, text: item.text.slice(0, budget) });
      budget = 0;
    }
  }
  if (!omitted) return result;
  content.push({
    type: 'text',
    text: `\n[mcp-full: result truncated, ${omitted} characters omitted (limit ${MAX_RESULT_CHARS}; set MCP_MAX_RESULT_CHARS to change)]`,
  });
  // structuredContent would carry the full untruncated payload; drop it so the cap holds.
  const { structuredContent: _dropped, ...rest } = result;
  return { ...rest, content };
}

/**
 * @param {import('./upstream.js').Upstream[]} upstreams
 * @param {{ aggregate: boolean, name: string, version: string, log: any }} opts
 */
export function createDownstreamServer(upstreams, opts) {
  const { aggregate, log } = opts;
  const server = new Server(
    { name: opts.name, version: opts.version },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
      instructions: buildInstructions(upstreams, aggregate),
    }
  );

  const qualify = (up, name) => (aggregate ? `${up.name}${SEP}${name}` : name);

  // Gateway-native tools: job_result everywhere; lead runs on /mcp and /harvest/mcp.
  const LOCAL = 'gateway';
  const localName = (name) => (aggregate ? `${LOCAL}${SEP}${name}` : name);
  const local = new Map([[JOB_TOOL.name, [JOB_TOOL, jobResult]]]);
  if (aggregate || upstreams[0]?.name === 'harvest') {
    local.set(START_RUN_TOOL.name, [START_RUN_TOOL, startLeadRun]);
    local.set(RUN_STATUS_TOOL.name, [RUN_STATUS_TOOL, leadRunStatus]);
  }
  const localTool = (qualified) => {
    if (!aggregate) return local.get(qualified);
    const prefix = `${LOCAL}${SEP}`;
    return qualified.startsWith(prefix) ? local.get(qualified.slice(prefix.length)) : undefined;
  };

  /** Resolve a (possibly namespaced) name to [upstream, localName]. */
  const resolve = (qualified) => {
    if (aggregate) {
      const i = qualified.indexOf(SEP);
      if (i > 0) {
        const prefix = qualified.slice(0, i);
        const up = upstreams.find((u) => u.name === prefix);
        if (up) return [up, qualified.slice(i + SEP.length)];
      }
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool/prompt "${qualified}" (expected <server>${SEP}<name>)`
      );
    }
    return [upstreams[0], qualified];
  };

  /** Run fn for every upstream, tolerating individual failures. */
  const each = async (fn) => {
    const results = await Promise.allSettled(upstreams.map((up) => fn(up)));
    const out = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') out.push(...r.value);
      else log.warn(`[${upstreams[i].name}] ${r.reason?.message ?? r.reason}`);
    });
    return out;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...(await each(async (up) =>
        (await up.listTools()).map((t) => ({
          ...t,
          name: qualify(up, t.name),
          ...(aggregate ? { description: `[${up.name}] ${t.description ?? ''}`.trim() } : {}),
        }))
      )),
      ...[...local.values()].map(([t]) => ({
        ...t,
        name: localName(t.name),
        ...(aggregate ? { description: `[${LOCAL}] ${t.description}` } : {}),
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const lt = localTool(req.params.name);
    if (lt) {
      try {
        return capResult(await lt[1](req.params.arguments ?? {}));
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `gateway: ${err?.message ?? String(err)}` }] };
      }
    }
    const [up, name] = resolve(req.params.name);
    // Always resolves: errors become isError results, so a parked job can hold them too.
    const call = up
      .callTool(name, req.params.arguments, { _meta: req.params._meta })
      .then(capResult, (err) => ({
        isError: true,
        content: [{ type: 'text', text: `${up.name}: ${err?.message ?? String(err)}` }],
      }));
    // Callers that can wait (our own scripts) send `X-MCP-Async: off`.
    const off = /^(0|off|false|no)$/i.test(String(extra?.requestInfo?.headers?.['x-mcp-async'] ?? ''));
    return withEarlyReturn(call, req.params.name, localName(JOB_TOOL.name), off);
  });

  // Resources: keep URIs untouched and remember which upstream owns each.
  const resourceOwner = new Map();
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: await each(async (up) =>
      (await up.listResources()).map((r) => {
        resourceOwner.set(r.uri, up);
        return aggregate ? { ...r, name: qualify(up, r.name) } : r;
      })
    ),
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: await each(async (up) =>
      (await up.listResourceTemplates()).map((r) => (aggregate ? { ...r, name: qualify(up, r.name) } : r))
    ),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const { uri } = req.params;
    const owner = resourceOwner.get(uri);
    if (owner) return owner.readResource(uri);
    // Unknown URI (e.g. from a template): try upstreams that expose resources.
    let lastErr;
    for (const up of upstreams) {
      if (up.status !== 'up' || !up.has('resources')) continue;
      try {
        const res = await up.readResource(uri);
        resourceOwner.set(uri, up);
        return res;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr instanceof McpError) throw lastErr;
    throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: await each(async (up) =>
      (await up.listPrompts()).map((p) => ({ ...p, name: qualify(up, p.name) }))
    ),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const [up, name] = resolve(req.params.name);
    return up.getPrompt(name, req.params.arguments);
  });

  // Forward upstream list_changed notifications to this session.
  const unsubscribe = upstreams.map((up) =>
    up.onListChanged((_, kind) => {
      const send = (fn) => fn.call(server).catch(() => {});
      if (kind === 'tools' || kind === 'all') send(server.sendToolListChanged);
      if (kind === 'resources' || kind === 'all') send(server.sendResourceListChanged);
      if (kind === 'prompts' || kind === 'all') send(server.sendPromptListChanged);
    })
  );
  server.onclose = () => unsubscribe.forEach((fn) => fn());

  return server;
}

function buildInstructions(upstreams, aggregate) {
  const lines = [];
  if (aggregate) {
    lines.push(
      'This endpoint aggregates several MCP servers. Tool and prompt names are namespaced as <server>__<name>.',
      'Bundled servers:'
    );
  } else {
    lines.push('Bundled server:');
  }
  for (const up of upstreams) lines.push(`- ${up.name}: ${up.def.description}`);
  if (ASYNC_AFTER_MS) {
    const jr = aggregate ? `gateway${SEP}job_result` : 'job_result';
    lines.push(
      `Slow tool calls: a call still running after ${ASYNC_AFTER_MS / 1000}s returns {"pending": true, "job_id": ...}. ` +
        `Call ${jr} with that job_id to get the real result (repeat while pending). Don't re-run the original call.`
    );
  }
  return lines.join('\n');
}
