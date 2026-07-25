// Demonstrates the opt-in agent + named-structure registry.
// Run under PM3 (pm3 start test/agent-demo.js) to see named structures in the memory
// modal, or plain `node test/agent-demo.js` to confirm it is a no-op outside PM3.
//
// This is the pattern to copy: PM3 puts the agent's absolute path in PM3_AGENT, which
// works for global installs, local installs and npm link alike. `require('pm3/agent')`
// does not — a global install leaves the package unresolvable.
const pm3 = process.env.PM3_AGENT
  ? require(process.env.PM3_AGENT).attach({ name: 'agent-demo' })
  : null;

const sessions = new Map();
const queue = [];

pm3?.track('sessions', () => sessions);  // getter, not the value — see agent/README.md
pm3?.track('queue',    () => queue);

let n = 0;
setInterval(() => {
  for (let i = 0; i < 500; i++) sessions.set('user-' + (n++), { since: Date.now(), pad: 'x'.repeat(128) });
  queue.push(Date.now());
  console.log(`[agent-demo] agent ${pm3?.enabled ? 'attached' : 'inactive (no PM3)'} · sessions ${sessions.size} · queue ${queue.length}`);
}, 1000);
