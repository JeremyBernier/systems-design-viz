import { TECH, DEFAULT_TECH } from './tech.js';
import { DATA_DEFAULTS, CACHE_NODE_CAP, partialLoss, heal, cacheCluster, cacheStatus, dbCluster, dbStatus } from './datatier.js';
import { ASSET_DEFAULTS, newAssetStats, assetTraffic, addAssetLoad } from './cdn.js';
import { fnJobCapacity, functions } from './functions.js';
import { initReliability, reliability, recordReliability } from './latency.js';
import { AUTO_PARAMS, trafficShape, scaleWeb, scaleWorkers } from './autoscale.js';

// Rate-based ("fluid") simulation of a small web service.
// Every node has a capacity, a bounded backlog, and four hardware resources
// (cpu / mem / disk / net, each 0..1). Overload fills the backlog, a full
// backlog sheds load, and sustained overload crashes the node.

export const MAX_WEB = 6;

// Which kinds of component may talk to which. Direction is who initiates the call.
export const EDGE_TYPES = [
  ['client', 'lb'],
  ['lb', 'web'],
  ['web', 'cache'],
  ['web', 'db'],
  ['web', 'queue'],
  ['web', 'kafka'],
  ['cache', 'db'],
  ['queue', 'worker'],
  ['kafka', 'consumer'],
  ['kafka', 'clickhouse'],
  ['consumer', 'lake'],
  ['bi', 'clickhouse'],
  ['bi', 'trino'],
  ['trino', 'lake'],
  // static assets and media: clients fetch them from the CDN, which pulls misses from object storage.
  // API requests keep their own hostname and go straight to the load balancer, so there is no cdn → lb edge.
  ['client', 'cdn'],
  ['cdn', 'blob'],
  ['web', 'blob'], // uploads, and asset reads when there is no CDN
  ['blob', 'fn'], // an upload event invokes a function
  ['queue', 'fn'], // functions polling the queue, alongside the workers
];
export const HISTORY = 240; // samples kept per metric (4 per second → 60s)

// Average bytes on the wire per HTTP request (request + response) and per Kafka event.
const REQ_BYTES = 20e3;
const EVENT_BYTES = 2e3;
const PARQUET_RATIO = 6; // raw JSON events → compressed columnar Parquet
export const WEB_THREADS = 256; // request threads per web server
// Workload assumptions: properties of the product, not of any technology. They are the
// defaults of the matching Sim.params, which the user (or a preset) may override.
export const WORKLOAD = {
  reqBytes: REQ_BYTES,
  eventBytes: EVENT_BYTES,
  cacheHitRatio: 0.85, // share of reads a warm cache answers
  jobFrac: 0.15, // share of requests that enqueue a background job
  // Stored per write, indexes and log included. Hugely inflated (a real row is ~1 kB) so a
  // 500 GB disk fills while you watch: ~1% per 12,000 writes.
  writeBytes: (500 / 1.2e6) * 1e9,
  svcTime: 0.02, // seconds a request spends in application code, holding a thread
  webRps: 1200, // requests/s one baseline 8-vCPU server handles before its CPU saturates
  jobRate: 120, // jobs/s one baseline 4-vCPU worker completes
};
// How each assumption is shown and edited: display unit, bytes/seconds per unit, allowed range.
export const WORKLOAD_INFO = {
  reqBytes: { label: 'Request + response size', unit: 'kB', scale: 1e3, min: 0.1, max: 5000, tip: 'Average bytes on the wire per request. Sets bandwidth everywhere on the request path.' },
  cacheHitRatio: { label: 'Cache hit ratio when warm', unit: '%', scale: 0.01, min: 0, max: 100, tip: 'Share of reads answered from RAM. The rest fall through to the database.' },
  jobFrac: { label: 'Requests that enqueue a job', unit: '%', scale: 0.01, min: 0, max: 100, tip: 'Share of requests that leave slow work (email, thumbnails) on the job queue.' },
  eventBytes: { label: 'Event size', unit: 'kB', scale: 1e3, min: 0.05, max: 1000, tip: 'Bytes per event published to the stream; every request publishes one.' },
  writeBytes: { label: 'Stored per write', unit: 'kB', scale: 1e3, min: 0.01, max: 1e5, tip: 'Database bytes per write, indexes included. The default is inflated ~400× so the disk fills while you watch; a real row is nearer 1 kB.' },
  svcTime: { label: 'App time per request', unit: 'ms', scale: 1e-3, min: 1, max: 2000, tip: 'Wall-clock time in your own code per request. Each request holds one of 256 threads for this long plus the database wait.' },
  webRps: { label: 'Server throughput', unit: 'req/s', scale: 1, min: 10, max: 20000, tip: 'Requests/s one 8-vCPU server handles before its CPU saturates. Measure it with a load test: 1,200 means ~7 ms of CPU per request.' },
  jobRate: { label: 'Worker throughput', unit: 'jobs/s', scale: 1, min: 1, max: 5000, tip: 'Jobs/s one 4-vCPU worker completes.' },
};
// Link speed of each machine's network card, in bits per second.
export const NIC_BPS = { client: 10e9, lb: 10e9, web: 1e9, cache: 1e9, db: 1e9, kafka: 1e9, consumer: 1e9, queue: 1e9, worker: 1e9, lake: 10e9, clickhouse: 10e9, trino: 10e9, bi: 1e9 };
// Managed services have no card of yours; these are the slice of the provider's network a system this size could draw on.
NIC_BPS.cdn = 400e9;
NIC_BPS.blob = 100e9;
NIC_BPS.fn = 10e9;
// Connections that are possible but not made until the user asks: functions on the queue would hide what the workers teach.
const OPTIONAL_EDGES = new Set(['queue>fn']);

// Hardware fitted to each machine. Workers are a pool: totals scale with the worker count.
export const SPECS = {
  client: { cores: 4, ramGB: 8, diskGB: 100 },
  lb: { cores: 4, ramGB: 8, diskGB: 50 },
  web: { cores: 8, ramGB: 16, diskGB: 100 },
  cache: { cores: 4, ramGB: 32, diskGB: 50 },
  db: { cores: 16, ramGB: 64, diskGB: 500 },
  kafka: { cores: 8, ramGB: 32, diskGB: 2000 },
  consumer: { cores: 8, ramGB: 16, diskGB: 200 },
  queue: { cores: 4, ramGB: 16, diskGB: 100 },
  worker: { cores: 4, ramGB: 8, diskGB: 100 },
  lake: { cores: 0, ramGB: 0, diskGB: 0 }, // managed object storage: no machine of yours
  clickhouse: { cores: 16, ramGB: 64, diskGB: 1000 },
  trino: { cores: 16, ramGB: 64, diskGB: 200 },
  bi: { cores: 4, ramGB: 8, diskGB: 100 },
  cdn: { cores: 0, ramGB: 0, diskGB: 0 }, // the provider's edge network
  blob: { cores: 0, ramGB: 0, diskGB: 0 }, // managed object storage
  fn: { cores: 0, ramGB: 0, diskGB: 0 }, // serverless: no machine of yours
};

export function fmtGB(gb) {
  if (gb >= 1000) return parseFloat((gb / 1000).toFixed(2)) + ' TB';
  if (gb >= 100) return Math.round(gb) + ' GB';
  if (gb >= 1) return parseFloat(gb.toFixed(1)) + ' GB';
  return Math.round(gb * 1000) + ' MB';
}

// "used / total" in real units for one of a node's four resources.
export function rawMetric(node, key, params) {
  if (node.serverless && (key === 'cpu' || key === 'mem')) return 'managed by the cloud provider';
  if (node.managedDisk && key === 'disk') return `${fmtGB(node.storedGB)} stored · no fixed limit`;
  const spec = node.spec || SPECS[node.type];
  const n = node.type === 'worker' ? params.workerCount : node.fleet || 1; // database and cache report their whole fleet
  if (key === 'cpu') return `${(node.cpu * spec.cores * n).toFixed(1)} / ${spec.cores * n} cores`;
  if (key === 'mem') return `${fmtGB(node.mem * spec.ramGB * n)} / ${fmtGB(spec.ramGB * n)}`;
  if (key === 'disk') return `${fmtGB(node.disk * spec.diskGB * n)} / ${fmtGB(spec.diskGB * n)}`;
  return `${fmtBits(node.bps)} / ${fmtBits(NIC_BPS[node.type])}`;
}

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
// exponential smoothing so displayed numbers don't jitter
const ease = (cur, target, dt, tau = 0.4) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

export const NODE_INFO = {
  client: {
    title: 'Clients',
    kind: 'Traffic source',
    about:
      'Browsers and mobile apps sending HTTP requests. Each request is either a read (fetch a page) or a write (save something). Clients do not care why a request failed — they just see an error or a spinner.',
  },
  lb: {
    title: 'Load Balancer',
    kind: 'Reverse proxy',
    about:
      'Spreads incoming requests evenly across healthy web servers and stops sending traffic to dead ones. It does very little work per request, so it is rarely the bottleneck — but when a server dies, the survivors each get a bigger share.',
  },
  web: {
    title: 'Web Server',
    kind: 'Application server',
    about:
      'Runs your application code. Each request holds a worker thread until the database answers, so a slow database ties up threads and cuts throughput even when the CPU is idle. Requests that cannot be served wait in memory; when memory runs out the process is killed.',
  },
  cache: {
    title: 'Cache',
    kind: 'In-memory key-value store',
    about:
      'Keeps recent query results in RAM so most reads never reach the database. A restarted cache is empty ("cold") — until it warms up, every read falls through to the database, which can knock the database over.',
  },
  db: {
    title: 'OLTP Database',
    kind: 'Transactional database',
    about:
      'The source of truth. Writes cost about 4× a read because they must hit disk durably. Every write also consumes storage, and a full disk makes the database refuse writes. It is the hardest tier to scale, so it is usually the real bottleneck.',
  },
  kafka: {
    title: 'Event Stream',
    kind: 'Durable log of events',
    about:
      'Every request publishes an event here, and any number of downstream systems read the stream independently, each at its own pace. It decouples the application from analytics: the web tier never waits for consumers, and a slow consumer just falls behind ("lag") instead of slowing anyone else down.',
  },
  consumer: {
    title: 'Lake Writer',
    kind: 'Stream processor (e.g. Flink)',
    about:
      'Not a destination, a processing step: it reads events from Kafka at its own pace, validates and reshapes them, batches them into compressed Parquet files and commits those to the Iceberg table in the data lake. Because it pulls rather than being pushed, it can never be overwhelmed — it just falls further behind.',
  },
  lake: {
    title: 'Data Lake',
    kind: 'S3 + Iceberg + Parquet',
    about:
      'Three layers. S3 is cheap object storage with no capacity limit. Parquet is the file format: columnar and compressed, so a query reads only the columns it needs. Iceberg is the table format: metadata that says which files make up the table, giving atomic commits, snapshots and time travel. Frequent commits create many small files, which must be compacted or queries slow down.',
  },
  clickhouse: {
    title: 'OLAP Database',
    kind: 'Analytical database',
    about:
      'A columnar database built for fast aggregations over billions of rows. It ingests from Kafka in batches; each batch becomes an immutable "part" that background merges combine. Queries, inserts and merges all compete for the same CPU, so heavy dashboards can starve ingestion.',
  },
  trino: {
    title: 'Lake Query Engine',
    kind: 'SQL over files in the data lake',
    about:
      'Answers ad-hoc SQL questions by reading Parquet files straight out of the data lake. It stores no data of its own, so compute and storage scale separately. Slower per query than the OLAP database, but it can reach all history cheaply.',
  },
  bi: {
    title: 'Dashboards',
    kind: 'BI tools and analysts',
    about:
      'The people and dashboards asking questions of the data. Real-time panels need answers in milliseconds from fresh data (ClickHouse); ad-hoc analysis tolerates seconds but wants all history (Trino on the lake).',
  },
  queue: {
    title: 'Job Queue',
    kind: 'Message queue',
    about:
      'Holds slow background work (emails, image resizing) so web requests can return quickly. It absorbs bursts: depth grows when jobs arrive faster than workers finish them. A queue hides overload for a while — it does not fix it.',
  },
  worker: {
    title: 'Workers',
    kind: 'Background job processors',
    about:
      'Pull jobs off the queue one at a time. Throughput scales with the number of workers, so this tier is easy to scale horizontally.',
  },
  cdn: {
    title: 'CDN',
    kind: 'Content delivery network',
    about:
      'Thousands of caching servers close to users. Images, scripts and video are fetched once from your origin and then served from the edge, so most bytes never touch your load balancer or web servers. How much it absorbs is the cache hit ratio, which depends on how long objects may be cached (the TTL) and how popular they are. Remove it and every one of those bytes has to squeeze through your web servers\' network cards.',
  },
  blob: {
    title: 'Object Storage',
    kind: 'Blob store for media and static assets',
    about:
      'Where the files live: uploaded photos and videos, plus the site\'s scripts and stylesheets. Each object is stored under a key, replicated across zones, and fetched over HTTP. Capacity is unlimited and you pay per GB stored, per request and per GB read out to the internet. It is the CDN\'s origin: only cache misses and uploads reach it.',
  },
};

NODE_INFO.fn = {
  title: 'Functions',
  kind: 'Event-driven serverless functions',
  about:
    'Small pieces of code the cloud runs in response to events, with no server of yours. Here an upload landing in object storage triggers one (resize the photo, start a transcode), and it can also be connected to the job queue to take jobs alongside the workers. Capacity is counted in concurrent executions, the first event after a quiet spell pays a cold start, and you are billed per invocation and per second of run time.',
};

function makeNode(id, type, extra = {}) {
  return {
    id,
    type,
    label: NODE_INFO[type].title,
    active: true,
    down: false,
    downFor: 0,
    stress: 0, // 0..1, crash at 1
    queue: 0,
    inRate: 0,
    outRate: 0,
    dropRate: 0,
    latency: 0,
    util: 0, // headline load figure 0..1+
    cpu: 0,
    mem: 0,
    disk: 0,
    net: 0,
    bps: 0, // network throughput, bits / second
    diskIO: 0, // disk throughput, bytes / second
    status: '',
    crashes: 0,
    ...extra,
  };
}

export class Sim {
  constructor() {
    this.params = {
      traffic: 600, // requests / second
      writePct: 10, // % of requests that write
      workerCount: 2,
      ...AUTO_PARAMS, // traffic pattern + autoscaling settings (autoscale.js)
      autoRestart: true,
      tech: { ...DEFAULT_TECH }, // which concrete technology each kind of component is
      queryRate: 10, // analytics queries / second
      compaction: true, // Iceberg small-file compaction
      ...WORKLOAD,
      pricing: 'ondemand', // key of PRICING in tech.js: how instance-hours are bought
      spotWorkers: false, // run worker VMs on spot capacity (changes cost only)
      ...DATA_DEFAULTS, // dbReplicas, dbShards, cacheNodes (datatier.js)
    };
    this.listeners = { crash: [], recover: [], log: [] };
    Object.assign(this.params, ASSET_DEFAULTS); // static asset / media profile, see cdn.js
    this.reset();
  }

  on(evt, fn) {
    this.listeners[evt].push(fn);
  }
  emit(evt, ...a) {
    this.listeners[evt].forEach((f) => f(...a));
  }

  reset() {
    const n = {};
    n.client = makeNode('client', 'client');
    n.lb = makeNode('lb', 'lb');
    this.webs = [];
    for (let i = 0; i < MAX_WEB; i++) {
      const w = makeNode('web' + i, 'web', { label: 'Web Server ' + (i + 1), index: i, threads: 0 });
      w.active = i < 2;
      n[w.id] = w;
      this.webs.push(w);
    }
    n.cache = makeNode('cache', 'cache', { warm: 1, hitRatio: 0.85, missRate: 0 });
    n.db = makeNode('db', 'db', { diskUsed: 0.35, readRate: 0, writeRate: 0, conns: 0, readOnly: false });
    n.kafka = makeNode('kafka', 'kafka', { lag: 0, expiredRate: 0, partitions: [0, 0, 0] });
    n.consumer = makeNode('consumer', 'consumer');
    n.queue = makeNode('queue', 'queue');
    n.worker = makeNode('worker', 'worker');
    n.kafka.lagCH = 0;
    // data tier (datatier.js): machines lost from the cluster, failover countdown, unreplicated writes
    Object.assign(n.cache, { lostNodes: 0, rejoinIn: 0 });
    Object.assign(n.db, { lostNodes: 0, rejoinIn: 0, failover: 0, replBacklog: 0, replLag: 0 });
    n.lake = makeNode('lake', 'lake', { serverless: true, managedDisk: true, storedGB: 1240, smallFiles: 0, bigFiles: 3200, files: 3200, snapshots: 8600, putRate: 0, getRate: 0, ingestBytes: 0 });
    n.clickhouse = makeNode('clickhouse', 'clickhouse', { parts: 20, diskGB: 380, insertRate: 0, tooManyParts: false });
    n.trino = makeNode('trino', 'trino', { cost: 2 });
    n.bi = makeNode('bi', 'bi');
    const objects = this.params.assetObjects;
    n.cdn = makeNode('cdn', 'cdn', { warm: 1, hitRatio: 0, hit: 0, missRate: 0, edgeBytes: 0, storedGB: 0 });
    n.blob = makeNode('blob', 'blob', { objects, storedGB: (objects * this.params.assetKB) / 1e6, putRate: 0, getRate: 0 });
    this.assets = newAssetStats();
    n.fn = makeNode('fn', 'fn', { warm: 0, concurrency: 0, coldPct: 0, upRate: 0, jobRate: 0, limit: 0 });
    this.nodes = n;
    for (const type in this.params.tech) this.setTech(type, this.params.tech[type], true);
    // every sensible connection starts wired up
    this.edges = new Set();
    for (const id in n) for (const e of this.possibleEdges(id)) if (!OPTIONAL_EDGES.has(e.id)) this.edges.add(e.id);
    this.time = 0;
    this.spike = 0;
    this.flows = {}; // link id → rate, read by the renderer
    this.totals = { in: 0, ok: 0, err: 0, latency: 0, errPct: 0 };
    this.bottleneck = null;
    this.history = {};
    this._histAcc = 0;
    initReliability(this); // percentiles, retries and SLO state (latency.js)
  }

  // Rebuild the system from a preset: components, technologies and traffic shape.
  applyPreset(preset) {
    Object.assign(this.params, WORKLOAD, DATA_DEFAULTS, preset.params, preset.workload, preset.data, { tech: { ...DEFAULT_TECH, ...preset.tech } });
    this.reset();
    while (this.webCount < preset.webs) this.setActive(this.webs.find((w) => !w.active).id, true);
    for (const id of preset.remove) this.nodes[id].active = false;
  }

  techOf(type) {
    return TECH[type][this.params.tech[type]];
  }

  // Swap the concrete technology behind every component of one kind.
  setTech(type, key, quiet = false) {
    const t = TECH[type] && TECH[type][key];
    if (!t) return;
    this.params.tech[type] = key;
    for (const id in this.nodes) {
      const node = this.nodes[id];
      if (node.type !== type) continue;
      Object.assign(node, { tech: t, kind: t.kind, about: t.about, spec: t.spec || null, serverless: !!t.serverless, managedDisk: !!t.managedDisk, restartSecs: t.restart || 8 });
      node.queue = node.stress = 0;
      // databases are known by their product name
      if (type === 'db' || type === 'clickhouse' || type === 'fn') node.label = t.name;
      if (type === 'db') node.diskUsed = 0.35;
      if (type === 'clickhouse') Object.assign(node, { parts: t.parts ? 20 : 0, tooManyParts: false });
    }
    if (!quiet) this.emit('log', 'good', `${NODE_INFO[type].title} is now ${t.name}`);
  }

  // Every connection this node could have, as { id: 'from>to', other, out }.
  possibleEdges(id) {
    const node = this.nodes[id];
    const out = [];
    for (const [a, b] of EDGE_TYPES)
      for (const oid in this.nodes) {
        const o = this.nodes[oid];
        if (node.type === a && o.type === b) out.push({ id: `${id}>${oid}`, other: o, out: true });
        if (node.type === b && o.type === a) out.push({ id: `${oid}>${id}`, other: o, out: false });
      }
    return out;
  }

  // Returns the edge id if these two components can be wired together, else null.
  canConnect(aId, bId) {
    const e = this.possibleEdges(aId).find((x) => x.other.id === bId);
    return e ? e.id : null;
  }

  toggleEdge(edgeId, on = !this.edges.has(edgeId)) {
    if (on) this.edges.add(edgeId);
    else this.edges.delete(edgeId);
    const [a, b] = edgeId.split('>').map((x) => this.nodes[x].label);
    this.emit('log', on ? 'good' : 'warn', `${on ? 'Connected' : 'Disconnected'} ${a} → ${b}`);
    return on;
  }

  // Add or remove a component. `wired` connects it to everything sensible; otherwise it starts with no connections.
  setActive(id, on, wired = true) {
    const node = this.nodes[id];
    if (node.active === on) return;
    node.active = on;
    node.down = false;
    node.queue = node.stress = node.outRate = node.inRate = node.dropRate = node.util = 0;
    if (node.type === 'cache') node.warm = 0;
    if (on) for (const e of this.possibleEdges(id)) wired && !OPTIONAL_EDGES.has(e.id) ? this.edges.add(e.id) : this.edges.delete(e.id);
    this.emit('log', on ? 'good' : 'warn', `${node.label} ${on ? 'added' : 'removed'}`);
  }

  // Quick add/remove of a fully wired web server (the +/- stepper).
  addWeb() {
    const w = this.webs.find((x) => !x.active);
    if (w) this.setActive(w.id, true);
    return w;
  }
  removeWeb() {
    const act = this.webs.filter((x) => x.active);
    if (act.length > 1) this.setActive(act[act.length - 1].id, false);
  }

  // Components that are not currently in the diagram, one per type.
  placeable() {
    const seen = {};
    for (const id in this.nodes) {
      const n = this.nodes[id];
      if (!n.active && !seen[n.type]) seen[n.type] = n;
    }
    return Object.values(seen);
  }

  get webCount() {
    return this.webs.filter((w) => w.active).length;
  }

  triggerSpike() {
    this.spike = 6;
    this.emit('log', 'warn', 'Traffic spike: 4× load for 6 seconds');
  }

  kill(id, reason = 'Killed manually') {
    const node = this.nodes[id];
    if (!node || node.down || !node.active) return;
    if (partialLoss(this, node, reason)) return; // a cache cluster or replicated database loses one machine, not the whole tier
    if (node.lostNodes || node.failover) node.lostNodes = node.failover = 0; // the whole tier is gone and restarts as one
    node.down = true;
    node.downFor = 0;
    node.queue = 0;
    node.stress = 0;
    node.crashes++;
    if (node.type === 'cache') node.warm = 0;
    this.emit('crash', node, reason);
    this.emit('log', 'crit', `${node.label} crashed — ${reason}`);
  }

  restart(id) {
    const node = this.nodes[id];
    if (!node || !node.down) return;
    node.down = false;
    node.stress = 0;
    node.queue = 0;
    if (node.type === 'cache') node.warm = node.tech.persist; // what survived the restart
    this.emit('recover', node);
    this.emit('log', 'good', `${node.label} restarted`);
  }

  // Bring back machines lost from the cache cluster or the database's replica set.
  heal(id) {
    heal(this, id);
  }

  freeDisk() {
    this.nodes.db.diskUsed = Math.min(this.nodes.db.diskUsed, 0.35);
    this.emit('log', 'good', 'Database storage expanded');
  }

  // Shared overload → crash logic. `over` is arrival ÷ capacity.
  _stress(node, saturated, over, dt, reason) {
    if (saturated && over > 1) node.stress += (dt * Math.min(over - 1, 2.5)) / 3;
    else node.stress -= dt / 4;
    node.stress = clamp(node.stress);
    if (node.stress >= 1) this.kill(node.id, reason);
  }

  step(dt) {
    const p = this.params;
    const N = this.nodes;
    this.time += dt;
    this.spike = Math.max(0, this.spike - dt);

    for (const id in N) {
      const node = N[id];
      if (node.down) {
        node.downFor += dt;
        if (p.autoRestart && node.downFor > node.restartSecs) this.restart(id);
      }
    }

    const E = this.edges;
    const off = (n) => n.down || !n.active; // crashed or not in the diagram
    const JOB_FRAC = p.jobFrac; // share of requests that enqueue a background job
    // workload assumptions are params: these shadow the module-level defaults for the whole step
    const REQ_BYTES = p.reqBytes;
    const EVENT_BYTES = p.eventBytes;
    N.cache.hitRatio = p.cacheHitRatio;

    // ---------- clients ----------
    const wobble = 1 + 0.05 * Math.sin(this.time * 1.7) + 0.03 * Math.sin(this.time * 5.3);
    const shape = trafficShape(this, dt); // daily cycle / ramp / flash crowd (autoscale.js); 1 when steady
    const incoming = p.traffic * wobble * (this.spike > 0 ? 4 : 1) * shape + this.rel.retryRate; // + client retries of last step's failures
    const client = N.client;
    client.inRate = client.outRate = incoming;
    client.util = clamp(incoming / 20000);
    client.cpu = 0.05 + 0.1 * client.util;
    client.mem = 0.3;
    client.disk = 0.2;
    client.bps = incoming * REQ_BYTES * 8;

    // ---------- static assets + media: CDN → object storage (see cdn.js) ----------
    assetTraffic(this, incoming - this.rel.retryRate, dt, NIC_BPS); // a retried API call does not re-fetch the page's assets

    // ---------- load balancer ----------
    const lb = N.lb;
    const LB_CAP = this.techOf('lb').cap;
    lb.cap = LB_CAP;
    lb.inRate = incoming;
    const alive = this.webs.filter((w) => !off(w) && E.has(`lb>${w.id}`));
    let lbOut = off(lb) || !E.has('client>lb') || !alive.length ? 0 : Math.min(incoming, LB_CAP);
    lb.outRate = lbOut;
    lb.dropRate = incoming - lbOut;
    lb.util = off(lb) ? 0 : incoming / LB_CAP;
    lb.cpu = off(lb) ? 0 : clamp(0.03 + lb.util * 0.9);
    lb.mem = off(lb) ? 0 : clamp(0.12 + lb.util * 0.3);
    lb.disk = 0.08;
    lb.bps = incoming * REQ_BYTES * 8;
    lb.latency = 0.001;
    lb.status = off(lb)
      ? 'Down — nothing can reach the web tier.'
      : !alive.length
        ? 'No healthy web servers to route to. Every request fails with 503.'
        : `Routing across ${alive.length} healthy server${alive.length > 1 ? 's' : ''}.`;
    addAssetLoad(lb); // assets falling back to the origin path when there is no CDN

    // ---------- web servers ----------
    // autoscaling (autoscale.js): run the scaling policy; servers still launching leave `alive` and take no traffic
    if (!scaleWeb(this, dt, alive, lbOut)) lbOut = 0;
    const db = N.db;
    const cache = N.cache;
    const cacheUp = !off(cache);
    const kafkaUp = !off(N.kafka);
    const queueUp = !off(N.queue);
    const wf = p.writePct / 100;
    // Latency a web thread spends waiting on its downstream call.
    // Queries give up after QUERY_TIMEOUT; a dead database refuses connections fast.
    const QUERY_TIMEOUT = 0.25;
    const FAIL_FAST = 0.001; // no route: the call errors immediately
    const dbLat = off(db) ? 0.05 : Math.min(db.latency, QUERY_TIMEOUT);
    const hit = cacheUp ? cache.hitRatio * cache.warm : 0;

    const webTech = this.techOf('web');
    const WEB_CPU_CAP = p.webRps * webTech.capMul; // rps one server can handle
    const WEB_QMAX = 2400;
    const SVC = p.svcTime;
    let webServed = 0;
    let webDrop = 0;
    let webLatSum = 0;
    // where each server's work goes depends on what it is wired to
    let cacheLookups = 0;
    let cacheHits = 0;
    let cacheToDb = 0;
    let dbReadsArr = 0;
    let writes = 0;
    let noRoute = 0;
    let eventsIn = 0;
    let jobsArr = 0;
    for (const w of this.webs) {
      if (w.launching > 0) continue; // still booting (autoscale.js)
      if (off(w)) {
        w._cache = w._db = w._events = w._jobs = 0;
        w.inRate = w.outRate = w.dropRate = w.util = w.cpu = w.mem = w.bps = 0;
        w.status = off(w) ? 'Process is dead. The load balancer has stopped sending it traffic.' : '';
        continue;
      }
      const arr = alive.includes(w) ? lbOut / alive.length : 0;
      const viaCache = cacheUp && E.has(`${w.id}>cache`);
      const dbLink = db.active && E.has(`${w.id}>db`);
      const missViaCache = viaCache && db.active && E.has('cache>db');
      const missOK = viaCache ? missViaCache || dbLink : dbLink;
      const hitW = viaCache ? hit : 0;
      const downstream = (1 - wf) * (hitW * 0.001 + (1 - hitW) * (missOK ? dbLat : FAIL_FAST)) + wf * (dbLink ? dbLat : FAIL_FAST);
      // the same three paths, kept apart for the percentile maths: [share, mean seconds, waits on the database]
      w._mix = [[(1 - wf) * hitW, SVC + 0.001, false], [(1 - wf) * (1 - hitW), SVC + (missOK ? dbLat : FAIL_FAST), missOK], [wf, SVC + (dbLink ? dbLat : FAIL_FAST), dbLink]];
      const threadCap = WEB_THREADS / (SVC + downstream);
      // no two machines are identical: the weakest one tips over first
      const cpuCap = WEB_CPU_CAP * (1 - 0.035 * w.index);
      const cap = Math.min(cpuCap, threadCap);
      w.queue += arr * dt;
      const served = Math.min(w.queue, cap * dt);
      w.queue -= served;
      let dropped = 0;
      if (w.queue > WEB_QMAX) {
        dropped = w.queue - WEB_QMAX;
        w.queue = WEB_QMAX;
      }
      const rate = served / dt;
      w.inRate = arr;
      w.cap = cap;
      w.outRate = ease(w.outRate, rate, dt, 0.15);
      w.dropRate = ease(w.dropRate, dropped / dt, dt, 0.15);
      w.latency = SVC + downstream + w.queue / cap;
      w.util = arr / cap;
      w.threads = clamp((rate * (SVC + downstream)) / WEB_THREADS);
      w.cpu = ease(w.cpu, clamp(0.04 + (rate / cpuCap) * 0.96), dt);
      w.mem = ease(w.mem, clamp(0.22 + 0.2 * w.threads + 0.58 * (w.queue / WEB_QMAX)), dt);
      w.disk = 0.18;
      w.bps = rate * REQ_BYTES * 8;
      w.latency += w.coldLat || 0; // serverless cold start on a just-added environment (autoscale.js)
      const threadBound = threadCap < cpuCap;
      w.status =
        w.util < 0.7
          ? 'Healthy. Plenty of headroom.'
          : w.util < 1
            ? 'Running hot. Latency climbs as requests start to wait for a free core.'
            : threadBound
              ? 'Thread pool exhausted: every thread is blocked waiting on the slow database. CPU is idle but nothing can get through.'
              : webTech.noCrash
                ? 'At its concurrency limit. Extra requests are rejected with 429 — but the platform cannot be knocked over.'
                : 'CPU saturated. Requests queue in memory; when the queue fills they are rejected with 503 and memory heads for an out-of-memory kill.';
      if (webTech.noCrash) w.stress = 0; // the platform sheds load instead of dying
      else this._stress(w, w.queue >= WEB_QMAX * 0.98, w.util, dt, threadBound ? 'out of memory (threads stuck waiting on the database)' : 'out of memory (request backlog)');
      webServed += rate;
      const rd = rate * (1 - wf);
      const wr = rate * wf;
      const miss = rd * (1 - hitW);
      w._cache = viaCache ? rd : 0;
      w._db = (dbLink ? wr : 0) + (missOK && !missViaCache ? miss : 0);
      w._events = kafkaUp && E.has(`${w.id}>kafka`) ? rate : 0;
      w._jobs = queueUp && E.has(`${w.id}>queue`) ? rate * JOB_FRAC : 0;
      cacheLookups += w._cache;
      cacheHits += rd * hitW;
      if (missOK) dbReadsArr += miss;
      else noRoute += miss;
      if (missViaCache) cacheToDb += miss;
      if (dbLink) writes += wr;
      else noRoute += wr;
      eventsIn += w._events;
      jobsArr += w._jobs;
      addAssetLoad(w); // asset bytes this server streams when there is no CDN
      if (!dbLink && !viaCache) w.status = 'Not connected to a database or cache, so it has nowhere to read or write data. Every request fails.';
      else if (!dbLink) w.status = 'No database connection: cached reads work, but every write fails.';
      webDrop += dropped / dt;
      webLatSum += w.latency * rate;
    }
    const webLat = webServed > 0 ? webLatSum / webServed : 0;

    // ---------- cache ----------
    const reads = cacheLookups;
    const CACHE_CAP = CACHE_NODE_CAP * cacheCluster(this, dt); // per node × nodes up
    if (cacheUp) {
      const served = reads;
      // warms up as traffic repopulates it (~10s at normal load)
      cache.warm = clamp(cache.warm + (dt * clamp(served / 300, 0, 1)) / 10);
      cache.inRate = reads;
      cache.outRate = cacheHits;
      cache.missRate = reads - cacheHits;
      cache.util = reads / CACHE_CAP;
      cache.cpu = ease(cache.cpu, clamp(0.02 + cache.util * 0.9), dt);
      cache.mem = ease(cache.mem, 0.1 + 0.72 * cache.warm, dt, 0.2);
      cache.disk = 0.05;
      cache.bps = reads * 4e3 * 8;
      cache.latency = 0.001;
      cache.status =
        cache.warm < 0.6
          ? `Cold cache: only ${Math.round(hit * 100)}% of reads hit. The rest stampede to the database while it warms up.`
          : `Warm. ${Math.round(hit * 100)}% of reads are answered from RAM and never touch the database.`;
      // --- cache cluster (datatier.js)
      cache.cap = CACHE_CAP;
      cache.status = cacheStatus(cache, hit) || cache.status;
    } else {
      cache.inRate = cache.outRate = cache.missRate = cache.util = cache.cpu = cache.bps = 0;
      cache.mem = ease(cache.mem, 0, dt, 0.2);
      if (!off(cache)) cache.warm = 0;
      cache.status = off(cache)
        ? 'Down. All reads now go straight to the database, and the cache will come back empty.'
        : '';
    }

    // ---------- database ----------
    const eng = this.techOf('db');
    let DB_CAP = eng.cap; // cost units / s (a read = 1)
    let DB_QMAX = eng.qmax;
    const WRITE_COST = eng.writeCost;
    db.readOnly = !eng.managedDisk && db.diskUsed >= 0.999;
    let dbReadOk = 0;
    let dbWriteOk = 0;
    let dbFail = 0;
    // --- replicas, shards and failover (datatier.js): capacity of the whole tier for this read/write mix
    const tier = dbCluster(this, dt, dbReadsArr, db.readOnly ? 0 : writes);
    if (off(db)) {
      dbFail = dbReadsArr + writes;
      db.inRate = dbReadsArr + writes;
      db.outRate = db.readRate = db.writeRate = db.util = db.cpu = db.mem = db.bps = db.diskIO = db.conns = 0;
      db.latency = 1;
      db.status = 'Down. Cached reads still work; everything else fails.';
    } else {
      const wArr = db.readOnly ? 0 : writes - tier.failW;
      if (db.readOnly) dbFail += writes;
      dbFail += tier.failW; // writes to a shard whose primary is being replaced
      const units = dbReadsArr + wArr * WRITE_COST;
      DB_CAP = tier.cap;
      DB_QMAX = tier.qmax;
      db.queue += units * dt;
      const servedU = Math.min(db.queue, DB_CAP * dt);
      db.queue -= servedU;
      let droppedU = 0;
      if (db.queue > DB_QMAX) {
        droppedU = db.queue - DB_QMAX;
        db.queue = DB_QMAX;
      }
      const okFrac = units > 0 ? clamp(1 - droppedU / dt / units) : 1;
      dbReadOk = dbReadsArr * okFrac;
      dbWriteOk = wArr * okFrac;
      dbFail += (dbReadsArr + wArr) * (1 - okFrac);
      db.inRate = dbReadsArr + writes;
      db.readRate = ease(db.readRate, dbReadOk, dt, 0.2);
      db.writeRate = ease(db.writeRate, dbWriteOk, dt, 0.2);
      db.outRate = db.readRate + db.writeRate;
      db.dropRate = ease(db.dropRate, dbFail, dt, 0.15);
      db.util = units / DB_CAP;
      db.load = Math.min(units, DB_CAP);
      db.latency = 0.004 + db.queue / DB_CAP;
      db.conns = clamp(0.05 + 0.95 * (db.queue / DB_QMAX) + 0.2 * db.util);
      db.cpu = ease(db.cpu, clamp(0.05 + (servedU / dt / DB_CAP) * 0.95), dt);
      db.mem = ease(db.mem, clamp(0.55 + 0.4 * (db.queue / DB_QMAX)), dt);
      db.bps = (dbReadOk + dbWriteOk) * 8e3 * 8;
      // a write hits the log and the data file; most reads are served from the buffer pool
      db.diskIO = dbWriteOk * 16e3 + dbReadOk * 1e3;
      // each write stores data: by default ~1% of disk per 12,000 writes
      const grown = db.diskUsed + (dbWriteOk * dt * p.writeBytes) / 1e9 / eng.spec.diskGB / tier.S; // each shard stores its slice
      db.diskUsed = eng.managedDisk ? grown : clamp(grown);
      db.status = db.readOnly
        ? 'Disk full. The database has gone read-only: every write is rejected. Add storage to recover.'
        : db.util < 0.7
          ? 'Healthy. Queries return in a few milliseconds.'
          : db.util < 1
            ? 'Running hot. Query latency is climbing, which holds web server threads longer.'
            : eng.serverless
              ? 'Over provisioned capacity. Excess requests are throttled at once — they fail fast instead of queuing, and nothing crashes.'
              : eng.crash
                ? 'Overloaded. Queries pile up, connections run out, and web servers stall waiting for answers.'
                : 'Overloaded. Latency climbs and requests time out; add nodes to add capacity.';
      db.status = dbStatus(db, tier, fmtDur) || db.status;
      if (eng.crash) this._stress(db, db.queue >= DB_QMAX * 0.98, db.util, dt, eng.crash);
      else db.stress = 0;
    }
    db.disk = eng.managedDisk ? 0 : db.diskUsed;
    db.storedGB = db.diskUsed * eng.spec.diskGB;
    db.maxConns = eng.conns;
    db.capUnits = eng.cap;
    db.writeCost = eng.writeCost;
    // --- data tier: figures for the whole fleet (datatier.js)
    db.storedGB *= tier.S;
    db.maxConns = eng.conns * tier.nodes;
    db.capUnits = DB_CAP;

    // ---------- kafka → two consumer groups (lake writer, ClickHouse) ----------
    const kafka = N.kafka;
    const consumer = N.consumer;
    const lake = N.lake;
    const ch = N.clickhouse;
    const trino = N.trino;
    const bi = N.bi;
    const KAFKA_CAP = this.techOf('kafka').cap;
    const RETENTION = this.techOf('kafka').retention; // unread messages kept
    const writer = this.techOf('consumer');
    const CONSUME_CAP = writer.cap;
    kafka.cap = KAFKA_CAP;
    kafka.retention = RETENTION;
    consumer.cap = CONSUME_CAP;
    const produced = off(kafka) ? 0 : Math.min(eventsIn, KAFKA_CAP);
    kafka.inRate = eventsIn;
    kafka.dropRate = eventsIn - produced;

    // Dashboards: 90% of queries are real-time panels on ClickHouse, 10% are ad-hoc SQL on the lake via Trino.
    const qTotal = off(bi) ? 0 : p.queryRate * (1 + 0.08 * Math.sin(this.time * 0.9));
    const chQArr = E.has('bi>clickhouse') ? qTotal * 0.9 : 0;
    const trQArr = E.has('bi>trino') ? qTotal * 0.1 : 0;

    // ClickHouse shares one CPU budget: queries take what they need, inserts and merges get what is left.
    const olap = this.techOf('clickhouse');
    const CH_CORES = olap.cores;
    const CH_Q_COST = olap.qCost; // core-seconds per dashboard query
    const CH_ROWS_PER_CORE = 1500;
    const CH_QMAX = olap.qmax;
    const CH_PARTS_LIMIT = 300;
    const chQCap = (CH_CORES - 1) / CH_Q_COST;
    let chServed = 0;
    let chFree = 0;
    let chInsertCap = 0;
    if (!off(ch)) {
      ch.queue += chQArr * dt;
      const served = Math.min(ch.queue, chQCap * dt);
      ch.queue -= served;
      let dropped = 0;
      if (ch.queue > CH_QMAX) {
        dropped = ch.queue - CH_QMAX;
        ch.queue = CH_QMAX;
      }
      ch.dropRate = ease(ch.dropRate, dropped / dt, dt, 0.2);
      chServed = served / dt;
      chFree = Math.max(0, CH_CORES - chServed * CH_Q_COST);
      if (ch.parts > CH_PARTS_LIMIT) ch.tooManyParts = true;
      else if (ch.parts < CH_PARTS_LIMIT / 2) ch.tooManyParts = false;
      chInsertCap = (olap.shared ? Math.min(olap.insertMax, chFree * 0.75 * CH_ROWS_PER_CORE) : olap.insertMax) * (ch.tooManyParts ? 0.1 : 1) * (E.has('kafka>clickhouse') ? 1 : 0);
    }

    // Each consumer group keeps its own position in the log, so each has its own lag.
    let expired = 0;
    const consume = (key, cap) => {
      if (off(kafka)) return 0;
      kafka[key] += produced * dt;
      const c = Math.min(kafka[key] / dt, cap);
      kafka[key] -= c * dt;
      if (kafka[key] > RETENTION) {
        expired += kafka[key] - RETENTION;
        kafka[key] = RETENTION;
      }
      return c;
    };
    const consumed = consume('lag', off(consumer) || off(lake) || !E.has('kafka>consumer') || !E.has('consumer>lake') ? 0 : CONSUME_CAP);
    const inserted = consume('lagCH', chInsertCap);
    const maxLag = Math.max(kafka.lag, kafka.lagCH);
    if (!off(kafka)) {
      kafka.expiredRate = ease(kafka.expiredRate, expired / dt, dt, 0.2);
      kafka.outRate = consumed + inserted;
      kafka.util = produced / KAFKA_CAP;
      kafka.cpu = ease(kafka.cpu, clamp(0.04 + kafka.util * 0.8), dt);
      kafka.mem = 0.35;
      kafka.disk = clamp(0.12 + 0.86 * (maxLag / RETENTION));
      kafka.bps = (produced + consumed + inserted) * EVENT_BYTES * 8;
      kafka.diskIO = (produced + consumed + inserted) * EVENT_BYTES; // appended + read back
      for (let i = 0; i < 3; i++) kafka.partitions[i] = (maxLag / 3) * (1 + 0.06 * Math.sin(this.time * 0.7 + i * 2));
      kafka.status =
        kafka.expiredRate > 1
          ? 'Retention limit hit: the oldest unread events are being deleted before a consumer reaches them. That data is lost.'
          : maxLag > 2000
            ? `${kafka.lag > kafka.lagCH ? 'The lake writer' : ch.label} is falling behind: events are produced faster than it reads them. Nothing breaks yet — the log just gets longer.`
            : 'Healthy. Both consumer groups read events as fast as they are produced.';
    } else {
      kafka.outRate = kafka.util = kafka.cpu = kafka.bps = kafka.diskIO = kafka.expiredRate = 0;
      kafka.status = 'Down. Events are being dropped; web requests are unaffected because producing is asynchronous.';
    }

    // ---------- lake writer ----------
    consumer.inRate = consumer.outRate = consumed;
    consumer.util = off(consumer) ? 0 : produced / CONSUME_CAP;
    consumer.cpu = ease(consumer.cpu, off(consumer) ? 0 : clamp(0.04 + (consumed / CONSUME_CAP) * 0.96), dt);
    consumer.mem = off(consumer) ? 0 : 0.4;
    consumer.disk = 0.3;
    consumer.bps = consumed * EVENT_BYTES * 8 * (1 + 1 / PARQUET_RATIO);
    consumer.status = off(consumer)
      ? 'Down. Kafka keeps the events on disk, so it can catch up after a restart — if retention allows.'
      : off(lake)
        ? 'Cannot commit: object storage is unreachable. It has stopped reading from Kafka rather than lose data.'
        : consumer.util > 1
          ? 'Reading at full speed and still falling behind. Add writers (and partitions) to catch up.'
          : 'Batching events into Parquet files and committing them to the Iceberg table once a second.';

    // ---------- data lake: S3 + Iceberg + Parquet ----------
    const parquetBytes = (consumed * EVENT_BYTES) / PARQUET_RATIO;
    // how many small Parquet files appear per second depends on how the writer batches
    const commits = off(lake) ? 0 : writer.files * Math.min(1, consumed / 200);
    let compacted = 0;
    if (!off(lake)) {
      lake.storedGB += (parquetBytes * dt) / 1e9;
      lake.smallFiles += commits * dt;
      if (consumed > 1) lake.snapshots += dt;
      if (p.compaction) {
        compacted = Math.min(lake.smallFiles / dt, 8);
        lake.smallFiles -= compacted * dt;
        lake.bigFiles += (compacted * dt) / 40; // ~40 small files rewritten into one large one
      }
    }

    // ---------- trino (SQL on the lake) ----------
    const TR_CORES = 16;
    const TR_QMAX = 40;
    // Planning and opening every extra small file costs CPU: the "small files problem".
    const trTech = this.techOf('trino');
    trino.cost = (2 + lake.smallFiles * 0.02) * trTech.costMul; // core-seconds per query
    const trCap = TR_CORES / trino.cost;
    let trServed = 0;
    trino.inRate = trQArr;
    if (off(trino) || off(lake) || !E.has('trino>lake')) {
      trino.outRate = trino.util = trino.cpu = trino.bps = 0;
      trino.queue = 0;
      trino.dropRate = off(trino) ? 0 : trQArr;
      trino.mem = off(trino) ? 0 : 0.2;
      trino.latency = 0;
      trino.status = off(trino) ? 'Down. Ad-hoc queries on the lake fail; the data itself is safe in S3.' : 'Every query fails: the files it needs to read are in S3, which is unreachable.';
    } else {
      trino.queue += trQArr * dt;
      const served = Math.min(trino.queue, trCap * dt);
      trino.queue -= served;
      let dropped = 0;
      if (trino.queue > TR_QMAX) {
        dropped = trino.queue - TR_QMAX;
        trino.queue = TR_QMAX;
      }
      trServed = served / dt;
      trino.outRate = ease(trino.outRate, trServed, dt, 0.2);
      trino.dropRate = ease(trino.dropRate, dropped / dt, dt, 0.2);
      trino.cap = trCap;
      trino.util = trQArr / trCap;
      trino.cpu = ease(trino.cpu, clamp(0.03 + (trServed * trino.cost) / TR_CORES), dt);
      trino.mem = ease(trino.mem, clamp(0.2 + 0.45 * trino.cpu + 0.35 * (trino.queue / TR_QMAX)), dt);
      trino.bps = trServed * 40e6 * 8; // ~40 MB of Parquet scanned per query
      trino.latency = trino.cost / 4 + trino.queue / trCap;
      trino.status =
        trino.util >= 1
          ? lake.smallFiles > 200
            ? 'Overloaded by small files: each query must open thousands of tiny Parquet files. Turn on compaction.'
            : 'Overloaded. Queries wait for a free slot; when the queue fills they are rejected.'
          : lake.smallFiles > 200
            ? 'Slowing down: the table has many small files, so every query spends longer planning and opening them.'
            : 'Healthy. Reads only the columns and files each query needs, straight from S3.';
      if (trTech.noCrash) trino.stress = 0;
      else this._stress(trino, trino.queue >= TR_QMAX * 0.98, trino.util, dt, 'out of memory (too many concurrent queries)');
    }
    trino.disk = 0.12;

    lake.inRate = consumed;
    lake.putRate = commits + compacted / 40;
    lake.getRate = trServed * (24 + lake.smallFiles * 0.2);
    lake.outRate = lake.getRate;
    lake.ingestBytes = off(lake) ? 0 : parquetBytes;
    lake.files = Math.round(lake.bigFiles + lake.smallFiles);
    lake.util = off(lake) ? 0 : Math.min(0.95, lake.smallFiles / 330);
    lake.bps = off(lake) ? 0 : parquetBytes * 8 + trino.bps;
    lake.cpu = lake.mem = lake.disk = 0;
    lake.status = off(lake)
      ? 'S3 outage. Nothing is lost, but the writer cannot commit and no query can read.'
      : lake.smallFiles > 200
        ? `Small files problem: ${Math.round(lake.smallFiles)} tiny Parquet files are waiting to be merged. Every query has to open them all.`
        : p.compaction
          ? 'Healthy. Compaction keeps merging the small files each commit creates into large ones.'
          : 'Compaction is off. Every commit adds small files and nothing merges them.';

    // ---------- clickhouse ----------
    ch.inRate = produced;
    if (!off(ch)) {
      const mergeRate = 6 * clamp(chFree / CH_CORES, 0.03, 1); // parts merged away per second
      const partsIn = inserted > 1 ? 1 + inserted / 2500 : 0; // each insert block lands as a new part
      ch.parts = olap.parts ? Math.max(12, ch.parts + (partsIn - mergeRate) * dt) : 0;
      ch.insertRate = ease(ch.insertRate, inserted, dt, 0.2);
      ch.insertCap = chInsertCap;
      ch.outRate = ease(ch.outRate, chServed, dt, 0.2);
      ch.qCap = chQCap;
      const insertCores = olap.shared ? inserted / CH_ROWS_PER_CORE : 0; // loading runs elsewhere on a warehouse
      const mergeCores = olap.shared ? Math.min(1.5, chFree * 0.25) : 0;
      ch.util = (chQArr * CH_Q_COST + (olap.shared ? Math.min(produced, 9000) / CH_ROWS_PER_CORE + 1.5 : 0)) / CH_CORES;
      ch.qmax = CH_QMAX;
      ch.partsModel = olap.parts;
      ch.storedGB = ch.diskGB;
      ch.cpu = ease(ch.cpu, clamp((chServed * CH_Q_COST + insertCores + mergeCores) / CH_CORES), dt);
      ch.mem = ease(ch.mem, clamp(0.28 + 0.2 * ((chServed * CH_Q_COST) / CH_CORES) + 0.5 * (ch.queue / CH_QMAX)), dt);
      ch.diskGB += (inserted * EVENT_BYTES * dt) / 8 / 1e9; // ~8× columnar compression
      ch.disk = olap.managedDisk ? 0 : clamp(ch.diskGB / olap.spec.diskGB);
      ch.diskIO = (inserted * EVENT_BYTES * 4) / 8 + chServed * 5e6; // inserts + merge rewrites + scans
      ch.bps = inserted * EVENT_BYTES * 8 + chServed * 200e3 * 8;
      ch.latency = olap.baseLat / clamp(chFree / CH_CORES, 0.08, 1) + ch.queue / chQCap;
      ch.status = ch.tooManyParts
        ? 'Too many parts: inserts created parts faster than background merges could combine them, so inserts are being throttled.'
        : chQArr >= chQCap
          ? olap.shared
            ? 'Query overload. Queries queue for CPU; ingestion and merges are starved, so dashboards show stale data.'
            : 'Warehouse saturated. Queries wait in line for compute; loading is unaffected because it runs separately.'
          : kafka.lagCH > 2000
            ? 'Ingestion is behind: queries are using CPU that inserts need, or events are arriving faster than it can insert.'
            : olap.shared
              ? 'Healthy. Inserting from Kafka in batches and answering dashboard queries in milliseconds.'
              : `Healthy. Loading from Kafka about ${olap.ingestDelay}s behind real time; queries take around ${fmtDur(olap.baseLat)}.`;
      if (olap.crash) this._stress(ch, ch.queue >= CH_QMAX * 0.98, chQArr / chQCap, dt, 'out of memory (too many concurrent queries)');
      else ch.stress = 0;
    } else {
      ch.outRate = ch.insertRate = ch.util = ch.cpu = ch.mem = ch.bps = ch.diskIO = 0;
      ch.dropRate = chQArr;
      ch.status = 'Down. Dashboards cannot load; Kafka holds the events until it comes back.';
    }

    // ---------- dashboards ----------
    bi.inRate = bi.outRate = qTotal;
    bi.util = clamp(qTotal / 250);
    bi.cpu = off(bi) ? 0 : 0.06 + 0.3 * bi.util;
    bi.mem = off(bi) ? 0 : 0.3;
    bi.disk = 0.2;
    bi.bps = (chServed * 200e3 + trServed * 500e3) * 8;
    bi.chLatency = off(ch) ? Infinity : ch.latency;
    bi.trLatency = off(trino) || off(lake) ? Infinity : trino.latency;
    bi.freshCH = olap.ingestDelay + kafka.lagCH / Math.max(produced, 50);
    bi.freshLake = kafka.lag / Math.max(produced, 50);
    bi.failRate = ch.dropRate + trino.dropRate;
    bi.status = off(bi)
      ? 'Down. Nobody is looking at the data.'
      : bi.failRate > 0.5
        ? 'Queries are failing. Analysts see errors and spinning dashboards.'
        : bi.freshCH > 30
          ? `Dashboards load, but the numbers are ${fmtDur(bi.freshCH)} out of date because ingestion is behind.`
          : `Healthy. Real-time panels read ${ch.label}; ad-hoc SQL goes through Trino to the lake.`;

    // ---------- queue + workers ----------
    const queue = N.queue;
    const worker = N.worker;
    const Q_MAX = this.techOf('queue').qmax;
    const WORKER_RATE = p.jobRate * this.techOf('worker').rateMul;
    queue.qmax = Q_MAX;
    worker.cap = p.workerCount * WORKER_RATE;
    const jobsIn = jobsArr;
    const workCap = off(worker) || !E.has('queue>worker') ? 0 : p.workerCount * WORKER_RATE;
    // functions wired to the queue poll it too; one job holds one execution environment as long as it holds a worker core
    const JOB_SECS = WORKER_RATE > 0 ? SPECS.worker.cores / WORKER_RATE : 0.03;
    const fnCap = fnJobCapacity(this, dt, JOB_SECS);
    let fnJobs = 0;
    queue.inRate = jobsArr;
    let jobsDone = 0;
    let jobsDropped = off(queue) ? queue.inRate : 0;
    if (!off(queue)) {
      queue.queue += jobsIn * dt;
      jobsDone = Math.min(queue.queue / dt, workCap + fnCap);
      fnJobs = Math.max(0, jobsDone - workCap); // the machines are already paid for, so they take jobs first
      queue.queue -= jobsDone * dt;
      if (queue.queue > Q_MAX) {
        jobsDropped = (queue.queue - Q_MAX) / dt;
        queue.queue = Q_MAX;
      }
      queue.util = queue.queue / Q_MAX;
      queue.cpu = ease(queue.cpu, clamp(0.03 + jobsIn / 4000), dt);
      queue.mem = clamp(0.1 + 0.88 * queue.util);
      queue.disk = clamp(0.1 + 0.5 * queue.util);
      queue.bps = (jobsIn + jobsDone) * 4e3 * 8;
      queue.latency = workCap + fnCap > 0 ? queue.queue / (workCap + fnCap) : Infinity;
      queue.status =
        queue.util >= 0.99
          ? 'Queue is full. New jobs are rejected and lost.'
          : queue.queue > 200
            ? `Backlog growing: jobs arrive faster than workers finish them. A new job now waits ~${fmtDur(queue.latency)}.`
            : 'Healthy. Jobs are picked up almost immediately.';
    } else {
      queue.util = queue.cpu = queue.bps = 0;
      queue.status = 'Down. Background jobs are being lost.';
    }
    queue.outRate = jobsDone;
    // broker's view of its consumers: who is subscribed, and jobs handed out but not yet acknowledged
    // Each worker machine runs one consumer process per core, all subscribed to the same queue.
    const PER_WORKER = SPECS.worker.cores;
    queue.machines = workCap > 0 ? p.workerCount : 0;
    queue.consumers = queue.machines * PER_WORKER;
    queue.inflight = off(queue) || !WORKER_RATE ? 0 : ((jobsDone - fnJobs) / WORKER_RATE) * PER_WORKER;
    queue.fnJobs = fnJobs;
    functions(this, dt, fnJobs, JOB_SECS, ease);
    queue.dropRate = ease(queue.dropRate, jobsDropped, dt, 0.2);
    worker.inRate = worker.outRate = jobsDone - fnJobs;
    worker.util = workCap > 0 ? jobsIn / workCap : 0;
    worker.cpu = ease(worker.cpu, workCap > 0 ? clamp(0.03 + ((jobsDone - fnJobs) / workCap) * 0.97) : 0, dt);
    worker.mem = off(worker) ? 0 : 0.35 + 0.2 * worker.cpu;
    worker.disk = 0.15;
    worker.bps = jobsDone * 50e3 * 8;
    worker.status = off(worker)
      ? 'Down. The queue keeps accepting jobs but nothing drains it.'
      : worker.util > 1
        ? `All ${p.workerCount} workers are busy. Add workers to drain the queue faster.`
        : `${p.workerCount} worker${p.workerCount > 1 ? 's' : ''} keeping up.`;
    scaleWorkers(this, dt); // autoscaling on queue depth (autoscale.js); changes p.workerCount for the next step

    // network utilisation = bits on the wire ÷ link speed
    for (const id in N) {
      const node = N[id];
      if (off(node)) node.bps = node.diskIO = 0;
      // a component with no live connections does nothing
      else if (node.type !== 'client' && !this.possibleEdges(id).some((e) => E.has(e.id) && e.other.active))
        node.status = 'Not connected to anything. Use “Connect” to wire it to another component.';
      node.net = clamp(node.bps / NIC_BPS[node.type]);
    }

    // ---------- totals ----------
    const ok = cacheHits + dbReadOk + dbWriteOk;
    const err = Math.max(0, incoming - lbOut) + webDrop + dbFail + noRoute;
    const t = this.totals;
    t.in = ease(t.in, incoming, dt, 0.2);
    t.ok = ease(t.ok, ok, dt, 0.3);
    t.err = ease(t.err, err, dt, 0.3);
    t.errPct = t.ok + t.err > 0 ? t.err / (t.ok + t.err) : 0;
    t.latency = ease(t.latency, webServed > 0 ? Math.min(webLat, 10) : 0, dt, 0.3);

    // ---------- latency percentiles, client timeouts + retries, SLO ----------
    reliability(this, dt, incoming, ok, err);

    // ---------- flows for the renderer ----------
    const f = this.flows;
    f['client>lb'] = incoming;
    for (const w of this.webs) {
      f[`lb>${w.id}`] = alive.includes(w) ? lbOut / alive.length : 0;
      f[`${w.id}>cache`] = w._cache;
      f[`${w.id}>db`] = w._db;
      f[`${w.id}>kafka`] = w._events;
      f[`${w.id}>queue`] = w._jobs;
    }
    f['cache>db'] = cacheToDb;
    f['kafka>consumer'] = consumed;
    f['kafka>clickhouse'] = inserted;
    f['consumer>lake'] = consumed;
    f['bi>clickhouse'] = off(ch) ? 0 : chQArr;
    f['bi>trino'] = off(trino) ? 0 : trQArr;
    f['trino>lake'] = lake.getRate;

    // Return traffic: '<' is a successful response travelling back, '!' is an error response.
    const dbOkFrac = dbReadsArr + writes > 0 ? (dbReadOk + dbWriteOk) / (dbReadsArr + writes) : 0;
    f['client>lb<'] = ok;
    f['client>lb!'] = err;
    for (const w of this.webs) {
      f[`lb>${w.id}<`] = alive.includes(w) ? ok / alive.length : 0;
      f[`${w.id}>cache<`] = f[`${w.id}>cache`];
      f[`${w.id}>db<`] = f[`${w.id}>db`] * dbOkFrac;
    }
    f['cache>db<'] = cacheToDb * dbOkFrac;
    f['bi>clickhouse<'] = chServed;
    f['bi>trino<'] = trServed;
    f['trino>lake<'] = lake.getRate;
    f['queue>worker'] = jobsDone - fnJobs;
    f['queue>fn'] = fnJobs;
    f['blob>fn'] = N.fn.upRate;

    this._findBottleneck();

    this._histAcc += dt;
    if (this._histAcc >= 0.25) {
      this._histAcc = 0;
      this._record();
    }
  }

  _findBottleneck() {
    let worst = null;
    for (const id in this.nodes) {
      const n = this.nodes[id];
      if (!n.active || n.type === 'client') continue;
      const score = n.down ? 5 : n.type === 'queue' ? (n.queue > 200 ? 0.95 + n.util : 0) : n.util;
      // nodes on the request path matter more than async side-channels
      const onPath = n.type === 'lb' || n.type === 'web' || n.type === 'cache' || n.type === 'db';
      if (score >= 0.9 && (!worst || onPath > worst.onPath || (onPath === worst.onPath && score > worst.score)))
        worst = { node: n, score, onPath };
    }
    this.bottleneck = worst ? worst.node : null;
  }

  _record() {
    const push = (key, v) => {
      const a = (this.history[key] ||= []);
      a.push(v);
      if (a.length > HISTORY) a.shift();
    };
    push('in', this.totals.in);
    push('ok', this.totals.ok);
    push('err', this.totals.err);
    push('latency', this.totals.latency * 1000);
    recordReliability(this, push);
    for (const id in this.nodes) {
      const n = this.nodes[id];
      push(id + '.cpu', n.cpu * 100);
      push(id + '.mem', n.mem * 100);
      push(id + '.disk', n.disk * 100);
      push(id + '.net', n.net * 100);
      push(id + '.rate', n.outRate);
    }
  }
}

export function fmtDur(s) {
  if (!isFinite(s)) return '∞';
  if (s < 1) return Math.round(s * 1000) + ' ms';
  if (s < 90) return s.toFixed(1) + ' s';
  return Math.round(s / 60) + ' min';
}

// Network throughput is quoted in bits per second (decimal prefixes).
export function fmtBits(bps) {
  if (bps >= 1e9) return parseFloat((bps / 1e9).toFixed(2)) + ' Gbps';
  if (bps >= 1e6) return (bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1) + ' Mbps';
  return Math.round(bps / 1e3) + ' kbps';
}

// Disk throughput is quoted in bytes per second.
export function fmtBytes(Bps) {
  if (Bps >= 1e9) return (Bps / 1e9).toFixed(2) + ' GB/s';
  if (Bps >= 1e6) return (Bps / 1e6).toFixed(1) + ' MB/s';
  return Math.round(Bps / 1e3) + ' kB/s';
}

export function fmtRate(v) {
  if (v >= 10000) return (v / 1000).toFixed(1) + 'k';
  if (v >= 1000) return (v / 1000).toFixed(2) + 'k';
  return Math.round(v).toString();
}
