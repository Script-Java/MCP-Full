// Supervises one upstream MCP server running over stdio.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_CALL_TIMEOUT_MS = 5 * 60 * 1000;
const RECONNECT_BACKOFF_MS = [1000, 3000, 10000, 30000];

export class Upstream {
  /** @param {import('./servers.js').UpstreamDef} def */
  constructor(def, log) {
    this.def = def;
    this.name = def.name;
    this.log = log;
    this.client = null;
    this.transport = null;
    this.connecting = null;
    this.failures = 0;
    this.lastAttempt = 0;
    this.lastError = null;
    this.connectedAt = null;
    this.serverInfo = null;
    this.capabilities = null;
    this.cache = { tools: null, resources: null, resourceTemplates: null, prompts: null };
    this.listeners = new Set();
  }

  get status() {
    return this.client ? 'up' : this.connecting ? 'connecting' : 'down';
  }

  onListChanged(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emitListChanged(kind) {
    for (const fn of this.listeners) {
      try {
        fn(this, kind);
      } catch (e) {
        this.log.warn(`[${this.name}] listener error: ${e?.message ?? e}`);
      }
    }
  }

  async connect() {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async doConnect() {
    const { def } = this;
    this.log.info(`[${this.name}] starting: ${def.command} ${def.args.join(' ')}`);
    const transport = new StdioClientTransport({
      command: def.command,
      args: def.args,
      env: { ...getDefaultEnvironment(), ...def.env },
      ...(def.cwd ? { cwd: def.cwd } : {}),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'mcp-full-gateway', version: '1.0.0' }, { capabilities: {} });

    transport.onclose = () => {
      if (this.transport !== transport) return;
      this.log.warn(`[${this.name}] process exited`);
      this.client = null;
      this.transport = null;
      this.connectedAt = null;
      this.cache = { tools: null, resources: null, resourceTemplates: null, prompts: null };
      this.emitListChanged('all');
    };
    transport.onerror = (err) => {
      this.lastError = err?.message ?? String(err);
    };

    try {
      await client.connect(transport);
    } catch (err) {
      this.failures += 1;
      this.lastError = err?.message ?? String(err);
      this.log.error(`[${this.name}] failed to start: ${this.lastError}`);
      try {
        await transport.close();
      } catch {}
      throw err;
    }

    if (transport.stderr) {
      transport.stderr.on('data', (chunk) => {
        const text = chunk.toString().trimEnd();
        if (text) this.log.debug(`[${this.name}] ${text}`);
      });
    }

    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.cache.tools = null;
      this.emitListChanged('tools');
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      this.cache.resources = null;
      this.cache.resourceTemplates = null;
      this.emitListChanged('resources');
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
      this.cache.prompts = null;
      this.emitListChanged('prompts');
    });

    this.client = client;
    this.transport = transport;
    this.failures = 0;
    this.lastError = null;
    this.connectedAt = new Date();
    this.serverInfo = client.getServerVersion() ?? null;
    this.capabilities = client.getServerCapabilities() ?? {};
    const label = `${this.serverInfo?.name ?? '?'} ${this.serverInfo?.version ?? ''}`.trim();
    this.log.info(`[${this.name}] connected (${label})`);
    this.emitListChanged('all');
    return client;
  }

  /** Reconnect with backoff; used when a call finds the upstream down. */
  async ensure() {
    if (this.client) return this.client;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.failures, RECONNECT_BACKOFF_MS.length - 1)];
    if (this.failures > 0 && Date.now() - this.lastAttempt < delay) {
      throw new Error(`${this.name} is down (${this.lastError ?? 'not started'}); retry in ${delay}ms`);
    }
    this.lastAttempt = Date.now();
    return this.connect();
  }

  has(capability) {
    return Boolean(this.capabilities?.[capability]);
  }

  async listTools() {
    if (this.cache.tools) return this.cache.tools;
    const client = await this.ensure();
    if (!this.has('tools')) return (this.cache.tools = []);
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return (this.cache.tools = tools);
  }

  async callTool(name, args, extra = {}) {
    const client = await this.ensure();
    const timeout = this.def.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    return client.callTool({ name, arguments: args ?? {}, _meta: extra._meta }, undefined, {
      timeout,
      resetTimeoutOnProgress: true,
    });
  }

  async listResources() {
    if (this.cache.resources) return this.cache.resources;
    const client = await this.ensure();
    if (!this.has('resources')) return (this.cache.resources = []);
    const out = [];
    let cursor;
    do {
      const page = await client.listResources(cursor ? { cursor } : undefined);
      out.push(...page.resources);
      cursor = page.nextCursor;
    } while (cursor);
    return (this.cache.resources = out);
  }

  async listResourceTemplates() {
    if (this.cache.resourceTemplates) return this.cache.resourceTemplates;
    const client = await this.ensure();
    if (!this.has('resources')) return (this.cache.resourceTemplates = []);
    const out = [];
    let cursor;
    do {
      const page = await client.listResourceTemplates(cursor ? { cursor } : undefined);
      out.push(...page.resourceTemplates);
      cursor = page.nextCursor;
    } while (cursor);
    return (this.cache.resourceTemplates = out);
  }

  async readResource(uri) {
    const client = await this.ensure();
    return client.readResource({ uri });
  }

  async listPrompts() {
    if (this.cache.prompts) return this.cache.prompts;
    const client = await this.ensure();
    if (!this.has('prompts')) return (this.cache.prompts = []);
    const out = [];
    let cursor;
    do {
      const page = await client.listPrompts(cursor ? { cursor } : undefined);
      out.push(...page.prompts);
      cursor = page.nextCursor;
    } while (cursor);
    return (this.cache.prompts = out);
  }

  async getPrompt(name, args) {
    const client = await this.ensure();
    return client.getPrompt({ name, arguments: args ?? {} });
  }

  async close() {
    const t = this.transport;
    this.transport = null;
    this.client = null;
    if (t) {
      try {
        await t.close();
      } catch {}
    }
  }

  health() {
    return {
      name: this.name,
      description: this.def.description,
      status: this.status,
      server: this.serverInfo,
      connectedAt: this.connectedAt?.toISOString() ?? null,
      lastError: this.lastError,
      toolCount: this.cache.tools?.length ?? null,
    };
  }
}
