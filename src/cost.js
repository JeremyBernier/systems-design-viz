// Ballpark monthly cost of the running system. Per-technology prices live in tech.js.
import { SECONDS, GB } from './tech.js';

const EGRESS_PER_GB = 0.09; // data transfer out to the internet
const RESPONSE_BYTES = 15e3; // of the 20 kB per request, ~15 kB is the response leaving the cloud

// → { monthly, basis } for one node
export function nodeCost(sim, node) {
  if (!node.tech) return { monthly: 0, basis: 'Not your infrastructure' };
  return { monthly: node.tech.cost(node, sim.params), basis: node.tech.basis };
}

// → { total, perMillion, items: [{ id, label, monthly, basis }] } sorted by cost
export function costs(sim) {
  const items = [];
  for (const id in sim.nodes) {
    const node = sim.nodes[id];
    if (!node.active || node.type === 'client') continue;
    items.push({ id, label: node.label, ...nodeCost(sim, node) });
  }
  // responses leaving the cloud are billed per GB — often the surprise on the invoice
  const egressGB = ((sim.totals.ok * RESPONSE_BYTES) / GB) * SECONDS;
  items.push({ id: null, label: 'Data transfer out', monthly: egressGB * EGRESS_PER_GB, basis: '$0.09 per GB sent to the internet (~15 kB per response)' });
  items.sort((a, b) => b.monthly - a.monthly);
  const total = items.reduce((s, i) => s + i.monthly, 0);
  const served = sim.totals.ok * SECONDS;
  return { total, perMillion: served > 0 ? total / (served / 1e6) : 0, items };
}

export function fmtUSD(v) {
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e4) return '$' + (v / 1e3).toFixed(1) + 'k';
  if (v >= 100) return '$' + Math.round(v).toLocaleString();
  return '$' + v.toFixed(2);
}
