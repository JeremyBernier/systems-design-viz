// Scaling the data tier: read replicas, shards and failover for the OLTP database,
// and a multi-node cache cluster. No rendering and no imports; Sim.step calls in
// from its cache and database sections, and kill() asks partialLoss() first.
//
// The database node stands for `shards` identical groups, each one primary plus
// `replicas` read replicas. The busiest shard decides when the tier is full.
// Per-engine numbers (`repl`, `shard`) live with the engines in tech.js.

export const MAX_REPLICAS = 5; // RDS allows 5 (15 on Aurora); beyond that people shard or cache instead
export const SHARD_STEPS = [1, 2, 4, 8]; // shard counts double so a split only ever halves a shard
export const MAX_CACHE_NODES = 6;
export const CACHE_NODE_CAP = 30000; // lookups/s one cache node serves (the single-node figure this sim always used)

// Share of queries that cannot be answered by one shard. Sharding guides (Vitess, Citus)
// aim for "nearly all queries carry the shard key"; a few percent of scatter-gather is typical.
// A cross-shard read runs on every shard; a cross-shard write is a two-shard transaction.
export const CROSS_SHARD = 0.05;
// Keys are never spread evenly: a celebrity user or one big tenant lands on one shard.
// The busiest shard takes up to 25% more than an even share, approaching that as shards get smaller.
export const HOT_SKEW = 0.25;
// After a failover the old primary is rebuilt as a replica (pg_rewind or a fresh copy).
// Minutes to hours in real life; compressed so it is watchable.
export const REJOIN_SECS = 60;
const MAX_LAG_SECS = 3600; // stop counting after an hour behind

// How many shards and replicas actually apply: engines that scale out on their own ignore the steppers.
export const dbShape = (eng, p) => ({ S: eng.shard ? p.dbShards || 1 : 1, R: eng.repl ? p.dbReplicas || 0 : 0 });

// The +/- steppers in the Architecture panel.
const within = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const DATA_STEP = {
  dbReplicas: (v, d) => within(v + d, 0, MAX_REPLICAS),
  dbShards: (v, d) => SHARD_STEPS[within(SHARD_STEPS.indexOf(v) + d, 0, SHARD_STEPS.length - 1)],
  cacheNodes: (v, d) => within(v + d, 1, MAX_CACHE_NODES),
};
export const DATA_DEFAULTS = { dbReplicas: 0, dbShards: 1, cacheNodes: 1 };

// ---------------------------------------------------------------- losing one member
// Called first by Sim.kill. True means the tier survived the loss of one machine,
// so the node as a whole must not go down.
export function partialLoss(sim, node, reason) {
  if (node.type === 'cache') {
    const up = sim.params.cacheNodes - node.lostNodes;
    if (up <= 1) return false;
    // consistent hashing: only the dead node's slice of the keyspace moves, and it arrives cold
    node.warm *= 1 - 1 / up;
    node.lostNodes++;
    node.rejoinIn = node.restartSecs;
    node.stress = 0;
    node.crashes++;
    sim.emit('crash', node, reason);
    sim.emit('log', 'crit', `${node.label} lost 1 of ${up} nodes — ${reason}. Only its share of the keys went cold.`);
    return true;
  }
  if (node.type === 'db') {
    const eng = node.tech;
    const { R } = dbShape(eng, sim.params);
    if (node.failover > 0 || R - node.lostNodes < 1) return false; // nothing left to promote
    node.failover = eng.repl.failover;
    node.queue = node.stress = 0;
    node.crashes++;
    sim.emit('crash', node, reason);
    sim.emit('log', 'crit', `${node.label} primary crashed — ${reason}. Promoting a replica (about ${eng.repl.failover}s)`);
    return true;
  }
  return false;
}

// Bring lost machines back: a cache node rejoins, or the old primary returns as a replica.
export function heal(sim, id) {
  const node = sim.nodes[id];
  if (!node || !node.lostNodes) return;
  if (node.type === 'cache') {
    // it takes its slice of the keyspace back, holding only what it could reload from disk
    const n = sim.params.cacheNodes;
    const back = Math.min(node.lostNodes, n);
    node.warm = Math.min(1, node.warm * (1 - back / n) + (node.tech.persist * back) / n);
  }
  node.lostNodes = 0;
  sim.emit('recover', node);
  sim.emit('log', 'good', node.type === 'cache' ? `${node.label} node rejoined the cluster` : `${node.label}: old primary rebuilt and rejoined as a replica`);
}

// ---------------------------------------------------------------- cache cluster
// Advances the rejoin timer and returns how many cache nodes are serving.
export function cacheCluster(sim, dt) {
  const cache = sim.nodes.cache;
  const n = sim.params.cacheNodes || 1;
  cache.lostNodes = Math.min(cache.lostNodes, n - 1);
  if (cache.lostNodes && sim.params.autoRestart && !cache.down && (cache.rejoinIn -= dt) <= 0) heal(sim, 'cache');
  cache.nodes = cache.fleet = n;
  cache.nodesUp = n - cache.lostNodes;
  return cache.nodesUp;
}

// Extra explanation for the cache's status line, or '' to keep the usual one.
export function cacheStatus(cache, hit) {
  const n = cache.nodes;
  if (cache.lostNodes)
    return `${cache.lostNodes} of ${n} cache nodes ${cache.lostNodes > 1 ? 'are' : 'is'} down. Consistent hashing moved only that share of the keys to the survivors, so ${Math.round(hit * 100)}% of reads still hit while the moved keys warm up again.`;
  if (cache.util >= 1) return `More lookups than ${n} cache node${n > 1 ? 's' : ''} can answer (${(CACHE_NODE_CAP / 1000) * n}k per second). Add cache nodes: each one brings its own CPU and memory.`;
  if (n > 1 && cache.warm >= 0.6) return `Warm. ${Math.round(hit * 100)}% of reads are answered from RAM. Keys are spread over ${n} nodes by consistent hashing, so losing one node empties only 1/${n} of the cache.`;
  return '';
}

// ---------------------------------------------------------------- database: replicas, shards, failover
// Fraction of the offered load one shard can serve. `prim` is 1, or 0 while a replica is being promoted.
// Writes must fit on the primary alone (a), and reads + writes + the replicas' replay of those
// writes must fit on the whole group (b). With no replicas this is just capacity ÷ load.
function shardFit(C, prim, r, rd, wr, applyU) {
  const a = prim && wr > 0 ? C / wr : Infinity;
  const need = rd + prim * wr + r * applyU;
  const b = need > 0 ? ((prim + r) * C) / need : Infinity;
  return { fit: Math.min(a, b), writeBound: a < b };
}

// Advances failover and replication, and returns the capacity of the whole tier for the current mix.
// reads / writes are queries per second arriving (writes already 0 if the disk is full).
export function dbCluster(sim, dt, reads, writes) {
  const db = sim.nodes.db;
  const eng = db.tech;
  const p = sim.params;
  const { S, R } = dbShape(eng, p);
  const C = eng.cap;
  const wc = eng.writeCost;

  // resharding redistributes the rows already stored (instant here; a careful multi-hour migration in real life)
  // (a change of engine starts from a fresh disk anyway, see Sim.setTech)
  const sameEngine = db.tierEng === eng;
  db.tierEng = eng;
  if (sameEngine && db.shards !== S) {
    db.diskUsed = (db.diskUsed * db.shards) / S;
    if (!eng.managedDisk) db.diskUsed = Math.min(1, db.diskUsed);
    if (!db.down) sim.emit('log', 'good', S > 1 ? `${db.label} resharded: data split across ${S} shards` : `${db.label} merged back into one shard`);
  }
  db.lostNodes = Math.min(db.lostNodes, R);
  if (!R) db.failover = db.replBacklog = 0;

  // --- failover: the dead primary's shard has no writer until a replica is promoted
  if (db.failover > 0 && !db.down) {
    db.failover -= dt;
    if (db.failover <= 0) {
      db.failover = 0;
      db.lostNodes = Math.min(R, db.lostNodes + 1);
      db.rejoinIn = REJOIN_SECS;
      // replication is asynchronous: whatever the replica had not received yet is gone
      const lost = Math.round(db.replBacklog);
      db.replBacklog = 0;
      sim.emit('recover', db);
      sim.emit('log', 'good', `${db.label}: replica promoted to primary${lost > 0 ? ` — ${lost.toLocaleString()} writes that had not replicated were lost` : ''}`);
    }
  } else if (db.lostNodes && p.autoRestart && !db.down && (db.rejoinIn -= dt) <= 0) heal(sim, 'db');
  const failing = db.failover > 0;
  const r = R - db.lostNodes; // replicas alive in the shard that lost a machine
  const failW = failing ? writes / S : 0; // only that shard's writes fail

  // --- load on the busiest shard
  const share = (1 + HOT_SKEW * (1 - 1 / S)) / S;
  const readShare = S > 1 ? (1 - CROSS_SHARD) * share + CROSS_SHARD : 1; // a scatter-gather read runs on every shard
  const writeShare = S > 1 ? (1 - CROSS_SHARD) * share + (CROSS_SHARD * 2) / S : 1; // a cross-shard write touches two
  const rd = reads * readShare;
  const wr = writes * wc * writeShare;
  // replicas replay each write: cheaper than running it (no parsing, planning or locking), but the
  // replay stream is largely serial, so it tops out below what a many-core primary can commit
  const applyMax = R ? eng.repl.replay * C * eng.repl.apply : 0;
  const applyU = R ? Math.min(wr * eng.repl.apply, applyMax) : 0;
  // the shard that lost a machine is the weakest; with several shards the healthy ones must cope too
  let { fit, writeBound } = failing ? shardFit(C, 0, R, rd, 0, 0) : shardFit(C, 1, r, rd, wr, applyU);
  if (S > 1 && (failing || db.lostNodes)) {
    const ok = shardFit(C, 1, R, rd, wr, applyU);
    if (ok.fit < fit) ({ fit, writeBound } = ok);
  }
  const units = reads + (writes - failW) * wc;
  const nodes = S * (1 + R);
  const cap = units > 0 && isFinite(fit) ? fit * units : C * nodes;

  // --- replication lag (on the busiest shard), in writes not yet applied by its replicas
  let lagCause = '';
  if (R && !failing) {
    const served = Math.min(1, fit);
    const wHot = writes * writeShare * served; // writes/s the primary commits
    // reads are routed to whichever machine has room; replicas saturated with reads starve the replay
    const primRoom = Math.max(0, C - wr);
    const replRoom = Math.max(0, C - applyU);
    const replReads = primRoom + r * replRoom > 0 ? (rd * replRoom) / (primRoom + r * replRoom) : rd;
    const rho = r ? (replReads + wr * eng.repl.apply) / C : 0;
    const applyCap = applyMax / eng.repl.apply / wc / Math.max(1, rho); // writes/s a replica can replay
    const applied = Math.min(wHot + db.replBacklog / dt, applyCap);
    db.replBacklog = Math.min(Math.max(0, db.replBacklog + (wHot - applied) * dt), Math.max(wHot, 1) * MAX_LAG_SECS);
    db.replLag = eng.repl.lag + db.replBacklog / Math.max(wHot, 1);
    lagCause = wHot > (applyMax / eng.repl.apply / wc) * 0.99 ? 'replay' : 'reads';
  } else db.replLag = 0;

  Object.assign(db, { shards: S, replicas: R, replicasUp: failing ? R : r, fleet: nodes, hotShare: share, shardLoad: rd + wr, shardCap: isFinite(fit) ? fit * (rd + wr) : C * (1 + r) });
  return { S, R, r, nodes, failW, cap, qmax: eng.qmax * S * (failing ? Math.max(1, R) : 1 + r), failing, writeBound, lagCause };
}

// Extra explanation for the database's status line, or '' to keep the usual one.
export function dbStatus(db, tier, fmtDur) {
  const { S, R } = tier;
  if (db.readOnly || (S === 1 && !R)) return '';
  const each = S > 1 ? ' per shard' : '';
  if (tier.failing)
    return `Failing over: ${S > 1 ? 'one shard’s primary' : 'the primary'} died and a replica is being promoted (${Math.ceil(db.failover)}s to go). Until then ${S > 1 ? `writes to that shard (1 in ${S})` : 'every write'} fail${S > 1 ? '' : 's'}; reads carry on from the replicas.`;
  if (db.util >= 1 && R && tier.writeBound)
    return `Write-bound. Every write goes through the primary, and each replica must replay the same writes, so more replicas do not help. ${S > 1 ? 'Add shards' : 'Shard the data'} to spread writes over more primaries.`;
  if (db.util >= 1 && S > 1)
    return `The busiest shard is overloaded. Hot keys put ${Math.round(db.hotShare * 100)}% of the traffic on it instead of an even ${Math.round(100 / S)}%, and ${Math.round(CROSS_SHARD * 100)}% of queries have to visit several shards, so ${S} shards give well under ${S}× the capacity.`;
  if (db.util >= 1) return '';
  if (db.replLag > 5)
    return `Replicas are ${fmtDur(db.replLag)} behind the primary: ${tier.lagCause === 'replay' ? 'writes arrive faster than a replica can replay them' : 'they are so busy answering reads that replaying writes is starved'}. Reads served by a replica return stale data.`;
  if (db.lostNodes) return `Running a replica short${each} after the failover while the old primary is rebuilt as a replica. Another crash now would ${tier.r ? 'use up the next replica' : 'mean a full outage'}.`;
  if (db.util >= 0.7) return '';
  return (
    'Healthy. ' +
    (S > 1 ? `Data is split over ${S} shards by key, so most queries touch just one. ` : '') +
    (R ? `Reads are spread over the primary and ${R} replica${R > 1 ? 's' : ''}${each}; writes go to the primary and reach the replicas ${fmtDur(db.replLag)} later.` : 'With no replicas, a crashed shard is offline until it restarts.')
  );
}

// " — ×6 for …" appended to a technology's cost basis when the tier runs more than one machine.
export function fleetBasis(node) {
  if (!node.fleet || node.fleet < 2) return '';
  if (node.type === 'cache') return ` — ×${node.fleet} for ${node.fleet} cache nodes`;
  const R = node.replicas;
  return ` — ×${node.fleet} machines: ${node.shards} shard${node.shards > 1 ? 's' : ''} × (1 primary${R ? ` + ${R} replica${R > 1 ? 's' : ''}` : ''})`;
}
