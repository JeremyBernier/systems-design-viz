import { Sim, WORKLOAD_INFO } from './sim.js';
import { PRESETS } from './presets.js';
import { PRICING } from './tech.js';

// Save and share: the whole user-visible configuration as a URL query string, and back.
//
// Only what differs from the preset is written, so links stay short and readable:
//   preset=uber            the preset the system started from
//   traffic= queries= compaction=      the original human-readable params
//   web=4  db=dynamodb  olap=snowflake number of web servers; technology per component type
//   p=writePct:45,reqBytes:5000        every other Sim.params value
//   off=kafka,bi  on=web4              components removed from / added to the preset
//   cut=web0.cache  wire=…             connections unwired / wired, as from.to
//   focus=db  t=20                     selected component; seconds to skip ahead
//
// Nothing here names a param, component or connection: both directions walk whatever is in
// sim.params, sim.nodes and sim.edges, so new ones are captured without touching this file.

const READABLE = { traffic: 'traffic', queryRate: 'queries', compaction: 'compaction' }; // param → its own query key
const TYPE_ALIAS = { clickhouse: 'olap' }; // component type → query key
const typeOf = (key) => Object.keys(TYPE_ALIAS).find((t) => TYPE_ALIAS[t] === key) || key;
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const enc = (v) => (typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'object' ? JSON.stringify(v) : String(v));
// → a value of the same type as `like`, or undefined if it cannot be read as one
function dec(s, like) {
  if (typeof like === 'boolean') return s === '1' || s === 'true';
  if (typeof like === 'number') return s !== '' && isFinite(+s) ? +s : undefined;
  if (typeof like === 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
const edgeToken = (id) => (id.includes('.') ? id : id.replace('>', '.'));
const edgeId = (tok) => (tok.includes('>') ? tok : tok.replace('.', '>'));
const list = (q, key) => (q.get(key) || '').split(',').filter(Boolean);

function setWebCount(sim, n) {
  while (sim.webCount < n && sim.addWeb());
  while (sim.webCount > Math.max(1, n)) sim.removeWeb();
}

// The untouched system a link is relative to.
function baseline(preset) {
  const base = new Sim();
  base.applyPreset(PRESETS[preset] || PRESETS.reference);
  return base;
}

// → query string (no leading '?') that load() turns back into this system
export function serialise(sim, { preset = 'reference', focus = null, t = null } = {}) {
  if (!PRESETS[preset]) preset = 'reference';
  const base = baseline(preset);
  const p = sim.params;
  const out = [];
  if (preset !== 'reference') out.push(['preset', preset]);
  for (const k in READABLE) if (k in p && !same(p[k], base.params[k])) out.push([READABLE[k], enc(p[k])]);
  if (sim.webCount !== base.webCount) out.push(['web', sim.webCount]);
  setWebCount(base, sim.webCount);
  for (const type in p.tech) if (p.tech[type] !== base.params.tech[type]) out.push([TYPE_ALIAS[type] || type, p.tech[type]]);
  const rest = [];
  for (const k in p) if (k !== 'tech' && !(k in READABLE) && !same(p[k], base.params[k])) rest.push(`${k}:${encodeURIComponent(enc(p[k]))}`);
  if (rest.length) out.push(['p', rest.join(',')]);

  // components: bring the baseline to the same set, so connections are compared like for like
  const on = [];
  const off = [];
  for (const id in sim.nodes) {
    const b = base.nodes[id];
    if (!b || b.active === sim.nodes[id].active) continue;
    (sim.nodes[id].active ? on : off).push(id);
    base.setActive(id, sim.nodes[id].active);
  }
  if (off.length) out.push(['off', off.join(',')]);
  if (on.length) out.push(['on', on.join(',')]);
  // connections: only those between components that are in the diagram can be seen
  const live = (id) => id.split('>').every((x) => sim.nodes[x] && sim.nodes[x].active);
  const cut = [...base.edges].filter((e) => live(e) && !sim.edges.has(e));
  const wire = [...sim.edges].filter((e) => live(e) && !base.edges.has(e));
  if (cut.length) out.push(['cut', cut.map(edgeToken).join(',')]);
  if (wire.length) out.push(['wire', wire.map(edgeToken).join(',')]);

  if (focus && sim.nodes[focus] && sim.nodes[focus].active) out.push(['focus', focus]);
  if (t) out.push(['t', t]);
  // ':' and ',' are legal in a query string; leaving them bare keeps the link readable
  return out.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%3A/g, ':').replace(/%2C/g, ',')}`).join('&');
}

// Rebuild the system a link describes. `applyPreset` lets the caller reset its own view too.
// → { preset, focus, t } for the caller to act on (preset is null if the link names none)
export function load(sim, query, applyPreset = (pr) => sim.applyPreset(pr)) {
  const q = query instanceof URLSearchParams ? query : new URLSearchParams(query);
  const p = sim.params;
  const preset = PRESETS[q.get('preset')] ? q.get('preset') : null;
  if (preset) applyPreset(PRESETS[preset]);
  if (q.has('traffic')) p.traffic = Math.min(20000, Math.max(20, +q.get('traffic') || 600));
  if (q.has('queries')) p.queryRate = Math.min(200, Math.max(0, +q.get('queries') || 0));
  if (q.has('compaction')) p.compaction = q.get('compaction') !== '0';
  for (const pair of list(q, 'p')) {
    const at = pair.indexOf(':');
    const k = pair.slice(0, at);
    if (at < 1 || !(k in p) || k === 'tech') continue;
    let v;
    try {
      v = dec(decodeURIComponent(pair.slice(at + 1)), p[k]);
    } catch {
      continue; // malformed escape
    }
    if (v === undefined || (k === 'pricing' && !PRICING[v])) continue;
    // a hand-edited link must not push a workload assumption somewhere the simulation cannot go
    const f = WORKLOAD_INFO[k];
    p[k] = f ? Math.min(f.max * f.scale, Math.max(f.min * f.scale, v)) : v;
  }
  // ?db=dynamodb&web=lambda… picks a technology per component type (olap = the OLAP database)
  for (const [k, v] of q) if (k !== 'web' || isNaN(+v)) sim.setTech(typeOf(k), v, true);
  const webs = q.getAll('web').find((v) => v !== '' && !isNaN(+v));
  if (webs !== undefined) setWebCount(sim, Math.round(+webs));
  for (const id of list(q, 'off')) if (sim.nodes[id] && sim.nodes[id].type !== 'client') sim.setActive(id, false);
  for (const id of list(q, 'on')) if (sim.nodes[id]) sim.setActive(id, true);
  for (const e of list(q, 'cut').map(edgeId)) sim.edges.delete(e);
  for (const e of list(q, 'wire').map(edgeId)) {
    const [a, b] = e.split('>');
    if (sim.nodes[a] && sim.nodes[b] && sim.canConnect(a, b) === e) sim.edges.add(e);
  }
  return { preset, focus: q.get('focus'), t: Math.min(120, +q.get('t') || 0) };
}
