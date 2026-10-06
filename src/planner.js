import { TECH, DEFAULT_TECH } from './tech.js';
import { MAX_CACHE_NODES } from './datatier.js';
import { MAX_WEB, NIC_BPS, SPECS, WEB_THREADS, WORKLOAD, fmtBits, fmtDur } from './sim.js';

// Capacity planner: product-level numbers (daily users, requests per user…) → the
// back-of-envelope estimate an interview or a sizing exercise starts with, then a
// recommended sizing for the technologies currently selected.
//
// Pure functions, no DOM. Every capacity comes from tech.js / sim.js — the same numbers
// Sim.step() uses — so the plan and the simulation cannot disagree. Each result carries
// the arithmetic that produced it (`calc`), because the point is to teach the estimate.

export const DAY = 86400; // seconds; interviews round it to 10^5
// Limits of the simulator's own controls, flagged by plan() rather than silently clamped.
export const MAX_WORKERS = 6; // where the Workers stepper stops (ui.js)
export const TRAFFIC_RANGE = [20, 20000]; // the traffic slider (ui.js) and ?traffic= (main.js)
export const MAX_WRITE_PCT = 60; // the Writes slider (index.html)
// Planner-only rules of thumb.
const HOT_FRAC = 0.2; // 80/20 rule: ~20% of the items take ~80% of the reads, so cache that 20%
const CACHE_ITEM_BYTES = 4e3; // one cached result; the simulation moves the same 4 kB per cache lookup
// Idle latencies the simulation gives a healthy cache and database (seconds). They only
// matter for the thread-pool limit of a web server.
const CACHE_LAT = 0.001;
const DB_LAT = 0.004;

export const PLAN_DEFAULTS = {
  dau: 1e6, // daily active users
  reqPerUser: 20, // requests each sends per day
  peakRatio: 2, // peak ÷ average: 2× is the usual interview figure, a sharp evening peak is nearer 3×
  writePct: 10, // % of requests that write
  writeBytes: 2e3, // bytes stored per write, indexes included
  retentionDays: 365, // how long data is kept
  targetUtil: 60, // % of capacity to plan for at peak, leaving room for spikes and a failed machine
};
// Form fields, in order: [key, label, unit, min, max, bytes per display unit]
export const PLAN_FIELDS = [
  ['dau', 'Daily active users', 'users', 1, 1e10, 1],
  ['reqPerUser', 'Requests per user per day', 'req', 0.01, 1e5, 1],
  ['peakRatio', 'Peak ÷ average traffic', '×', 1, 100, 1],
  ['writePct', 'Writes', '%', 0, 100, 1],
  ['writeBytes', 'Data stored per write', 'kB', 0.001, 1e7, 1e3],
  ['retentionDays', 'Retention', 'days', 1, 36500, 1],
  ['targetUtil', 'Target utilisation at peak', '%', 10, 100, 1],
];

// ---- formatting (decimal prefixes throughout, like the rest of the app)
export function fmtNum(v) {
  if (!isFinite(v)) return '∞';
  if (v >= 1e12) return parseFloat((v / 1e12).toFixed(2)) + ' T';
  if (v >= 1e9) return parseFloat((v / 1e9).toFixed(2)) + ' B';
  if (v >= 1e6) return parseFloat((v / 1e6).toFixed(2)) + ' M';
  if (v >= 100) return Math.round(v).toLocaleString('en-US');
  return String(parseFloat(v.toFixed(v >= 10 ? 1 : 2)));
}
export function fmtSize(bytes) {
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  let i = 0;
  while (bytes >= 1000 && i < units.length - 1) {
    bytes /= 1000;
    i++;
  }
  return parseFloat(bytes.toFixed(bytes >= 100 ? 0 : bytes >= 10 ? 1 : 2)) + ' ' + units[i];
}
const pct = (v) => (isFinite(v) ? Math.round(v * 100) + '%' : '∞');
const span = (days) => (days >= 730 ? parseFloat((days / 365).toFixed(1)) + ' years' : days >= 2 ? Math.round(days) + ' days' : fmtDur(days * DAY));
// how a load ÷ capacity ratio reads against the target
const level = (util, target) => (util > 1 ? 'bad' : util > target + 1e-9 ? 'warn' : 'ok');

// Requests/s one web server takes before it saturates: the lower of its CPU and its
// thread pool. Mirrors the web-server section of Sim.step().
export function webCapacity(params, webTech, writeFrac, hit) {
  const downstream = (1 - writeFrac) * (hit * CACHE_LAT + (1 - hit) * DB_LAT) + writeFrac * DB_LAT;
  const cpu = params.webRps * webTech.capMul;
  const threads = WEB_THREADS / (params.svcTime + downstream);
  return { cpu, threads, cap: Math.min(cpu, threads), downstream };
}

// What plan() needs to know about the system being sized, read off a live Sim.
export function planContext(sim) {
  const active = new Set();
  for (const id in sim.nodes) if (sim.nodes[id].active) active.add(sim.nodes[id].type);
  return { params: sim.params, tech: sim.params.tech, active, diskUsed: sim.nodes.db.diskUsed, webCount: sim.webCount };
}

// input: PLAN_DEFAULTS-shaped. ctx: { params, tech, active?, diskUsed? } (defaults: stock workload, default technologies, everything present).
// → { n: raw numbers, estimate: [{ label, calc, value }], sizing: [{ type, label, tech, level, value, calc: [..], note }],
//     apply: { params, webs }, flags: [..] }
export function plan(input, ctx = {}) {
  const i = { ...PLAN_DEFAULTS, ...input };
  const p = { ...WORKLOAD, ...ctx.params };
  const techKey = { ...DEFAULT_TECH, ...ctx.tech };
  const tech = (type) => TECH[type][techKey[type]];
  const has = (type) => !ctx.active || ctx.active.has(type);
  const target = i.targetUtil / 100;
  const wf = i.writePct / 100;
  const flags = [];

  // ---- the back-of-envelope estimate
  const reqPerDay = i.dau * i.reqPerUser;
  const avgRps = reqPerDay / DAY;
  const peakRps = avgRps * i.peakRatio;
  const peakReads = peakRps * (1 - wf);
  const peakWrites = peakRps * wf;
  const writesPerDay = reqPerDay * wf;
  const readsPerDay = reqPerDay - writesPerDay;
  const growthDay = writesPerDay * i.writeBytes; // bytes
  const growthYear = growthDay * 365;
  const retained = growthDay * i.retentionDays;
  const peakBps = peakRps * p.reqBytes * 8;
  const transferMonth = reqPerDay * 30 * p.reqBytes; // bytes, both directions
  const cacheBytes = readsPerDay * HOT_FRAC * CACHE_ITEM_BYTES;
  const n = { reqPerDay, avgRps, peakRps, avgReads: avgRps * (1 - wf), avgWrites: avgRps * wf, peakReads, peakWrites, writesPerDay, readsPerDay, growthDay, growthYear, retained, avgBps: avgRps * p.reqBytes * 8, peakBps, transferMonth, cacheBytes };

  const estimate = [
    { label: 'Requests per day', calc: `${fmtNum(i.dau)} users × ${fmtNum(i.reqPerUser)} requests`, value: fmtNum(reqPerDay) },
    { label: 'Average rate', calc: `${fmtNum(reqPerDay)} ÷ 86,400 s in a day (≈ 10⁵)`, value: `${fmtNum(avgRps)} req/s` },
    { label: 'Peak rate', calc: `${fmtNum(avgRps)} × ${fmtNum(i.peakRatio)} peak-to-average`, value: `${fmtNum(peakRps)} req/s` },
    { label: 'Read QPS at peak', calc: `${fmtNum(peakRps)} × ${fmtNum(100 - i.writePct)}% reads (average ${fmtNum(n.avgReads)})`, value: `${fmtNum(peakReads)} /s` },
    { label: 'Write QPS at peak', calc: `${fmtNum(peakRps)} × ${fmtNum(i.writePct)}% writes (average ${fmtNum(n.avgWrites)})`, value: `${fmtNum(peakWrites)} /s` },
    { label: 'Storage growth per day', calc: `${fmtNum(writesPerDay)} writes × ${fmtSize(i.writeBytes)}`, value: fmtSize(growthDay) },
    { label: 'Storage growth per year', calc: `${fmtSize(growthDay)} × 365`, value: fmtSize(growthYear) },
    { label: 'Stored at steady state', calc: `${fmtSize(growthDay)} × ${fmtNum(i.retentionDays)} days retained (before replicas and backups)`, value: fmtSize(retained) },
    { label: 'Bandwidth at peak', calc: `${fmtNum(peakRps)} req/s × ${fmtSize(p.reqBytes)} × 8 bits (average ${fmtBits(n.avgBps)})`, value: fmtBits(peakBps) },
    { label: 'Data transferred per month', calc: `${fmtNum(reqPerDay)} × 30 days × ${fmtSize(p.reqBytes)}, requests and responses`, value: fmtSize(transferMonth) },
    { label: 'Cache memory', calc: `${fmtNum(readsPerDay)} reads/day × ${pct(HOT_FRAC)} hot (80/20 rule) × ${fmtSize(CACHE_ITEM_BYTES)} per item — an upper bound: repeat reads of one item share an entry`, value: fmtSize(cacheBytes) },
  ];

  // ---- sizing for the selected technologies
  const sizing = [];
  const row = (type, label, lvl, value, calc, note = '') => sizing.push({ type, label, tech: tech(type).name, level: lvl, value, calc, note });

  if (has('lb')) {
    const t = tech('lb');
    const util = peakRps / t.cap;
    row('lb', 'Load balancer', level(util, target), `${pct(util)} of capacity`, [
      `${fmtNum(peakRps)} req/s peak ÷ ${fmtNum(t.cap)} req/s it can route = ${pct(util)}`,
      `${fmtBits(peakBps)} through a ${fmtBits(NIC_BPS.lb)} link = ${pct(peakBps / NIC_BPS.lb)}`,
    ]);
    if (util > 1) flags.push(`${t.name} routes ${fmtNum(t.cap)} req/s; the peak is ${fmtNum(peakRps)}. The simulator has a single load balancer — pick a managed one.`);
  }

  const hit = has('cache') ? p.cacheHitRatio : 0;
  let webs = ctx.webCount || 2;
  if (has('web')) {
    const t = tech('web');
    const c = webCapacity(p, t, wf, hit);
    const forLoad = Math.max(1, Math.ceil(peakRps / (c.cap * target)));
    webs = forLoad + 1;
    const fit = Math.min(webs, MAX_WEB);
    const perNic = (peakRps / fit) * p.reqBytes * 8;
    const calc = [
      `One server: ${fmtNum(c.cpu)} req/s of CPU (${fmtNum(p.webRps)} baseline × ${t.capMul} for ${t.name}); ${WEB_THREADS} threads ÷ ${fmtDur(p.svcTime + c.downstream)} held per request = ${fmtNum(c.threads)} req/s → ${fmtNum(c.cap)} req/s, ${c.threads < c.cpu ? 'thread' : 'CPU'}-bound`,
      `${fmtNum(peakRps)} peak ÷ (${fmtNum(c.cap)} × ${pct(target)} target) = ${fmtNum(peakRps / (c.cap * target))} → ${forLoad} server${forLoad > 1 ? 's' : ''}, + 1 spare (N+1) = ${webs}`,
      `At peak each of ${fit} runs at ${pct(peakRps / (fit * c.cap))}; with one down the rest run at ${pct(peakRps / (Math.max(1, fit - 1) * c.cap))}`,
      `Network: ${fmtBits(perNic)} per server on a ${fmtBits(NIC_BPS.web)} link = ${pct(perNic / NIC_BPS.web)}`,
    ];
    const over = peakRps / (fit * c.cap);
    row('web', 'Web servers', webs > MAX_WEB ? (over > 1 ? 'bad' : 'warn') : perNic > NIC_BPS.web ? 'warn' : 'ok', `${webs} × ${t.name}`, calc, 'N+1: one more than the load needs, so a crash or a deploy does not push the survivors past the target.');
    if (webs > MAX_WEB)
      flags.push(`The plan needs ${webs} web servers; the simulator supports ${MAX_WEB}. Applied ${MAX_WEB}, which run at ${pct(over)} at peak${over > 1 ? ' — expect overload' : ''}. A real fleet would simply be larger (or use bigger machines).`);
    webs = fit;
  }

  let cacheNodes = 1;
  if (has('cache')) {
    const ram = (tech('cache').spec || SPECS.cache).ramGB * 1e9;
    const util = cacheBytes / ram;
    row('cache', 'Cache', util > 1 ? 'warn' : 'ok', util > 1 ? `needs ${fmtSize(cacheBytes)}` : `${pct(util)} of memory`, [
      `${fmtSize(cacheBytes)} wanted ÷ ${fmtSize(ram)} in the node = ${pct(util)}`,
      `A warm cache answers ${pct(hit)} of reads: ${fmtNum(peakReads * hit)} /s never reach the database`,
    ], util > 1 ? 'A smaller cache still works — the hit ratio is just lower than assumed.' : '');
    cacheNodes = Math.min(MAX_CACHE_NODES, Math.max(1, Math.ceil(util)));
    if (util > MAX_CACHE_NODES) flags.push(`The cache estimate is ${fmtSize(cacheBytes)}, about ${Math.ceil(util)} nodes of ${fmtSize(ram)}; the simulator supports ${MAX_CACHE_NODES}. Applied ${MAX_CACHE_NODES}.`);
  }

  if (has('db')) {
    const t = tech('db');
    const dbReads = peakReads * (1 - hit);
    const units = dbReads + peakWrites * t.writeCost;
    const util = units / t.cap;
    const cold = (peakReads + peakWrites * t.writeCost) / t.cap;
    const maxWrites = t.cap / t.writeCost;
    const calc = [
      `Reads reaching it: ${fmtNum(peakReads)} × (1 − ${pct(hit)} cache hits) = ${fmtNum(dbReads)} /s`,
      `Load: ${fmtNum(dbReads)} reads + ${fmtNum(peakWrites)} writes × ${t.writeCost} (a write costs ${t.writeCost}× a read) = ${fmtNum(units)} of ${fmtNum(t.cap)} units/s = ${pct(util)}`,
      `Writes alone: ${fmtNum(peakWrites)} /s at peak; the ceiling with no reads at all is ${fmtNum(t.cap)} ÷ ${t.writeCost} = ${fmtNum(maxWrites)} /s`,
    ];
    if (has('cache')) calc.push(`Cold cache (after a restart every read falls through): ${fmtNum(peakReads + peakWrites * t.writeCost)} units/s = ${pct(cold)}${cold > 1 ? ' — a cache failure at peak takes the database down with it' : ''}`);
    let lvl = level(util, target);
    let value = `${pct(util)} of capacity`;
    if (t.managedDisk) calc.push(`Disk: ${t.name} storage grows on demand — ${fmtSize(retained)} at steady state, billed per GB`);
    else {
      const free = t.spec.diskGB * 1e9 * (1 - (ctx.diskUsed ?? 0.35));
      const days = growthDay > 0 ? free / growthDay : Infinity;
      calc.push(`Disk: ${fmtSize(free)} free of ${fmtSize(t.spec.diskGB * 1e9)} ÷ ${fmtSize(growthDay)} per day = full in ${span(days)}`);
      if (isFinite(days)) value += ` · disk lasts ${span(days)}`;
      if (days < i.retentionDays) {
        if (lvl === 'ok') lvl = 'warn';
        flags.push(`The database disk fills in ${span(days)}, before the ${fmtNum(i.retentionDays)}-day retention frees anything: it needs ${fmtSize(retained)}, and has ${fmtSize(free)} free. In the simulator use “Add storage”, or pick a database with managed storage.`);
      } else if (isFinite(days)) flags.push(`Retention would hold the database at ${fmtSize(retained)}, but the simulator never deletes old data: its disk keeps filling (${span(days)} at this rate).`);
    }
    row('db', 'Database', lvl, value, calc);
    if (util > 1)
      flags.push(`${t.name} takes ${fmtNum(t.cap)} units/s; the peak needs ${fmtNum(units)}. One node cannot take it: add shards (or read replicas if reads dominate) under Architecture, raise the cache hit ratio, or choose a scale-out technology.`);
  }

  let workers = p.workerCount || 1;
  if (has('queue') && has('worker')) {
    const t = tech('worker');
    const jobs = peakRps * p.jobFrac;
    const per = p.jobRate * t.rateMul;
    workers = Math.max(1, Math.ceil(jobs / (per * target)));
    const fit = Math.min(workers, MAX_WORKERS);
    const util = jobs / (fit * per);
    const qmax = tech('queue').qmax;
    const calc = [
      `Jobs: ${fmtNum(peakRps)} req/s × ${pct(p.jobFrac)} that enqueue one = ${fmtNum(jobs)} jobs/s at peak`,
      `One worker: ${fmtNum(p.jobRate)} jobs/s baseline × ${t.rateMul} for ${t.name} = ${fmtNum(per)} jobs/s`,
      `${fmtNum(jobs)} ÷ (${fmtNum(per)} × ${pct(target)} target) = ${fmtNum(jobs / (per * target))} → ${workers} worker${workers > 1 ? 's' : ''}, running at ${pct(jobs / (workers * per))} at peak`,
    ];
    if (util > 1) calc.push(`With ${fit} workers the backlog grows by ${fmtNum(jobs - fit * per)} jobs/s: ${tech('queue').name} (${fmtNum(qmax)} jobs) is full after ${fmtDur(qmax / (jobs - fit * per))} of peak`);
    row('worker', 'Workers', workers > MAX_WORKERS ? (util > 1 ? 'bad' : 'warn') : 'ok', `${workers} × ${t.name}`, calc, 'No spare here: the queue absorbs a burst or a lost worker, and jobs just wait a little longer.');
    if (workers > MAX_WORKERS) flags.push(`The plan needs ${workers} workers; the simulator supports ${MAX_WORKERS}. Applied ${MAX_WORKERS}, which run at ${pct(util)} at peak${util > 1 ? ' — the queue will back up' : ''}.`);
    workers = fit;
  }

  if (has('kafka')) {
    const t = tech('kafka');
    const util = peakRps / t.cap;
    const calc = [
      `Every request publishes one event: ${fmtNum(peakRps)} events/s peak ÷ ${fmtNum(t.cap)} it accepts = ${pct(util)} (${fmtNum(Math.max(0, t.cap - peakRps))} /s of headroom)`,
      `${fmtNum(peakRps)} × ${fmtSize(p.eventBytes)} = ${fmtSize(peakRps * p.eventBytes)}/s appended at peak, ${fmtSize(avgRps * p.eventBytes * DAY)} per day`,
    ];
    let lvl = level(util, target);
    // consumers pull: over capacity they lag rather than fail, so they must beat the average, not the peak
    const consumers = [];
    if (has('consumer')) consumers.push([tech('consumer').name, tech('consumer').cap]);
    if (has('clickhouse')) consumers.push([tech('clickhouse').name, tech('clickhouse').insertMax]);
    for (const [name, cap] of consumers) {
      calc.push(`${name} reads ${fmtNum(cap)} events/s: ${avgRps > cap ? 'slower than the average rate, so it falls behind for good and events expire unread' : peakRps > cap ? `it lags by ${fmtNum(peakRps - cap)} events/s at peak (${fmtNum(t.retention)} unread events are kept — ${fmtDur(t.retention / (peakRps - cap))} of peak) and catches up off-peak` : 'keeps up even at peak'}`);
      if (avgRps > cap) {
        lvl = 'bad';
        flags.push(`${name} reads ${fmtNum(cap)} events/s, below the average ${fmtNum(avgRps)}: it can never catch up. The simulator has one of each consumer — pick a faster technology.`);
      } else if (peakRps > cap && lvl === 'ok') lvl = 'warn';
    }
    row('kafka', 'Event stream', lvl, `${pct(util)} of capacity`, calc);
    if (util > 1) flags.push(`${t.name} accepts ${fmtNum(t.cap)} events/s; the peak produces ${fmtNum(peakRps)}. The simulator cannot add brokers or shards — pick a higher-capacity stream.`);
  }

  // ---- what "Apply to simulation" sets. Traffic is the peak: that is what the sizing is for.
  const [lo, hi] = TRAFFIC_RANGE;
  const traffic = Math.round(Math.min(hi, Math.max(lo, peakRps)));
  if (peakRps > hi) flags.push(`Peak traffic is ${fmtNum(peakRps)} req/s; the simulator goes up to ${fmtNum(hi)}. Applied ${fmtNum(hi)} — treat it as a 1:${fmtNum(peakRps / hi)} scale model of your system.`);
  else if (peakRps < lo) flags.push(`Peak traffic is ${fmtNum(peakRps)} req/s; the simulator starts at ${lo}. Applied ${lo}.`);
  if (i.writePct > MAX_WRITE_PCT) flags.push(`${fmtNum(i.writePct)}% writes is above the Writes slider's ${MAX_WRITE_PCT}% maximum. It is applied as given, but touching that slider will pull it back.`);
  const apply = { params: { traffic, writePct: Math.round(i.writePct), workerCount: workers, writeBytes: i.writeBytes, cacheNodes }, webs };

  return { input: i, n, estimate, sizing, apply, flags };
}

// Push a plan into a live Sim. Only params the Sim actually has are set. → the plan's flags
export function applyPlan(sim, pl) {
  for (const k in pl.apply.params) if (k in sim.params) sim.params[k] = pl.apply.params[k];
  while (sim.webCount < pl.apply.webs && sim.addWeb());
  while (sim.webCount > Math.max(1, pl.apply.webs)) sim.removeWeb();
  return pl.flags;
}
