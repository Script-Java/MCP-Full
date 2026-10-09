// Offline self-check for src/local-tools.js: node scripts/local-tools-check.mjs
process.env.MCP_ASYNC_AFTER_MS = '200';
const { withEarlyReturn, jobResult, summariseLog } = await import('../src/local-tools.js');
import assert from 'node:assert/strict';

const done = (ms, text) => new Promise((r) => setTimeout(() => r({ content: [{ type: 'text', text }] }), ms));
// Fast call: real result straight through.
assert.equal((await withEarlyReturn(done(50, 'fast'), 't', 'job_result', false)).content[0].text, 'fast');
// Slow call: pending + job_id, then job_result delivers the real result.
const p = JSON.parse((await withEarlyReturn(done(600, 'slow'), 'harvest__maps_lookup', 'job_result', false)).content[0].text);
assert.equal(p.pending, true);
const still = JSON.parse((await jobResult({ job_id: p.job_id, wait_s: 0 })).content[0].text);
assert.equal(still.pending, true);
assert.equal((await jobResult({ job_id: p.job_id })).content[0].text, 'slow');
assert.equal((await jobResult({ job_id: p.job_id })).content[0].text, 'slow'); // re-readable
// Opt-out: waits for the real result.
assert.equal((await withEarlyReturn(done(400, 'waited'), 't', 'job_result', true)).content[0].text, 'waited');
assert.equal((await jobResult({ job_id: 'nope' })).isError, true);

const s = summariseLog([
  '23:14:24 plumber: 813 DFW licensees, checking 3 from offset 310',
  '23:14:43 GALLAWAY PLUMBING SERVICES           SAVED 15206450886171335178 on Maps, no website',
  '23:15:17 THE PLUMBING FORCE                   maps_lookup error internal',
  '23:15:28 E.A.R .PLUMBING & HVAC               SAVED tsbpe:36498 not_on_maps',
  '23:15:32 BLUE SKY PLUMBING                    skip  on Maps with website',
  '23:15:40 done {"saved":2} STOPPED: challenge_detected | next offset 313 | harvest calls 5/500, cooldown 900s',
].join('\n'));
assert.deepEqual([s.checked, s.saved, s.saved_on_maps, s.errors, s.finished, s.stopped, s.next_offset], [4, 2, 1, 1, true, 'challenge_detected', 313]);
console.log('local-tools ok');
