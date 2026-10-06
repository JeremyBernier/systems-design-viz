// Several of the same component: a tier.
//
// Most kinds of component start as one box. Adding another of the same kind makes them a tier:
// the members share the load in proportion to what each can take, the tier's capacity is the sum
// of theirs, and it keeps working (with less capacity) while at least one member is up. Each
// member has its own technology, which sets its capacity and its price.
//
// The simulation still computes one set of figures per tier, on its first member (the node whose
// id is the type name: `db`, `cache`…). The others are `extras` (`db2`, `db3`): they mirror those
// figures for display and are billed their share. Behaviour that depends on the technology —
// crashing or throttling, what a write costs — follows the first member's.

export const EXTRAS = 2; // so a tier is at most three
export const TIER_TYPES = ['lb', 'cache', 'db', 'queue', 'worker', 'kafka', 'consumer', 'lake', 'clickhouse', 'trino', 'bi', 'cdn', 'blob', 'fn', 'scheduler', 'connector'];

// What one member contributes to the tier's capacity, where the technology sets one.
const CAP = { lb: (t) => t.cap, db: (t) => t.cap, queue: (t) => t.qmax, worker: (t) => t.rateMul, kafka: (t) => t.cap, consumer: (t) => t.cap, clickhouse: (t) => t.insertMax, fn: (t) => t.limit, scheduler: (t) => t.cap, connector: (t) => t.cap };
const cap = (n) => (n.tech && CAP[n.type] ? CAP[n.type](n.tech) : 1) || 1;
const live = (n) => n.active && !n.down;

export function makeExtras(n, makeNode) {
  for (const type of TIER_TYPES)
    for (let k = 2; k <= EXTRAS + 1; k++) {
      const e = makeNode(type + k, type, { extraOf: type, slot: k });
      e.active = false;
      n[e.id] = e;
    }
}

export const extrasOf = (sim, type) => Object.values(sim.nodes).filter((n) => n.extraOf === type);
export const liveExtra = (sim, type) => extrasOf(sim, type).find(live);
export const primaryOf = (sim, node) => sim.nodes[node.extraOf || node.type] || node;

// Capacity multiplier of every tier this step: 1 for a lone component, more with live extras.
export function tierFactors(sim) {
  const F = {};
  for (const type of TIER_TYPES) {
    const p = sim.nodes[type];
    const extras = extrasOf(sim, type);
    F[type] = 1 + extras.filter(live).reduce((s, e) => s + cap(e) / cap(p), 0);
    p.tierF = F[type];
    p.tierN = (p.active ? 1 : 0) + extras.filter((e) => e.active).length;
  }
  return F;
}

// This member's share of its tier's load (1 for a lone component, 0 while it is down).
export function share(sim, node) {
  if (node.type === 'web' || node.type === 'client') return 1;
  const p = primaryOf(sim, node);
  const members = [p, ...extrasOf(sim, p.type)].filter(live);
  if (members.length < 2) return live(node) || !members.length ? 1 : 0;
  return live(node) ? cap(node) / members.reduce((s, m) => s + cap(m), 0) : 0;
}

// Fields that belong to the member itself; everything else on an extra is a copy of the tier's figures.
const OWN = new Set(['id', 'type', 'label', 'active', 'down', 'downFor', 'crashes', 'stress', 'tech', 'kind', 'about', 'spec', 'serverless', 'managedDisk', 'restartSecs', 'extraOf', 'slot', 'tierF', 'tierN']);
export function mirror(p, e) {
  for (const k in p) if (!OWN.has(k)) e[k] = p[k];
}

// End of a step: extras show their tier's figures, and every member says it is one of several.
export function mirrorTiers(sim) {
  for (const type of TIER_TYPES) {
    const p = sim.nodes[type];
    if (p.tierN < 2) continue;
    const pct = (n) => Math.round(share(sim, n) * 100);
    const tier = p.status;
    for (const e of extrasOf(sim, type)) {
      if (!e.active) continue;
      mirror(p, e);
      e.status = e.down
        ? `This one is down. The other${p.tierN > 2 ? 's keep' : ' keeps'} the tier running with less capacity until it restarts.`
        : `One of ${p.tierN} sharing this load; it carries about ${pct(e)}%. ${tier}`;
      if (e.down) e.util = e.cpu = e.mem = e.net = e.bps = 0;
    }
    p.status = `One of ${p.tierN} sharing this load; it carries about ${pct(p)}%. ${tier}`;
  }
}
