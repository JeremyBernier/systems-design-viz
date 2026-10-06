// Preset systems. Each one configures the same set of building blocks — which
// components exist, which technology each uses, and the shape of the traffic —
// to resemble a well-known design. `workload` optionally overrides the workload
// assumptions (WORKLOAD in sim.js). Optional `data` sets replicas, shards and cache
// nodes (see datatier.js); anything left out is a single node. `missing` says what
// the real system has that this simulator does not model.

// Static asset / media profile per system (see cdn.js for what each field means). Sizes are per object
// on the wire. Rules of thumb: a compressed script, stylesheet or thumbnail is 10–30 kB; a feed photo is
// ~200 kB; a 2–4 s video segment at 3–5 Mbps is ~1.5 MB. assetObjects × assetKB is what the bucket holds.
const ASSETS = {
  reference: { assetsPerReq: 2, assetKB: 20, assetObjects: 5e6, uploadPct: 5, uploadKB: 500 },
  simple: { assetsPerReq: 1, assetKB: 15, assetObjects: 2e5, uploadPct: 5, uploadKB: 300 },
  youtube: { assetsPerReq: 1.5, assetKB: 1500, assetObjects: 2e8, uploadPct: 5, uploadKB: 40000 }, // 300 TB of segments; an upload is stored in several renditions
  instagram: { assetsPerReq: 4, assetKB: 200, assetObjects: 5e8, uploadPct: 10, uploadKB: 3000 }, // 100 TB; each post is kept in several sizes
  uber: { assetsPerReq: 0.5, assetKB: 30, assetObjects: 1e6, uploadPct: 1, uploadKB: 300 },
};

export const PRESETS = {
  reference: {
    name: 'Reference stack',
    blurb: 'A generic web service with every building block: request path, background jobs, event stream and analytics.',
    missing: '',
    params: { traffic: 600, writePct: 10, workerCount: 2, queryRate: 10, ...ASSETS.reference },
    webs: 2,
    tech: {},
    remove: [],
  },
  simple: {
    name: 'Simple web app',
    blurb: 'Where most products start: a load balancer, two servers, one PostgreSQL database, a cache, and a queue for slow work. No analytics yet.',
    missing: '',
    params: { traffic: 300, writePct: 15, workerCount: 1, queryRate: 0, ...ASSETS.simple },
    webs: 2,
    tech: {},
    remove: ['kafka', 'consumer', 'lake', 'clickhouse', 'trino', 'bi', 'fn'],
  },
  youtube: {
    name: 'YouTube',
    blurb: 'Overwhelmingly read-heavy: about 100 watches for every upload. Video metadata lives in Cassandra, partitioned by video ID, with an LRU cache in front for popular videos. Uploads are queued and transcoded by a pool of workers.',
    missing: 'Video segments live in object storage and the CDN serves about 99% of the bytes: remove the CDN to see why. Not modelled: adaptive bitrate (one average segment size stands in for every resolution), Google\'s caches inside ISP networks, and the workflow orchestrator that coordinates transcoding steps.',
    params: { traffic: 4000, writePct: 1, workerCount: 6, queryRate: 20, ...ASSETS.youtube },
    data: { cacheNodes: 3 }, // popular-video metadata is served from a cache cluster; Cassandra scales itself
    webs: 5,
    tech: { lb: 'gclb', web: 'gke', cache: 'redis', db: 'cassandra', queue: 'pubsub', worker: 'gce', kafka: 'kafka', consumer: 'dataflow', lake: 'gcsiceberg', clickhouse: 'bigquery', trino: 'trino', bi: 'looker', cdn: 'cloudcdn', blob: 'gcs', fn: 'cloudfunctions' },
    remove: [],
  },
  instagram: {
    name: 'Instagram',
    blurb: '500M daily users and 100M posts a day, with feeds that must load in under 500 ms. Reads dominate, so feeds are precomputed into a cache; posting triggers asynchronous fan-out to followers and media processing through a queue.',
    missing: 'Photos and videos are stored in object storage and served through the CDN, which carries almost all the bytes. Not modelled: per-device image resizing and client-side caching of the feed. The component choices follow the common public design; the linked write-up\'s final diagram is behind a paywall.',
    params: { traffic: 5000, writePct: 6, workerCount: 5, queryRate: 15, ...ASSETS.instagram },
    workload: { cacheHitRatio: 0.95 }, // feeds are precomputed into the cache, so almost every read hits
    data: { cacheNodes: 3 }, // precomputed feeds live in a cache cluster, so one lost node costs a third of them
    webs: 6,
    tech: { lb: 'alb', web: 'ec2', cache: 'elasticache', db: 'dynamodb', queue: 'sqs', worker: 'lambda', kafka: 'msk', consumer: 'firehose', lake: 's3iceberg', clickhouse: 'clickhouse', trino: 'athena', bi: 'superset' },
    remove: [],
  },
  uber: {
    name: 'Uber',
    blurb: 'Write-heavy: millions of drivers report their location every few seconds. Locations go to Redis, which doubles as a geospatial index for finding nearby drivers; rides are stored in PostgreSQL; ride requests wait in a queue so none are dropped during a surge. Here every write lands on the database, so it is the first thing to fall over as traffic grows. One replica stands by for failover, but replicas add no write capacity — try adding shards.',
    missing: 'Little static content: the app ships with its assets, so the CDN only carries map tiles, photos and receipts. Not modelled: geospatial search itself, the distributed lock that stops one driver being offered two rides, and push notifications. Real Uber shards by region; the shards here split by key.',
    params: { traffic: 1400, writePct: 45, workerCount: 3, queryRate: 10, ...ASSETS.uber },
    workload: { reqBytes: 2e3 }, // a location ping is a few hundred bytes of JSON plus headers, not a page
    data: { dbReplicas: 1 }, // a standby to fail over to; it does nothing for the write load
    webs: 3,
    tech: { lb: 'alb', web: 'ec2', cache: 'redis', db: 'postgres', queue: 'sqs', worker: 'ec2', kafka: 'kafka', consumer: 'flink', lake: 's3iceberg', clickhouse: 'clickhouse', trino: 'trino', bi: 'grafana' },
    remove: [],
  },
};
