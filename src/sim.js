// Rate-based ("fluid") simulation of a small web service.
// Every node has a capacity, a bounded backlog, and four hardware resources
// (cpu / mem / disk / net, each 0..1). Overload fills the backlog, a full
// backlog sheds load, and sustained overload crashes the node.

export const MAX_WEB = 6;
export const HISTORY = 240; // samples kept per metric (4 per second → 60s)

// Average bytes on the wire per HTTP request (request + response) and per Kafka event.
const REQ_BYTES = 20e3;
const EVENT_BYTES = 2e3;
const PARQUET_RATIO = 6; // raw JSON events → compressed columnar Parquet
// Link speed of each machine's network card, in bits per second.
export const NIC_BPS = { client: 10e9, lb: 10e9, web: 1e9, cache: 1e9, db: 1e9, kafka: 1e9, consumer: 1e9, queue: 1e9, worker: 1e9, lake: 10e9, clickhouse: 10e9, trino: 10e9, bi: 1e9 };

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
};

export function fmtGB(gb) {
  if (gb >= 1000) return parseFloat((gb / 1000).toFixed(2)) + ' TB';
  if (gb >= 100) return Math.round(gb) + ' GB';
  if (gb >= 1) return parseFloat(gb.toFixed(1)) + ' GB';
  return Math.round(gb * 1000) + ' MB';
}

// "used / total" in real units for one of a node's four resources.
export function rawMetric(node, key, params) {
  if (node.type === 'lake' && key !== 'net') return key === 'disk' ? `${fmtGB(node.storedGB)} stored · no fixed limit` : 'managed by the cloud provider';
  const spec = SPECS[node.type];
  const n = node.type === 'worker' ? params.workerCount : 1;
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
    title: 'Database',
    kind: 'Primary SQL database',
    about:
      'The source of truth. Writes cost about 4× a read because they must hit disk durably. Every write also consumes storage, and a full disk makes the database refuse writes. It is the hardest tier to scale, so it is usually the real bottleneck.',
  },
  kafka: {
    title: 'Kafka',
    kind: 'Event stream (append-only log)',
    about:
      'Every request appends an event to a partitioned log on disk. Producers never wait for consumers: if the consumer is slow, unread messages simply pile up as "lag". Messages older than the retention limit are deleted — read or not.',
  },
  consumer: {
    title: 'Lake Writer',
    kind: 'Stream processor (e.g. Flink)',
    about:
      'Reads events from Kafka at its own pace, batches them into Parquet files and commits them to the Iceberg table. Because it pulls rather than being pushed, it can never be overwhelmed — it just falls further behind.',
  },
  lake: {
    title: 'Data Lake',
    kind: 'S3 + Iceberg + Parquet',
    about:
      'Three layers. S3 is cheap object storage with no capacity limit. Parquet is the file format: columnar and compressed, so a query reads only the columns it needs. Iceberg is the table format: metadata that says which files make up the table, giving atomic commits, snapshots and time travel. Frequent commits create many small files, which must be compacted or queries slow down.',
  },
  clickhouse: {
    title: 'ClickHouse',
    kind: 'Real-time OLAP database',
    about:
      'A columnar database built for fast aggregations over billions of rows. It ingests from Kafka in batches; each batch becomes an immutable "part" that background merges combine. Queries, inserts and merges all compete for the same CPU, so heavy dashboards can starve ingestion.',
  },
  trino: {
    title: 'Trino',
    kind: 'Lake query engine',
    about:
      'Runs SQL directly on the Parquet files in the lake — it stores nothing itself. Compute and storage are separate, so you can scale either alone. Slower than ClickHouse per query, but it can reach all history cheaply.',
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
      webCount: 2,
      workerCount: 2,
      cacheEnabled: true,
      autoRestart: true,
      queryRate: 10, // analytics queries / second
      compaction: true, // Iceberg small-file compaction
    };
    this.listeners = { crash: [], recover: [], log: [] };
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
      w.active = i < this.params.webCount;
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
    n.lake = makeNode('lake', 'lake', { storedGB: 1240, smallFiles: 0, bigFiles: 3200, files: 3200, snapshots: 8600, putRate: 0, getRate: 0, ingestBytes: 0 });
    n.clickhouse = makeNode('clickhouse', 'clickhouse', { parts: 20, diskGB: 380, insertRate: 0, tooManyParts: false });
    n.trino = makeNode('trino', 'trino', { cost: 2 });
    n.bi = makeNode('bi', 'bi');
    this.nodes = n;
    this.time = 0;
    this.spike = 0;
    this.flows = {}; // link id → rate, read by the renderer
    this.totals = { in: 0, ok: 0, err: 0, latency: 0, errPct: 0 };
    this.bottleneck = null;
    this.history = {};
    this._histAcc = 0;
  }

  triggerSpike() {
    this.spike = 6;
    this.emit('log', 'warn', 'Traffic spike: 4× load for 6 seconds');
  }

  kill(id, reason = 'Killed manually') {
    const node = this.nodes[id];
    if (!node || node.down) return;
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
    this.emit('recover', node);
    this.emit('log', 'good', `${node.label} restarted`);
  }

  freeDisk() {
    this.nodes.db.diskUsed = 0.35;
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
        if (p.autoRestart && node.downFor > 8) this.restart(id);
      }
    }

    // ---------- clients ----------
    const wobble = 1 + 0.05 * Math.sin(this.time * 1.7) + 0.03 * Math.sin(this.time * 5.3);
    const incoming = p.traffic * wobble * (this.spike > 0 ? 4 : 1);
    const client = N.client;
    client.inRate = client.outRate = incoming;
    client.util = clamp(incoming / 20000);
    client.cpu = 0.05 + 0.1 * client.util;
    client.mem = 0.3;
    client.disk = 0.2;
    client.bps = incoming * REQ_BYTES * 8;

    // ---------- load balancer ----------
    const lb = N.lb;
    const LB_CAP = 50000;
    lb.inRate = incoming;
    this.webs.forEach((w, i) => (w.active = i < p.webCount));
    const alive = this.webs.filter((w) => w.active && !w.down);
    let lbOut = lb.down || !alive.length ? 0 : Math.min(incoming, LB_CAP);
    lb.outRate = lbOut;
    lb.dropRate = incoming - lbOut;
    lb.util = lb.down ? 0 : incoming / LB_CAP;
    lb.cpu = lb.down ? 0 : clamp(0.03 + lb.util * 0.9);
    lb.mem = lb.down ? 0 : clamp(0.12 + lb.util * 0.3);
    lb.disk = 0.08;
    lb.bps = incoming * REQ_BYTES * 8;
    lb.latency = 0.001;
    lb.status = lb.down
      ? 'Down — nothing can reach the web tier.'
      : !alive.length
        ? 'No healthy web servers to route to. Every request fails with 503.'
        : `Routing across ${alive.length} healthy server${alive.length > 1 ? 's' : ''}.`;

    // ---------- web servers ----------
    const db = N.db;
    const cache = N.cache;
    const cacheUp = p.cacheEnabled && !cache.down;
    cache.active = p.cacheEnabled;
    const wf = p.writePct / 100;
    // Latency a web thread spends waiting on its downstream call.
    // Queries give up after QUERY_TIMEOUT; a dead database refuses connections fast.
    const QUERY_TIMEOUT = 0.25;
    const dbLat = db.down ? 0.05 : Math.min(db.latency, QUERY_TIMEOUT);
    const hit = cacheUp ? cache.hitRatio * cache.warm : 0;
    const downstream = (1 - wf) * (hit * 0.001 + (1 - hit) * dbLat) + wf * dbLat;

    const WEB_CPU_CAP = 1200; // rps one server's CPU can handle
    const WEB_THREADS = 256;
    const WEB_QMAX = 2400;
    const SVC = 0.02;
    let webServed = 0;
    let webDrop = 0;
    let webLatSum = 0;
    for (const w of this.webs) {
      if (!w.active || w.down) {
        w.inRate = w.outRate = w.dropRate = w.util = w.cpu = w.mem = w.bps = 0;
        w.status = w.down ? 'Process is dead. The load balancer has stopped sending it traffic.' : '';
        continue;
      }
      const arr = lbOut / alive.length;
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
      const threadBound = threadCap < cpuCap;
      w.status =
        w.util < 0.7
          ? 'Healthy. Plenty of headroom.'
          : w.util < 1
            ? 'Running hot. Latency climbs as requests start to wait for a free core.'
            : threadBound
              ? 'Thread pool exhausted: every thread is blocked waiting on the slow database. CPU is idle but nothing can get through.'
              : 'CPU saturated. Requests queue in memory; when the queue fills they are rejected with 503 and memory heads for an out-of-memory kill.';
      this._stress(w, w.queue >= WEB_QMAX * 0.98, w.util, dt, threadBound ? 'out of memory (threads stuck waiting on the database)' : 'out of memory (request backlog)');
      webServed += rate;
      webDrop += dropped / dt;
      webLatSum += w.latency * rate;
    }
    const webLat = webServed > 0 ? webLatSum / webServed : 0;

    // ---------- cache ----------
    const reads = webServed * (1 - wf);
    const writes = webServed * wf;
    const CACHE_CAP = 30000;
    let cacheHits = 0;
    let dbReadsArr = reads;
    if (cacheUp) {
      const served = Math.min(reads, CACHE_CAP);
      cacheHits = served * hit;
      dbReadsArr = reads - cacheHits;
      // warms up as traffic repopulates it (~10s at normal load)
      cache.warm = clamp(cache.warm + (dt * clamp(served / 300, 0, 1)) / 10);
      cache.inRate = reads;
      cache.outRate = cacheHits;
      cache.missRate = dbReadsArr;
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
    } else {
      cache.inRate = cache.outRate = cache.missRate = cache.util = cache.cpu = cache.bps = 0;
      cache.mem = ease(cache.mem, 0, dt, 0.2);
      if (!cache.down) cache.warm = 0;
      cache.status = cache.down
        ? 'Down. All reads now go straight to the database, and the cache will come back empty.'
        : 'Disabled. Every read goes to the database.';
    }

    // ---------- database ----------
    const DB_CAP = 4000; // cost units / s (read = 1, write = 4)
    const DB_QMAX = 3000;
    const WRITE_COST = 4;
    db.readOnly = db.diskUsed >= 0.999;
    let dbReadOk = 0;
    let dbWriteOk = 0;
    let dbFail = 0;
    if (db.down) {
      dbFail = dbReadsArr + writes;
      db.inRate = dbReadsArr + writes;
      db.outRate = db.readRate = db.writeRate = db.util = db.cpu = db.mem = db.bps = db.diskIO = db.conns = 0;
      db.latency = 1;
      db.status = 'Down. Cached reads still work; everything else fails.';
    } else {
      const wArr = db.readOnly ? 0 : writes;
      if (db.readOnly) dbFail += writes;
      const units = dbReadsArr + wArr * WRITE_COST;
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
      // each write stores data: ~1% of disk per 12,000 writes
      db.diskUsed = clamp(db.diskUsed + (dbWriteOk * dt) / 1.2e6);
      db.status = db.readOnly
        ? 'Disk full. The database has gone read-only: every write is rejected. Add storage to recover.'
        : db.util < 0.7
          ? 'Healthy. Queries return in a few milliseconds.'
          : db.util < 1
            ? 'Running hot. Query latency is climbing, which holds web server threads longer.'
            : 'Overloaded. Queries pile up, the connection pool is exhausted, and web servers stall waiting for answers.';
      this._stress(db, db.queue >= DB_QMAX * 0.98, db.util, dt, 'connection pool exhausted');
    }
    db.disk = db.diskUsed;

    // ---------- kafka → two consumer groups (lake writer, ClickHouse) ----------
    const kafka = N.kafka;
    const consumer = N.consumer;
    const lake = N.lake;
    const ch = N.clickhouse;
    const trino = N.trino;
    const bi = N.bi;
    const KAFKA_CAP = 25000;
    const RETENTION = 150000; // messages kept on disk
    const CONSUME_CAP = 3000;
    const produced = kafka.down ? 0 : Math.min(webServed, KAFKA_CAP);
    kafka.inRate = webServed;
    kafka.dropRate = webServed - produced;

    // Dashboards: 80% of queries are real-time panels on ClickHouse, 20% are ad-hoc SQL on the lake via Trino.
    const qTotal = bi.down ? 0 : p.queryRate * (1 + 0.08 * Math.sin(this.time * 0.9));
    const chQArr = qTotal * 0.8;
    const trQArr = qTotal * 0.2;

    // ClickHouse shares one CPU budget: queries take what they need, inserts and merges get what is left.
    const CH_CORES = 16;
    const CH_Q_COST = 0.11; // core-seconds per dashboard query
    const CH_ROWS_PER_CORE = 1500;
    const CH_QMAX = 150;
    const CH_PARTS_LIMIT = 300;
    const chQCap = (CH_CORES - 1) / CH_Q_COST;
    let chServed = 0;
    let chFree = 0;
    let chInsertCap = 0;
    if (!ch.down) {
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
      chInsertCap = Math.min(9000, chFree * 0.75 * CH_ROWS_PER_CORE) * (ch.tooManyParts ? 0.1 : 1);
    }

    // Each consumer group keeps its own position in the log, so each has its own lag.
    let expired = 0;
    const consume = (key, cap) => {
      if (kafka.down) return 0;
      kafka[key] += produced * dt;
      const c = Math.min(kafka[key] / dt, cap);
      kafka[key] -= c * dt;
      if (kafka[key] > RETENTION) {
        expired += kafka[key] - RETENTION;
        kafka[key] = RETENTION;
      }
      return c;
    };
    const consumed = consume('lag', consumer.down || lake.down ? 0 : CONSUME_CAP);
    const inserted = consume('lagCH', chInsertCap);
    const maxLag = Math.max(kafka.lag, kafka.lagCH);
    if (!kafka.down) {
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
            ? `${kafka.lag > kafka.lagCH ? 'The lake writer' : 'ClickHouse'} is falling behind: events are produced faster than it reads them. Nothing breaks yet — the log just gets longer.`
            : 'Healthy. Both consumer groups read events as fast as they are produced.';
    } else {
      kafka.outRate = kafka.util = kafka.cpu = kafka.bps = kafka.diskIO = kafka.expiredRate = 0;
      kafka.status = 'Down. Events are being dropped; web requests are unaffected because producing is asynchronous.';
    }

    // ---------- lake writer ----------
    consumer.inRate = consumer.outRate = consumed;
    consumer.util = consumer.down ? 0 : produced / CONSUME_CAP;
    consumer.cpu = ease(consumer.cpu, consumer.down ? 0 : clamp(0.04 + (consumed / CONSUME_CAP) * 0.96), dt);
    consumer.mem = consumer.down ? 0 : 0.4;
    consumer.disk = 0.3;
    consumer.bps = consumed * EVENT_BYTES * 8 * (1 + 1 / PARQUET_RATIO);
    consumer.status = consumer.down
      ? 'Down. Kafka keeps the events on disk, so it can catch up after a restart — if retention allows.'
      : lake.down
        ? 'Cannot commit: object storage is unreachable. It has stopped reading from Kafka rather than lose data.'
        : consumer.util > 1
          ? 'Reading at full speed and still falling behind. Add writers (and partitions) to catch up.'
          : 'Batching events into Parquet files and committing them to the Iceberg table once a second.';

    // ---------- data lake: S3 + Iceberg + Parquet ----------
    const parquetBytes = (consumed * EVENT_BYTES) / PARQUET_RATIO;
    // one small Parquet file per Kafka partition per commit
    const commits = lake.down ? 0 : 3 * Math.min(1, consumed / 200);
    let compacted = 0;
    if (!lake.down) {
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
    trino.cost = 2 + lake.smallFiles * 0.01; // core-seconds per query
    const trCap = TR_CORES / trino.cost;
    let trServed = 0;
    trino.inRate = trQArr;
    if (trino.down || lake.down) {
      trino.outRate = trino.util = trino.cpu = trino.bps = 0;
      trino.queue = 0;
      trino.dropRate = trino.down ? 0 : trQArr;
      trino.mem = trino.down ? 0 : 0.2;
      trino.latency = 0;
      trino.status = trino.down ? 'Down. Ad-hoc queries on the lake fail; the data itself is safe in S3.' : 'Every query fails: the files it needs to read are in S3, which is unreachable.';
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
      this._stress(trino, trino.queue >= TR_QMAX * 0.98, trino.util, dt, 'out of memory (too many concurrent queries)');
    }
    trino.disk = 0.12;

    lake.inRate = consumed;
    lake.putRate = commits + compacted / 40;
    lake.getRate = trServed * (24 + lake.smallFiles * 0.2);
    lake.outRate = lake.getRate;
    lake.ingestBytes = lake.down ? 0 : parquetBytes;
    lake.files = Math.round(lake.bigFiles + lake.smallFiles);
    lake.util = lake.down ? 0 : Math.min(0.95, lake.smallFiles / 800);
    lake.bps = lake.down ? 0 : parquetBytes * 8 + trino.bps;
    lake.cpu = lake.mem = lake.disk = 0;
    lake.status = lake.down
      ? 'S3 outage. Nothing is lost, but the writer cannot commit and no query can read.'
      : lake.smallFiles > 200
        ? `Small files problem: ${Math.round(lake.smallFiles)} tiny Parquet files are waiting to be merged. Every query has to open them all.`
        : p.compaction
          ? 'Healthy. Compaction keeps merging the small files each commit creates into large ones.'
          : 'Compaction is off. Each commit adds three small files and nothing merges them.';

    // ---------- clickhouse ----------
    ch.inRate = produced;
    if (!ch.down) {
      const mergeRate = 6 * clamp(chFree / CH_CORES, 0.03, 1); // parts merged away per second
      const partsIn = inserted > 1 ? 1 + inserted / 2500 : 0; // each insert block lands as a new part
      ch.parts = Math.max(12, ch.parts + (partsIn - mergeRate) * dt);
      ch.insertRate = ease(ch.insertRate, inserted, dt, 0.2);
      ch.insertCap = chInsertCap;
      ch.outRate = ease(ch.outRate, chServed, dt, 0.2);
      ch.qCap = chQCap;
      const insertCores = inserted / CH_ROWS_PER_CORE;
      const mergeCores = Math.min(1.5, chFree * 0.25);
      ch.util = (chQArr * CH_Q_COST + Math.min(produced, 9000) / CH_ROWS_PER_CORE + 1.5) / CH_CORES;
      ch.cpu = ease(ch.cpu, clamp((chServed * CH_Q_COST + insertCores + mergeCores) / CH_CORES), dt);
      ch.mem = ease(ch.mem, clamp(0.28 + 0.2 * ((chServed * CH_Q_COST) / CH_CORES) + 0.5 * (ch.queue / CH_QMAX)), dt);
      ch.diskGB += (inserted * EVENT_BYTES * dt) / 8 / 1e9; // ~8× columnar compression
      ch.disk = clamp(ch.diskGB / SPECS.clickhouse.diskGB);
      ch.diskIO = (inserted * EVENT_BYTES * 4) / 8 + chServed * 5e6; // inserts + merge rewrites + scans
      ch.bps = inserted * EVENT_BYTES * 8 + chServed * 200e3 * 8;
      ch.latency = 0.05 / clamp(chFree / CH_CORES, 0.08, 1) + ch.queue / chQCap;
      ch.status = ch.tooManyParts
        ? 'Too many parts: inserts created parts faster than background merges could combine them, so inserts are being throttled.'
        : chQArr >= chQCap
          ? 'Query overload. Queries queue for CPU; ingestion and merges are starved, so dashboards show stale data.'
          : kafka.lagCH > 2000
            ? 'Ingestion is behind: queries are using CPU that inserts need, or events are arriving faster than it can insert.'
            : 'Healthy. Inserting from Kafka in batches and answering dashboard queries in milliseconds.';
      this._stress(ch, ch.queue >= CH_QMAX * 0.98, chQArr / chQCap, dt, 'out of memory (too many concurrent queries)');
    } else {
      ch.outRate = ch.insertRate = ch.util = ch.cpu = ch.mem = ch.bps = ch.diskIO = 0;
      ch.dropRate = chQArr;
      ch.status = 'Down. Dashboards cannot load; Kafka holds the events until it comes back.';
    }

    // ---------- dashboards ----------
    bi.inRate = bi.outRate = qTotal;
    bi.util = clamp(qTotal / 250);
    bi.cpu = bi.down ? 0 : 0.06 + 0.3 * bi.util;
    bi.mem = bi.down ? 0 : 0.3;
    bi.disk = 0.2;
    bi.bps = (chServed * 200e3 + trServed * 500e3) * 8;
    bi.chLatency = ch.down ? Infinity : ch.latency;
    bi.trLatency = trino.down || lake.down ? Infinity : trino.latency;
    bi.freshCH = kafka.lagCH / Math.max(produced, 50);
    bi.freshLake = kafka.lag / Math.max(produced, 50);
    bi.failRate = ch.dropRate + trino.dropRate;
    bi.status = bi.down
      ? 'Down. Nobody is looking at the data.'
      : bi.failRate > 0.5
        ? 'Queries are failing. Analysts see errors and spinning dashboards.'
        : bi.freshCH > 30
          ? `Dashboards load, but the numbers are ${fmtDur(bi.freshCH)} out of date because ingestion is behind.`
          : 'Healthy. Real-time panels read ClickHouse; ad-hoc SQL goes through Trino to the lake.';

    // ---------- queue + workers ----------
    const queue = N.queue;
    const worker = N.worker;
    const JOB_FRAC = 0.15;
    const Q_MAX = 20000;
    const WORKER_RATE = 120;
    const jobsIn = queue.down ? 0 : webServed * JOB_FRAC;
    const workCap = worker.down ? 0 : p.workerCount * WORKER_RATE;
    queue.inRate = webServed * JOB_FRAC;
    let jobsDone = 0;
    let jobsDropped = queue.down ? queue.inRate : 0;
    if (!queue.down) {
      queue.queue += jobsIn * dt;
      jobsDone = Math.min(queue.queue / dt, workCap);
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
      queue.latency = workCap > 0 ? queue.queue / workCap : Infinity;
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
    queue.dropRate = ease(queue.dropRate, jobsDropped, dt, 0.2);
    worker.inRate = worker.outRate = jobsDone;
    worker.util = workCap > 0 ? jobsIn / workCap : 0;
    worker.cpu = ease(worker.cpu, workCap > 0 ? clamp(0.03 + (jobsDone / workCap) * 0.97) : 0, dt);
    worker.mem = worker.down ? 0 : 0.35 + 0.2 * worker.cpu;
    worker.disk = 0.15;
    worker.bps = jobsDone * 50e3 * 8;
    worker.status = worker.down
      ? 'Down. The queue keeps accepting jobs but nothing drains it.'
      : worker.util > 1
        ? `All ${p.workerCount} workers are busy. Add workers to drain the queue faster.`
        : `${p.workerCount} worker${p.workerCount > 1 ? 's' : ''} keeping up.`;

    // network utilisation = bits on the wire ÷ link speed
    for (const id in N) {
      const node = N[id];
      if (node.down) node.bps = node.diskIO = 0;
      node.net = clamp(node.bps / NIC_BPS[node.type]);
    }

    // ---------- totals ----------
    const ok = cacheHits + dbReadOk + dbWriteOk;
    const err = Math.max(0, incoming - lbOut) + webDrop + dbFail;
    const t = this.totals;
    t.in = ease(t.in, incoming, dt, 0.2);
    t.ok = ease(t.ok, ok, dt, 0.3);
    t.err = ease(t.err, err, dt, 0.3);
    t.errPct = t.ok + t.err > 0 ? t.err / (t.ok + t.err) : 0;
    t.latency = ease(t.latency, webServed > 0 ? Math.min(webLat, 10) : 0, dt, 0.3);

    // ---------- flows for the renderer ----------
    const f = this.flows;
    f['client>lb'] = incoming;
    const perWebRead = alive.length ? reads / alive.length : 0;
    const perWebWrite = alive.length ? writes / alive.length : 0;
    for (const w of this.webs) {
      const up = w.active && !w.down;
      f[`lb>${w.id}`] = up ? lbOut / alive.length : 0;
      f[`${w.id}>cache`] = up && cacheUp ? perWebRead : 0;
      f[`${w.id}>db`] = up ? perWebWrite + (cacheUp ? 0 : perWebRead) : 0;
      f[`${w.id}>kafka`] = up ? w.outRate : 0;
      f[`${w.id}>queue`] = up ? w.outRate * JOB_FRAC : 0;
    }
    f['cache>db'] = cacheUp ? dbReadsArr : 0;
    f['kafka>consumer'] = consumed;
    f['kafka>clickhouse'] = inserted;
    f['consumer>lake'] = consumed;
    f['bi>clickhouse'] = ch.down ? 0 : chQArr;
    f['bi>trino'] = trino.down ? 0 : trQArr;
    f['trino>lake'] = lake.getRate;
    f['queue>worker'] = jobsDone;

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
