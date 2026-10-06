import { TECH, priced } from './tech.js';
import { CACHE_NODE_CAP } from './datatier.js';

// What you trade when you pick one technology over another, for every option in the catalog:
// the things a price list does not show. `ops` is the work of running it, 1 (nothing to run)
// to 5 (a system of its own that needs people who know it). The capacity and cost figures shown
// beside these come from tech.js, so they cannot drift from what the simulation does.

export const OPS_WORDS = ['', 'Hands-off', 'Light', 'Moderate', 'Heavy', 'A team of its own'];
export const TARGET_UTIL = 0.7; // capacity is bought so the busiest unit runs at 70%

// T(ops, how it scales, what happens when it is overloaded or fails, what you gain, what you give up)
const T = (ops, scale, fail, gain, lose) => ({ ops, scale, fail, gain, lose });
const ONE_BOX = 'It is one machine: if it dies, nothing behind it is reachable until it restarts';

export const TRADE = {
  lb: {
    nginx: T(3, 'A bigger VM, or a second one behind a floating IP', ONE_BOX, ['Cheapest at any traffic level', 'Full control of routing, caching and TLS'], ['A single point of failure unless you run a pair', 'You patch it and renew its certificates']),
    haproxy: T(3, 'A bigger VM, or a second one behind a floating IP', ONE_BOX, ['Highest throughput per machine', 'The richest health checks and balancing algorithms'], ['A single point of failure unless you run a pair', 'You patch and monitor it']),
    envoy: T(4, 'More proxies, configured from a control plane', ONE_BOX, ['Configuration changes without restarts', 'Detailed per-request metrics; fits a service mesh'], ['More overhead per request', 'More moving parts to learn and run']),
    alb: T(1, 'Automatic, though a sudden 10× jump can outrun it for a few minutes', 'Runs in several zones; a failed zone is routed around', ['Nothing to run or patch', 'Survives the loss of a zone', 'Ties into autoscaling and managed certificates'], ['Billed per GB, so cost follows traffic', 'Less low-level tuning', 'AWS only']),
    gclb: T(1, 'Automatic, with no pre-warming', 'Served from Google\'s edge; a failed region is routed around', ['One global IP answered from the nearest location', 'Nothing to run or patch'], ['Billed per GB, so cost follows traffic', 'Google Cloud only']),
  },
  web: {
    ec2: T(3, 'Add machines: minutes to boot', 'Requests queue in memory until the process is killed', ['Cheapest at steady, high traffic', 'Any runtime, long-lived connections, local state'], ['You pay for idle capacity', 'Slow to react to a spike', 'You patch the operating system']),
    gce: T(3, 'Add machines: minutes to boot', 'Requests queue in memory until the process is killed', ['Cheapest at steady, high traffic', 'Any runtime, long-lived connections, local state'], ['You pay for idle capacity', 'Slow to react to a spike', 'You patch the operating system']),
    fargate: T(2, 'New containers in under a minute', 'A failed task is replaced in seconds', ['No hosts to patch', 'Scales out faster than VMs'], ['Costs more than the same VM', 'No access to the host']),
    gke: T(4, 'Pods in seconds, new nodes in a minute or two', 'Crashed pods restart in seconds', ['Packs many services densely onto shared machines', 'Fast restarts and rollouts', 'Portable between clouds'], ['Kubernetes is itself a system to learn and run', 'Cluster fee and a steady stream of upgrades']),
    lambda: T(1, 'Per request, at once; the first request to a new copy pays a cold start', 'Sheds excess load with 429s; there is nothing to crash', ['Nothing to run, and nothing to pay when idle', 'Absorbs spikes with no planning'], ['Costs more than a VM at steady, high traffic', 'Cold starts add latency', '15-minute limit; no long-lived connections', 'Every concurrent request opens its own database connection']),
    cloudrun: T(1, 'Per request, at once; new instances pay a cold start', 'Sheds excess load with 429s; there is nothing to crash', ['Runs any container and scales to zero', 'One instance serves many requests at a time'], ['Costs more than a VM at steady, high traffic', 'Cold starts add latency', 'Google Cloud only']),
    metal: T(5, 'Order, rack and cable a server: weeks', 'A hardware fault is fixed in hours, not seconds', ['Lowest cost per request at scale', 'Predictable performance: no neighbours'], ['Capacity is planned months ahead', 'Hardware failures are yours', 'Money is spent up front']),
  },
  cache: {
    redis: T(3, 'A bigger machine, or cluster mode', 'Restarts with about 60% of its keys, from the last snapshot', ['Rich data types: lists, sorted sets, counters, pub/sub', 'Can persist to disk'], ['One thread per shard', 'Failover and backups are yours']),
    memcached: T(2, 'Add nodes; clients spread keys across them', 'Restarts empty: every read misses until it warms up', ['The simplest cache there is', 'Multi-threaded and very fast for plain keys'], ['Nothing survives a restart', 'No replication', 'Strings only: no data structures']),
    elasticache: T(1, 'Add replicas or shards from the console', 'A replica is promoted in seconds; about 90% of keys survive', ['Automatic failover', 'Patching and backups are handled'], ['About twice the price: you pay for the standby', 'AWS only']),
    memorystore: T(1, 'Resize or add replicas from the console', 'A replica is promoted in seconds; about 90% of keys survive', ['Automatic failover', 'Patching and backups are handled'], ['Costs more per GB than a VM', 'Google Cloud only']),
  },
  db: {
    postgres: T(4, 'A bigger machine; replicas for reads; sharding is manual', 'Connections run out, queries pile up, then it falls over', ['Joins, transactions and constraints', 'The richest SQL and extension ecosystem', 'No licence and no lock-in'], ['Every write goes through one primary', 'Backups, failover and upgrades are yours', 'A connection is a whole process, so they are scarce']),
    mysql: T(4, 'A bigger machine; replicas for reads; sharding is manual', 'Too many connection threads exhaust memory and it is killed', ['Joins and transactions', 'Connections are cheap threads', 'Decades of operational know-how'], ['Every write goes through one primary', 'Backups, failover and upgrades are yours', 'Fewer advanced SQL features than PostgreSQL']),
    rds: T(2, 'Resize with a short outage; add read replicas', 'Same limits as PostgreSQL; a standby takes over in a minute or two', ['Backups, patching and failover are handled', 'It is still ordinary PostgreSQL'], ['Nearly twice the price of the same VM', 'No access to the host', 'Still one primary for writes']),
    aurora: T(2, 'Up to 15 replicas with almost no lag; storage grows by itself', 'Fails over in about 30 s; storage survives losing a zone', ['Replicas share one storage layer, so they barely lag', 'Fast failover', 'Storage grows on demand'], ['The most expensive relational option here', 'Still one primary for writes', 'AWS only']),
    cloudsql: T(2, 'Resize with a short outage; add read replicas', 'Same limits as PostgreSQL; a standby takes over in a minute or two', ['Backups, patching and failover are handled', 'It is still ordinary PostgreSQL'], ['Nearly twice the price of the same VM', 'Still one primary for writes', 'Google Cloud only']),
    spanner: T(1, 'Add nodes while it runs; it splits the data itself', 'Latency climbs; there is no single node to lose', ['Scales writes out and keeps SQL and transactions', 'Strongly consistent across regions'], ['High entry price: three nodes minimum', 'Every commit waits for a majority, so writes are slower', 'Google Cloud only']),
    cassandra: T(5, 'Add nodes; capacity grows in a straight line', 'Slows down; losing a node loses no data', ['A write costs no more than a read', 'No primary: any node takes writes', 'Scales out in a straight line'], ['No joins and no multi-row transactions', 'Eventually consistent unless you pay for quorum', 'Tables must be designed around the queries', 'Repairs and compaction are yours to run']),
    dynamodb: T(1, 'Raise provisioned capacity, or use on-demand mode', 'Throttles at once above its provisioned capacity; never crashes', ['Nothing to run', 'Single-digit milliseconds at any size', 'No connection limit'], ['No joins: data is reached by key or by an index you planned', 'You pay for throughput you provision, used or not', 'A hot key is throttled on its own', 'AWS only']),
    bigtable: T(2, 'Add nodes; capacity grows in a straight line', 'Latency climbs; nodes are replaced for you', ['Very high write throughput', 'Scales out in a straight line'], ['One index only: the row key', 'No transactions across rows', 'Three-node minimum price', 'Google Cloud only']),
  },
  queue: {
    rabbitmq: T(3, 'A bigger machine, or a cluster', 'The backlog lives in memory: when full it refuses jobs, and a crash can lose them', ['Routing, priorities and per-message acknowledgement', 'Cheap at a steady volume'], ['Depth is limited by one machine\'s memory', 'You run and monitor it']),
    redisq: T(2, 'A bigger Redis', 'In-memory lists: a crash loses jobs since the last snapshot', ['The simplest start: reuse the Redis you already have', 'Very fast'], ['The weakest durability here', 'Backlog is limited by memory', 'No routing or fan-out']),
    sqs: T(1, 'Automatic', 'Never fills up or crashes, so a backlog can grow unnoticed', ['Effectively unlimited depth', 'Stored across several zones', 'Delayed messages and dead-letter queues built in'], ['Billed per request', 'At-least-once: handlers must tolerate duplicates', 'No ordering unless you accept FIFO\'s lower throughput']),
    pubsub: T(1, 'Automatic', 'Never fills up or crashes, so a backlog can grow unnoticed', ['Effectively unlimited depth', 'One message can fan out to many subscribers'], ['Billed by data volume', 'At-least-once: handlers must tolerate duplicates', 'Google Cloud only']),
  },
  worker: {
    ec2: T(3, 'Add machines: minutes to boot', 'Jobs wait in the queue; a dead worker\'s job is delivered again', ['Cheapest for a steady stream of jobs', 'Long jobs, GPUs, lots of memory'], ['Idle machines still cost money', 'Slow to react to a burst']),
    gce: T(3, 'Add machines: minutes to boot', 'Jobs wait in the queue; a dead worker\'s job is delivered again', ['Cheapest for a steady stream of jobs', 'Long jobs, GPUs, lots of memory'], ['Idle machines still cost money', 'Slow to react to a burst']),
    lambda: T(1, 'Follows the backlog within seconds', 'Throttled at the concurrency limit; jobs wait in the queue', ['Scales with the queue, down to zero', 'No machines to run'], ['Costs more per job at a steady volume', '15-minute limit per job', 'A burst can flood the database with connections']),
    cloudrun: T(1, 'Follows the backlog within seconds', 'Throttled at the instance limit; jobs wait in the queue', ['Scales with the queue, down to zero', 'Runs any container'], ['Costs more per job at a steady volume', 'A burst can flood the database with connections', 'Google Cloud only']),
  },
  kafka: {
    kafka: T(5, 'Add brokers and move partitions: hours of careful work', 'Producers are refused above capacity; consumers simply fall behind', ['A replayable log that many consumers read independently', 'The most throughput per dollar'], ['Among the hardest systems to operate well', 'Partition counts are hard to change later']),
    msk: T(3, 'Add brokers from the console; you still rebalance partitions', 'Producers are refused above capacity; failed brokers are replaced', ['Real Kafka, with brokers patched and replaced for you'], ['You still size brokers and partitions', 'Costs more than running it yourself', 'AWS only']),
    kinesis: T(1, 'Add shards, or let on-demand mode do it', 'Writes are throttled shard by shard', ['No brokers to run', 'You pay roughly for what you use'], ['A shard takes only 1 MB/s, so scale means many shards', 'Short retention unless you pay for more', 'An AWS-only API']),
    pubsub: T(1, 'Automatic: no partitions or shards to size', 'Does not fill up; slow subscribers build a backlog', ['Nothing to size or run', 'Absorbs bursts by itself'], ['Ordering only per key, and only if you ask', 'Replay is weaker than a true log', 'Billed by data volume']),
  },
  consumer: {
    flink: T(4, 'Raise parallelism and restart from a checkpoint', 'Falls behind, then resumes from its last checkpoint', ['The lowest latency, with exactly-once results', 'Rich windows and state'], ['Commits every second, so the lake fills with small files', 'Demanding to run']),
    spark: T(4, 'Add executors', 'Falls behind, then resumes from its last checkpoint', ['Bigger batches mean fewer, larger files', 'The same engine as your batch jobs'], ['Data arrives seconds to minutes late', 'A cluster to run']),
    firehose: T(1, 'Automatic', 'Buffers and retries; nothing of yours to restart', ['Nothing to run', 'Writes large, well-sized files'], ['Buffers for about a minute before writing', 'Very little transformation logic', 'Billed per GB']),
    dataflow: T(2, 'Adds and removes workers by itself', 'Workers are replaced; it resumes where it stopped', ['Autoscaling workers', 'Exactly-once results'], ['Costs more than your own cluster', 'Google Cloud only']),
  },
  lake: {
    s3iceberg: T(2, 'No limit', 'Storage does not fail; too many small files slow every query', ['An open table format most engines can read', 'Snapshots and time travel'], ['Needs regular compaction', 'Queries take seconds, not milliseconds']),
    gcsiceberg: T(2, 'No limit', 'Storage does not fail; too many small files slow every query', ['An open table format most engines can read', 'Snapshots and time travel'], ['Needs regular compaction', 'Queries take seconds, not milliseconds']),
    s3delta: T(2, 'No limit', 'Storage does not fail; too many small files slow every query', ['At its best with Spark and Databricks', 'Snapshots and time travel'], ['Fewer engines support it fully', 'Needs regular compaction']),
  },
  clickhouse: {
    clickhouse: T(4, 'A bigger machine, or shards you manage', 'Queries and inserts fight for CPU; too many parts stops inserts', ['Sub-second queries on data seconds old', 'One machine goes a very long way', 'Reads Kafka by itself'], ['You run it', 'Background merges need care', 'Weak at large joins']),
    redshift: T(3, 'Resize the cluster', 'Queries queue; it does not fall over', ['A full SQL warehouse with joins', 'Reads Kafka by itself'], ['A cluster to size and pay for around the clock', 'Fresh data is about 10 s behind']),
    snowflake: T(1, 'Resize or add warehouses in seconds', 'Queries queue; loading is never slowed by them', ['Compute is separate from storage, so queries cannot starve loading', 'Almost nothing to administer'], ['Data is about 45 s behind', 'Needs a connector to read Kafka', 'Credits add up quickly']),
    bigquery: T(1, 'Automatic', 'Queries queue; nothing of yours to fall over', ['Nothing to size', 'Scans enormous tables in seconds'], ['Even a small query takes about a second', 'Needs a connector to read Kafka', 'Billed by data scanned and ingested', 'Google Cloud only']),
  },
  trino: {
    trino: T(4, 'Add workers', 'Queries queue; a heavy one can run out of memory and fail', ['Fast interactive SQL straight over the lake', 'Joins across different sources'], ['A cluster to size and run', 'It costs money while idle']),
    athena: T(1, 'Automatic', 'Queries queue at the account limit', ['No cluster', 'You pay only when a query runs'], ['Priced per TB scanned, so a careless query is expensive', 'Little control over tuning']),
    spark: T(4, 'Add executors', 'Slow, but a failed stage is retried instead of failing the query', ['Handles the largest joins and transformations', 'Long queries survive a lost machine'], ['Slow to start, so poor for dashboards', 'A cluster to size and run']),
  },
  bi: {
    grafana: T(2, 'One small server', 'Dashboards go stale when a source is down', ['Excellent for time series and alerting', 'Free'], ['Not built for ad-hoc business questions', 'You host it']),
    superset: T(3, 'One small server', 'Dashboards go stale when a source is down', ['SQL-first, with many chart types', 'Free'], ['You host and upgrade it', 'Rougher to use than paid tools']),
    metabase: T(2, 'One small server', 'Dashboards go stale when a source is down', ['The easiest for people who do not write SQL', 'Free'], ['Limited for complex data models', 'You host it']),
    tableau: T(1, 'Per user', 'Dashboards go stale when a source is down', ['The most powerful visual analysis'], ['A licence for every user', 'Proprietary']),
    quicksight: T(1, 'Per user', 'Dashboards go stale when a source is down', ['No servers', 'Cheap per reader'], ['Fewer features than the leaders', 'Works best inside AWS']),
    looker: T(1, 'Automatic', 'Dashboards go stale when a source is down', ['Free', 'No setup'], ['Every view runs warehouse queries that you pay for', 'Limited data modelling']),
  },
  cdn: {
    cloudfront: T(1, 'Automatic', 'A failed edge location is routed around', ['Fetching from S3 costs nothing', 'Fits the rest of AWS'], ['Costs more per GB than rivals at scale']),
    cloudcdn: T(1, 'Automatic', 'A failed edge location is routed around', ['Rides on Google\'s global load balancer', 'The per-GB price falls quickly with volume'], ['Charges for every cache fill', 'Google Cloud only']),
    cloudflare: T(1, 'Automatic', 'A failed edge location is routed around', ['A flat price with no per-GB bill at modest scale', 'Attack protection and firewall included'], ['Your cloud still bills the bytes it fetches from origin', 'Pricing at large scale is by private contract']),
    fastly: T(1, 'Automatic', 'A failed edge location is routed around', ['Purges take effect almost instantly', 'A programmable edge'], ['The highest per-GB price here', 'Your cloud still bills the bytes it fetches from origin']),
  },
  blob: {
    s3: T(1, 'No limit', 'Copies are kept in several zones', ['The default every tool supports', 'Many storage classes for colder data'], ['A fee for every GB read out to the internet']),
    gcs: T(1, 'No limit', 'Copies are kept in several zones', ['Slightly cheaper per GB stored', 'One API across storage classes'], ['A fee for every GB read out to the internet', 'Google Cloud only']),
    r2: T(1, 'No limit', 'Copies are kept in several locations', ['No fee for reading data out', 'Speaks the S3 API'], ['Fewer storage classes and features', 'Writes cost more per request']),
  },
  scheduler: {
    watcher: T(3, 'Add copies of the watcher', 'Jobs already handed to the queue still fire for the length of its look-ahead', ['Survives its own outage for the look-ahead window', 'Schedules tens of thousands of jobs a second'], ['More moving parts: it depends on a delay queue', 'A job created inside the window needs its own fast path']),
    cron: T(2, 'It does not: one machine, one loop', 'While it is down, the jobs due in that moment are missed', ['About as simple as scheduling gets'], ['A single point of failure', 'A few hundred jobs a second at most', 'No look-ahead: nothing covers an outage']),
  },
  connector: {
    kconnect: T(3, 'Add tasks and workers', 'When it stops, the warehouse goes stale while Kafka keeps the events', ['One framework for many destinations', 'Commits its place only after the warehouse accepts a batch'], ['One more cluster to run and watch', 'Adds a batching delay']),
  },
  fn: {
    lambda: T(1, 'New environments on demand, up to the concurrency limit', 'Throttles above the limit; refused events are retried', ['1,000 concurrent executions by default', 'Triggered by most AWS services'], ['15-minute limit per run', 'Cold starts', 'AWS only']),
    cloudfunctions: T(1, 'New instances on demand, up to the instance limit', 'Throttles above the limit; refused events are retried', ['Runs on Cloud Run, so any container runtime works'], ['100 instances by default, so a burst is throttled sooner', 'Cold starts', 'Google Cloud only']),
  },
};

// The load each kind of component is sized against, and what one unit of a technology can take.
// now(sim, node) is the whole tier's load (default: the node's arrival rate); own(node) is the
// share of it this one node carries, where a tier is several nodes (web servers).
const rate = (n) => n.inRate || 0;
const LOAD = {
  lb: { unit: 'req/s', floor: 5000, cap: (t) => t.cap, capText: (t) => `${fmt(t.cap)} req/s` },
  web: { unit: 'req/s', floor: 3000, now: (sim) => sim.nodes.lb.outRate || 0, own: (n) => n.inRate || 0, cap: (t, p) => p.webRps * t.capMul, capText: (t, p) => `${fmt(p.webRps * t.capMul)} req/s per ${t.serverless ? 'instance' : 'server'}` },
  cache: { unit: 'lookups/s', floor: 20000, cap: () => CACHE_NODE_CAP, capText: () => `${fmt(CACHE_NODE_CAP)} lookups/s per node` },
  db: { unit: 'query units/s', floor: 6000, now: (sim, n) => n.load || rate(n), cap: (t) => t.cap, capText: (t) => `${fmt(t.cap)} units/s per node · a write costs ${t.writeCost}` },
  queue: { unit: 'jobs/s', floor: 1000, capText: (t) => `holds ${fmt(t.qmax)} jobs` },
  worker: { unit: 'jobs/s', floor: 1000, cap: (t, p) => p.jobRate * t.rateMul, capText: (t, p) => `${fmt(p.jobRate * t.rateMul)} jobs/s per ${t.serverless ? 'unit' : 'worker'}` },
  kafka: { unit: 'events/s', floor: 10000, cap: (t) => t.cap, capText: (t) => `${fmt(t.cap)} events/s` },
  consumer: { unit: 'events/s', floor: 5000, cap: (t) => t.cap, capText: (t) => `${fmt(t.cap)} events/s` },
  lake: { unit: 'events/s', floor: 5000, capText: () => 'no fixed limit' },
  clickhouse: { unit: 'rows/s', floor: 5000, now: (sim, n) => n.insertRate || 0, cap: (t) => t.insertMax, capText: (t) => `${fmt(t.insertMax)} rows/s in · ${t.qmax} queries queued` },
  trino: { unit: 'queries/s', floor: 20, now: (sim, n) => n.outRate || 0, capText: () => 'by query cost, not a fixed rate' },
  bi: { unit: 'queries/s', floor: 20, now: (sim, n) => n.outRate || 0, capText: () => 'limited by what it queries' },
  cdn: { unit: 'objects/s', floor: 5000, capText: () => 'no practical limit' },
  blob: { unit: 'requests/s', floor: 500, capText: () => 'no practical limit' },
  scheduler: { unit: 'jobs/s', floor: 1000, now: (sim) => sim.params.schedRate, cap: (t) => t.cap, capText: (t) => `${fmt(t.cap)} jobs/s` },
  connector: { unit: 'rows/s', floor: 5000, cap: (t) => t.cap, capText: (t) => `${fmt(t.cap)} rows/s` },
  fn: { unit: 'invocations/s', floor: 200, now: (sim, n) => n.outRate || 0, capText: (t) => `${fmt(t.limit)} concurrent executions` },
};

function fmt(v) {
  return v >= 1e6 ? parseFloat((v / 1e6).toFixed(1)) + 'M' : v >= 1e4 ? parseFloat((v / 1e3).toFixed(1)) + 'k' : Math.round(v).toLocaleString();
}

// Everything on a node that grows in step with its load. Scaling these lets a cost function
// written for "the node as it is now" answer "and at three times the traffic?".
const FLOWS = ['inRate', 'outRate', 'bps', 'readRate', 'writeRate', 'insertRate', 'getRate', 'putRate', 'concurrency', 'upRate', 'jobRate', 'edgeBytes', 'fillBytes', 'diskIO', 'load'];

// One unit of `tech` carrying `load` of this node's kind of work → monthly cost of that unit.
function unitCost(sim, node, tech, load, own) {
  const n = { ...node, tech, fleet: 1 };
  if (own > 1e-6) {
    for (const f of FLOWS) if (typeof n[f] === 'number') n[f] *= load / own;
  } else n.inRate = n.outRate = load; // an idle node has nothing to scale: give it the bare rate
  try {
    return priced(n, { ...sim.params, workerCount: 1 }).monthly;
  } catch {
    return NaN;
  }
}

// Monthly cost of running `tech` for this node's tier at `load`, buying enough units to stay at
// TARGET_UTIL. Usage-priced services bill the load itself; machines are bought in whole units.
export function costAt(sim, node, tech, load, own) {
  const L = LOAD[node.type];
  const cap = L.cap ? L.cap(tech, sim.params) : Infinity;
  const units = isFinite(cap) && cap > 0 ? Math.max(1, Math.ceil(load / (cap * TARGET_UTIL))) : 1;
  const whole = unitCost(sim, node, tech, load, own);
  const more = unitCost(sim, node, tech, load * 2 + 100, own);
  const fixed = Math.abs(more - whole) <= 0.005 * Math.max(whole, 1); // price does not move with load: you buy machines
  return { monthly: fixed ? unitCost(sim, node, tech, load / units, own) * units : whole, units: fixed ? units : 0 };
}

const nice = (v) => {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v);
};

// The whole comparison for one node: every technology of its kind, costed across a range of load.
// → { type, unit, now, max, rows: [{ key, tech, current, monthly, units, capText, ...TRADE }], xs, cheapest: [{ key, from, to }] }
export function compare(sim, node) {
  const L = LOAD[node.type];
  const now = L.now ? L.now(sim, node) : rate(node);
  const own = L.own ? L.own(node) : now;
  const max = nice(Math.max(now * 4, L.floor));
  const N = 96;
  const xs = Array.from({ length: N + 1 }, (_, i) => (max * i) / N);
  const at = (tech, load) => costAt(sim, node, tech, load, own);
  const rows = Object.entries(TECH[node.type]).map(([key, tech]) => {
    const c = at(tech, now);
    return { key, tech, current: tech === node.tech, monthly: c.monthly, units: c.units, capText: L.capText(tech, sim.params), ys: xs.map((x) => at(tech, x).monthly), ...(TRADE[node.type] || {})[key] };
  });
  // which option is cheapest over which stretch of load
  const cheapest = [];
  xs.forEach((x, i) => {
    if (!i) return; // at zero load everything usage-priced is free; start from the first real sample
    const best = rows.reduce((a, b) => (b.ys[i] < a.ys[i] - 1e-9 ? b : a));
    const last = cheapest[cheapest.length - 1];
    if (last && last.key === best.key) last.to = x;
    else cheapest.push({ key: best.key, name: best.tech.name, from: i === 1 ? 0 : x, to: x });
  });
  return { type: node.type, unit: L.unit, now, max, xs, rows, cheapest };
}

export const hasChoice = (type) => !!TECH[type] && Object.keys(TECH[type]).length > 1;
export const fmtLoad = fmt;
