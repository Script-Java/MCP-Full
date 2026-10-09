// Checks a maps-harvest HTTP endpoint: auth, Host allowlist, tool calls.
//   node scripts/harvest-check.mjs <url> <token> [<business name> <city>]
// With a name/city it also runs one live web_presence search.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, token, name, city] = process.argv.slice(2);
const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
const probe = async (headers) =>
  (await fetch(url, { method: 'POST', body: init, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } })).status;

console.log('no token:', await probe({}));
console.log('wrong token:', await probe({ authorization: 'Bearer nope' }));
console.log('right token:', await probe({ authorization: `Bearer ${token}` }));

const c = new Client({ name: 'harvest-check', version: '0' });
await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}`, "X-MCP-Async": "off" } } }));
console.log('tools:', (await c.listTools()).tools.map((t) => t.name).join(', '));
const grid = await c.callTool({ name: 'grid_tiles', arguments: { south: 32.9, west: -97.0, north: 33.0, east: -96.9, zoom: 13 } });
console.log('grid_tiles:', grid.content[0].text.slice(0, 100));
if (name) {
  const t0 = Date.now();
  const r = await c.callTool({ name: 'web_presence', arguments: { name, city: city ?? '' } }, undefined, { timeout: 120000 });
  console.log(`web_presence (${Date.now() - t0}ms):`, r.content[0].text);
}
await c.close();
