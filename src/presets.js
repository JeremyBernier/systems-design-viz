// Preset systems. Each one configures the same set of building blocks — which
// components exist, which technology each uses, and the shape of the traffic —
// to resemble a well-known design. `missing` says what the real system has that
// this simulator does not model.

export const PRESETS = {
  reference: {
    name: 'Reference stack',
    blurb: 'A generic web service with every building block: request path, background jobs, event stream and analytics.',
    missing: '',
    params: { traffic: 600, writePct: 10, workerCount: 2, queryRate: 10 },
    webs: 2,
    tech: {},
    remove: [],
  },
  simple: {
    name: 'Simple web app',
    blurb: 'Where most products start: a load balancer, two servers, one PostgreSQL database, a cache, and a queue for slow work. No analytics yet.',
    missing: '',
    params: { traffic: 300, writePct: 15, workerCount: 1, queryRate: 0 },
    webs: 2,
    tech: {},
    remove: ['kafka', 'consumer', 'lake', 'clickhouse', 'trino', 'bi'],
  },
  youtube: {
    name: 'YouTube',
    blurb: 'Overwhelmingly read-heavy: about 100 watches for every upload. Video metadata lives in Cassandra, partitioned by video ID, with an LRU cache in front for popular videos. Uploads are queued and transcoded by a pool of workers.',
    missing: 'Not modelled: the video files themselves (segments in S3), the CDN that serves almost all the bytes, and the workflow orchestrator that coordinates transcoding steps.',
    params: { traffic: 4000, writePct: 1, workerCount: 6, queryRate: 20 },
    webs: 5,
    tech: { lb: 'gclb', web: 'gke', cache: 'redis', db: 'cassandra', queue: 'pubsub', worker: 'gce', kafka: 'kafka', consumer: 'dataflow', lake: 'gcsiceberg', clickhouse: 'bigquery', trino: 'trino', bi: 'looker' },
    remove: [],
  },
  instagram: {
    name: 'Instagram',
    blurb: '500M daily users and 100M posts a day, with feeds that must load in under 500 ms. Reads dominate, so feeds are precomputed into a cache; posting triggers asynchronous fan-out to followers and media processing through a queue.',
    missing: 'Not modelled: photo and video blobs in object storage and the CDN in front of them. The component choices follow the common public design; the linked write-up\'s final diagram is behind a paywall.',
    params: { traffic: 5000, writePct: 6, workerCount: 5, queryRate: 15 },
    webs: 6,
    tech: { lb: 'alb', web: 'ec2', cache: 'elasticache', db: 'dynamodb', queue: 'sqs', worker: 'lambda', kafka: 'msk', consumer: 'firehose', lake: 's3iceberg', clickhouse: 'clickhouse', trino: 'athena', bi: 'superset' },
    remove: [],
  },
  uber: {
    name: 'Uber',
    blurb: 'Write-heavy: millions of drivers report their location every few seconds. Locations go to Redis, which doubles as a geospatial index for finding nearby drivers; rides are stored in PostgreSQL; ride requests wait in a queue so none are dropped during a surge. Here every write lands on the database, so it is the first thing to fall over as traffic grows.',
    missing: 'Not modelled: geospatial search itself, the distributed lock that stops one driver being offered two rides, push notifications, and regional sharding.',
    params: { traffic: 1400, writePct: 45, workerCount: 3, queryRate: 10 },
    webs: 3,
    tech: { lb: 'alb', web: 'ec2', cache: 'redis', db: 'postgres', queue: 'sqs', worker: 'ec2', kafka: 'kafka', consumer: 'flink', lake: 's3iceberg', clickhouse: 'clickhouse', trino: 'trino', bi: 'grafana' },
    remove: [],
  },
};
