// Ballpark monthly cost of the running system. Per-technology prices live in tech.js.
import { SECONDS, GB, priced } from './tech.js';
import { fleetBasis } from './datatier.js';
import { share } from './tier.js';

const EGRESS_PER_GB = 0.09; // data transfer out to the internet
const RESPONSE_BYTES = 15e3; // of the 20 kB per request, ~15 kB is the response leaving the cloud

// every figure on a node that grows with its load
const FLOWS = ['inRate', 'outRate', 'bps', 'readRate', 'writeRate', 'insertRate', 'getRate', 'putRate', 'concurrency', 'upRate', 'jobRate', 'edgeBytes', 'fillBytes', 'diskIO', 'load'];

// → { monthly, basis } for one node
export function nodeCost(sim, node) {
  if (!node.tech) return { monthly: 0, basis: 'Not your infrastructure' };
  // the pricing model discounts instance-hours only; priced() says whether this node had any
  // one of several sharing a load (tier.js): bill it for its share of the traffic, not the whole tier's
  const part = share(sim, node);
  const billed = part < 1 ? { ...node } : node;
  if (part < 1) for (const f of FLOWS) if (typeof billed[f] === 'number') billed[f] *= part;
  const { monthly, model } = priced(billed, sim.params);
  return { monthly, basis: node.tech.basis + fleetBasis(node) + (model ? ` · ${model.name}: −${Math.round((1 - model.mul) * 100)}% on instance-hours` : '') };
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
  // Only bytes your own machines send to users are billed here: API responses, plus static assets and media
  // when there is no CDN in front. What the CDN delivers is on the CDN's own line, at its cheaper rate.
  const A = sim.assets;
  const egressGB = ((sim.totals.ok * RESPONSE_BYTES * (sim.params.reqBytes / 20e3) + A.originBytes) / GB) * SECONDS;
  items.push({ id: null, label: 'Data transfer out', monthly: egressGB * EGRESS_PER_GB, basis: '$0.09 per GB sent to the internet from your servers (~15 kB per API response, plus any assets not served by the CDN)' });
  // cache misses travel origin → CDN; what that costs depends on the pair (S3 → CloudFront is free, a third-party CDN pays full egress)
  const fill = sim.nodes.blob.tech.egressFree ? 0 : sim.nodes.cdn.tech.fill;
  const fillGB = (A.fillBytes / GB) * SECONDS;
  if (fillGB * fill > 0) items.push({ id: null, label: 'Origin → CDN transfer', monthly: fillGB * fill, basis: `$${fill} per GB the CDN fetches from object storage on a cache miss` });
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
