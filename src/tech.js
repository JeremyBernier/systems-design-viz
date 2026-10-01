// Catalog of concrete technologies each component can be.
//
// Every entry carries: how it is labelled and drawn (name, vendor, logo), what it
// teaches (kind, about), how it behaves in the simulation (the per-role fields
// documented below), and a ballpark monthly cost from public on-demand list prices
// (AWS us-east-1 / Google Cloud us-central1, rounded; no discounts or free tiers).
//
// Shared optional fields:
//   serverless   – no machine of yours: CPU and memory are the provider's problem
//   managedDisk  – storage has no fixed limit
//   restart      – seconds to come back after a crash (default 8)
//   spec         – { cores, ramGB, diskGB } override for the zoom-in view
import {
  siNginx, siEnvoyproxy, siGooglecloud, siKubernetes, siRedis, siPostgresql, siMysql, siGooglebigtable,
  siGooglecloudspanner, siApachecassandra, siRabbitmq, siGooglepubsub, siApachekafka, siApacheflink, siApachespark,
  siGoogledataflow, siGooglecloudstorage, siDelta, siClickhouse, siSnowflake, siGooglebigquery, siTrino,
  siGrafana, siApachesuperset, siMetabase, siLooker, siLinux, siSidekiq,
} from 'simple-icons';

const HOURS = 730; // per month
const SECONDS = HOURS * 3600;
const GB = 1e9;
const TIB = 2 ** 40;
const vm = (hourly, n = 1) => hourly * HOURS * n;
const perMillion = (rate, usd) => ((rate * SECONDS) / 1e6) * usd;
const gbMonth = (bytesPerSec) => (bytesPerSec / GB) * SECONDS;

// AWS service icons are not openly licensed, so AWS (and a few others) get a lettered badge instead.
const AWS = '#ff9900';
const icon = (si) => ({ path: si.path, color: '#' + si.hex });
const badge = (text, color) => ({ text, color });

export const TECH = {
  // ------------------------------------------------------------------ load balancer
  // cap: requests/s it can route
  lb: {
    nginx: {
      name: 'Nginx', vendor: 'Self-hosted', logo: icon(siNginx), kind: 'Reverse proxy on your own VM',
      about: 'The most common open-source reverse proxy. Event-driven, so one small machine routes tens of thousands of requests a second — but it is one machine: you size it, patch it, and it is a single point of failure unless you run two.',
      cap: 40000, cost: () => vm(0.085), basis: 'One c5.large VM at $0.085/h',
    },
    haproxy: {
      name: 'HAProxy', vendor: 'Self-hosted', logo: badge('HA', '#106da9'), kind: 'Reverse proxy on your own VM',
      about: 'A proxy built specifically for load balancing: very high throughput, rich health checks and balancing algorithms. Same operational trade as Nginx — it is your machine to run.',
      cap: 50000, cost: () => vm(0.085), basis: 'One c5.large VM at $0.085/h',
    },
    envoy: {
      name: 'Envoy', vendor: 'Self-hosted', logo: icon(siEnvoyproxy), kind: 'Service proxy on your own VM',
      about: 'A modern proxy designed for microservices and service meshes, with detailed metrics and dynamic configuration. Slightly more overhead per request than Nginx or HAProxy.',
      cap: 35000, cost: () => vm(0.085), basis: 'One c5.large VM at $0.085/h',
    },
    alb: {
      name: 'AWS ALB', vendor: 'AWS', logo: badge('ALB', AWS), kind: 'Managed load balancer', serverless: true,
      about: 'AWS Application Load Balancer. No machine to size: AWS scales it behind the scenes and spreads it over several zones. You pay an hourly fee plus a charge for every GB it processes, so cost follows traffic.',
      cap: 200000, cost: (n) => 0.0225 * HOURS + gbMonth(n.bps / 8) * 0.008, basis: '$0.0225/h + $0.008 per GB processed',
    },
    gclb: {
      name: 'Cloud Load Balancing', vendor: 'Google Cloud', logo: icon(siGooglecloud), kind: 'Managed global load balancer', serverless: true,
      about: 'Google\'s managed load balancer. One global IP address served from Google\'s edge network, so users connect to the nearest location. Scales without pre-warming; billed per forwarding rule and per GB.',
      cap: 200000, cost: (n) => 0.025 * HOURS + gbMonth(n.bps / 8) * 0.008, basis: '$0.025/h + $0.008 per GB processed',
    },
  },

  // ------------------------------------------------------------------ web servers (one choice for the whole tier)
  // capMul: throughput vs the baseline VM · noCrash: sheds load instead of dying
  web: {
    ec2: {
      name: 'AWS EC2', vendor: 'AWS', logo: badge('EC2', AWS), kind: 'Virtual machine',
      about: 'A rented virtual machine. You choose the size, install everything, and pay by the hour whether it is busy or idle. Scaling means adding machines, which takes minutes.',
      capMul: 1, cost: () => vm(0.34), basis: 'c5.2xlarge (8 vCPU, 16 GB) at $0.34/h each',
    },
    gce: {
      name: 'Compute Engine', vendor: 'Google Cloud', logo: icon(siGooglecloud), kind: 'Virtual machine',
      about: 'Google Cloud\'s virtual machines — the same model as EC2: fixed capacity you size yourself, billed per second of uptime.',
      capMul: 1, cost: () => vm(0.418), basis: 'c2-standard-8 (8 vCPU, 32 GB) at $0.42/h each',
    },
    fargate: {
      name: 'AWS Fargate', vendor: 'AWS', logo: badge('FG', AWS), kind: 'Managed containers',
      about: 'Runs your containers without you managing the machines underneath. A crashed task is replaced automatically in seconds. You pay a premium per vCPU for not running servers.',
      capMul: 1, restart: 4, cost: () => vm(0.395), basis: '8 vCPU + 16 GB task at ~$0.40/h each',
    },
    gke: {
      name: 'Kubernetes (GKE)', vendor: 'Google Cloud', logo: icon(siKubernetes), kind: 'Container orchestrator',
      about: 'Containers scheduled onto a cluster of machines. Kubernetes restarts crashed containers within seconds and can add replicas automatically — at the price of running and understanding Kubernetes.',
      capMul: 1, restart: 3, cost: () => vm(0.418) + 12, basis: 'One c2-standard-8 node each + a share of the cluster fee',
    },
    lambda: {
      name: 'AWS Lambda', vendor: 'AWS', logo: badge('λ', AWS), kind: 'Serverless functions', serverless: true, noCrash: true,
      about: 'No servers at all: AWS runs a copy of your function per request and scales out on its own. Nothing to crash and nothing to pay when idle — but you pay per request, which costs more than a busy VM at steady high traffic, and there is an account-wide concurrency limit.',
      capMul: 4, cost: (n) => perMillion(n.outRate, 0.62), basis: '~$0.62 per million requests (request fee + 50 ms at 512 MB)',
    },
    cloudrun: {
      name: 'Cloud Run', vendor: 'Google Cloud', logo: icon(siGooglecloud), kind: 'Serverless containers', serverless: true, noCrash: true,
      about: 'Runs a container per burst of requests and scales to zero when idle. Like Lambda it cannot be knocked over by load, and one instance serves many requests at once. Billed for CPU and memory only while handling requests.',
      capMul: 4, cost: (n) => perMillion(n.outRate, 0.75), basis: '~$0.75 per million requests (request fee + CPU and memory time)',
    },
    metal: {
      name: 'Physical server', vendor: 'On-premises', logo: icon(siLinux), kind: 'Bare metal in a data centre',
      about: 'A machine you own in a rack. No virtualisation overhead and by far the cheapest per month once bought — but capacity is fixed for years, and when hardware dies someone has to physically replace it.',
      capMul: 1.15, restart: 40, cost: () => 190, basis: '~$190/month: hardware spread over 4 years, plus rack space and power',
    },
  },

  // ------------------------------------------------------------------ cache
  // persist: how warm it is after a restart (0 = empty, 1 = nothing lost)
  cache: {
    redis: {
      name: 'Redis', vendor: 'Self-hosted', logo: icon(siRedis), kind: 'In-memory data store on your own VM',
      about: 'An in-memory key-value store with rich data types and optional snapshots to disk. After a crash it reloads the last snapshot, so it comes back partly warm.',
      persist: 0.6, cost: () => vm(0.2016), basis: 'One r6g.xlarge (32 GB) at $0.20/h',
    },
    memcached: {
      name: 'Memcached', vendor: 'Self-hosted', logo: badge('MC', '#2a9d8f'), kind: 'In-memory cache on your own VM',
      about: 'The simplest cache: strings in, strings out, nothing written to disk. Multi-threaded and very fast, but a restart always starts from empty.',
      persist: 0, cost: () => vm(0.2016), basis: 'One r6g.xlarge (32 GB) at $0.20/h',
    },
    elasticache: {
      name: 'AWS ElastiCache', vendor: 'AWS', logo: badge('EC', AWS), kind: 'Managed Redis with a replica',
      about: 'Redis run by AWS with a standby replica in another zone. When the primary dies the warm replica takes over in seconds, so the database is barely exposed. You pay for both nodes.',
      persist: 0.9, restart: 2, cost: () => vm(0.41, 2), basis: 'Two cache.r6g.xlarge nodes (primary + replica) at $0.41/h each',
    },
    memorystore: {
      name: 'Memorystore', vendor: 'Google Cloud', logo: icon(siGooglecloud), kind: 'Managed Redis with a replica',
      about: 'Google Cloud\'s managed Redis. The standard tier keeps a replica and fails over automatically, like ElastiCache. Priced per GB of capacity.',
      persist: 0.9, restart: 2, cost: () => vm(0.93), basis: '32 GB standard tier at ~$0.029 per GB-hour',
    },
  },

  // ------------------------------------------------------------------ OLTP database
  // cap: cost units/s (a read = 1) · writeCost · qmax: queries that may wait · conns · crash: reason, or null
  db: {
    postgres: {
      name: 'PostgreSQL', vendor: 'Self-hosted', logo: icon(siPostgresql), kind: 'OLTP · relational SQL, single primary',
      about: 'An OLTP database: built for many small transactions that read or change a few rows each. Row-oriented storage, strict ACID transactions, joins and indexes. One primary takes all writes, so it scales up (bigger machine) rather than out. Each connection is a whole process, so connections are scarce and the pool is the first thing to run out.',
      cap: 4000, writeCost: 4, qmax: 3000, conns: 500, crash: 'connection pool exhausted',
      spec: { cores: 16, ramGB: 64, diskGB: 500 }, cost: () => vm(0.768) + 500 * 0.08, basis: 'm5.4xlarge (16 vCPU, 64 GB) at $0.77/h + 500 GB disk; you run it',
    },
    mysql: {
      name: 'MySQL', vendor: 'Self-hosted', logo: icon(siMysql), kind: 'OLTP · relational SQL, single primary',
      about: 'An OLTP database, like PostgreSQL: row-oriented, transactional, one primary for writes. Connections are threads rather than processes, so it tolerates more of them, and its clustered primary-key index makes simple writes slightly cheaper. The same ceiling applies: one machine takes every write.',
      cap: 4400, writeCost: 3.5, qmax: 4000, conns: 1500, crash: 'out of memory (too many connection threads)',
      spec: { cores: 16, ramGB: 64, diskGB: 500 }, cost: () => vm(0.768) + 500 * 0.08, basis: 'm5.4xlarge (16 vCPU, 64 GB) at $0.77/h + 500 GB disk; you run it',
    },
    rds: {
      name: 'AWS RDS', vendor: 'AWS', logo: badge('RDS', AWS), kind: 'OLTP · managed PostgreSQL',
      about: 'PostgreSQL operated by AWS: backups, patching and failover to a standby are handled for you. The engine and its limits are unchanged — one primary, scarce connections — you are paying roughly double the VM price for the operations work.',
      cap: 4000, writeCost: 4, qmax: 3000, conns: 500, crash: 'connection pool exhausted', restart: 5,
      spec: { cores: 16, ramGB: 64, diskGB: 500 }, cost: () => vm(1.42) + 500 * 0.115, basis: 'db.m5.4xlarge at $1.42/h + 500 GB at $0.115 per GB',
    },
    aurora: {
      name: 'AWS Aurora', vendor: 'AWS', logo: badge('AU', AWS), kind: 'OLTP · cloud-native relational',
      about: 'A PostgreSQL/MySQL-compatible database with storage rebuilt for the cloud: data is replicated six ways across zones and grows automatically, so the disk never fills. Faster failover and somewhat higher throughput than stock PostgreSQL; writes still go through one primary.',
      cap: 5000, writeCost: 3.5, qmax: 3500, conns: 1000, crash: 'connection pool exhausted', restart: 3, managedDisk: true,
      spec: { cores: 16, ramGB: 128, diskGB: 500 }, cost: (n) => vm(2.08) + n.storedGB * 0.1, basis: 'db.r6g.4xlarge at $2.08/h + $0.10 per GB stored',
    },
    cloudsql: {
      name: 'Cloud SQL', vendor: 'Google Cloud', logo: icon(siGooglecloud), kind: 'OLTP · managed PostgreSQL',
      about: 'Google Cloud\'s managed PostgreSQL/MySQL — the counterpart of RDS. Same engine and same single-primary limits, with backups and failover run for you.',
      cap: 4000, writeCost: 4, qmax: 3000, conns: 500, crash: 'connection pool exhausted', restart: 5,
      spec: { cores: 16, ramGB: 64, diskGB: 500 }, cost: () => vm(1.5) + 500 * 0.17, basis: '16 vCPU + 64 GB at ~$1.50/h + 500 GB SSD at $0.17 per GB',
    },
    spanner: {
      name: 'Cloud Spanner', vendor: 'Google Cloud', logo: icon(siGooglecloudspanner), kind: 'OLTP · distributed SQL',
      about: 'A relational database that scales out: SQL and strong transactions, but data is split across nodes, so writes are not limited to one machine. Add nodes to add capacity. Each write is coordinated across replicas, so single queries are a little slower, and it is expensive at small scale.',
      cap: 9000, writeCost: 3, qmax: 5000, conns: 0, crash: null, managedDisk: true,
      spec: { cores: 24, ramGB: 96, diskGB: 500 }, cost: (n) => vm(0.9, 3) + n.storedGB * 0.3, basis: '3 nodes at $0.90/h each + $0.30 per GB stored',
    },
    cassandra: {
      name: 'Cassandra', vendor: 'Self-hosted', logo: icon(siApachecassandra), kind: 'OLTP · wide-column (NoSQL), masterless',
      about: 'A wide-column store with no primary: every node accepts writes, and data is spread across nodes by partition key. Writes are appends, so they are as cheap as reads, and capacity grows by adding nodes (three here). In exchange you design tables around your queries — no joins — and accept eventual consistency. A dead node does not take the cluster down.',
      cap: 9000, writeCost: 1, qmax: 5000, conns: 0, crash: null,
      spec: { cores: 24, ramGB: 96, diskGB: 3000 }, cost: () => vm(0.384, 3) + 3000 * 0.08, basis: '3 × m5.2xlarge at $0.38/h each + 3 TB disk; you run it',
    },
    dynamodb: {
      name: 'DynamoDB', vendor: 'AWS', logo: badge('DDB', AWS), kind: 'OLTP · managed key-value (NoSQL)', serverless: true, managedDisk: true,
      about: 'An OLTP store with no servers to manage: a key-value table spread over many partitions by AWS. Lookups by key take single-digit milliseconds at any size, storage is unlimited, and there are no connections to exhaust. The trade: no joins, and you pay for throughput — exceed your provisioned capacity and requests are throttled immediately instead of queuing.',
      cap: 6000, writeCost: 2, qmax: 60, conns: 0, crash: null,
      spec: { cores: 0, ramGB: 0, diskGB: 500 }, cost: (n) => (1500 * 0.00065 + 3000 * 0.00013) * HOURS + n.storedGB * 0.25, basis: 'Provisioned 1,500 write + 3,000 read units, plus $0.25 per GB stored',
    },
    bigtable: {
      name: 'Bigtable', vendor: 'Google Cloud', logo: icon(siGooglebigtable), kind: 'OLTP · wide-column (NoSQL)',
      about: 'A wide-column store for very high-throughput reads and writes by row key. Writes are appended to a log-structured tree, so they cost about the same as reads. Capacity scales linearly with nodes (three here). No joins or multi-row transactions; overload shows up as rising latency rather than a crash.',
      cap: 9000, writeCost: 1, qmax: 5000, conns: 0, crash: null,
      spec: { cores: 24, ramGB: 96, diskGB: 7500 }, cost: (n) => vm(0.65, 3) + n.storedGB * 0.17, basis: '3 nodes at $0.65/h each + $0.17 per GB of SSD used',
    },
  },

  // ------------------------------------------------------------------ job queue
  // qmax: jobs it can hold
  queue: {
    rabbitmq: {
      name: 'RabbitMQ', vendor: 'Self-hosted', logo: icon(siRabbitmq), kind: 'Message broker on your own VM',
      about: 'A classic message broker with routing, acknowledgements and retries. Messages are held in memory on one machine, so a long backlog eventually fills it and new jobs are refused.',
      qmax: 20000, cost: () => vm(0.192), basis: 'One m5.xlarge (4 vCPU, 16 GB) at $0.19/h',
    },
    redisq: {
      name: 'Redis + Sidekiq', vendor: 'Self-hosted', logo: icon(siSidekiq), kind: 'Job queue on Redis',
      about: 'Jobs stored as lists in Redis, processed by a library such as Sidekiq or Celery. Very simple and fast. Everything lives in RAM, so the backlog is limited by memory.',
      qmax: 50000, cost: () => vm(0.192), basis: 'One m5.xlarge (4 vCPU, 16 GB) at $0.19/h',
    },
    sqs: {
      name: 'AWS SQS', vendor: 'AWS', logo: badge('SQS', AWS), kind: 'Managed queue', serverless: true,
      about: 'A queue with no server and, for practical purposes, no depth limit: it will hold millions of jobs for days. You pay per request. Because it never fills up, a backlog can grow unnoticed for a long time.',
      qmax: 5e6, cost: (n) => perMillion(n.inRate + n.outRate, 0.4), basis: '$0.40 per million requests (each send and each receive)',
    },
    pubsub: {
      name: 'Pub/Sub', vendor: 'Google Cloud', logo: icon(siGooglepubsub), kind: 'Managed messaging', serverless: true,
      about: 'Google Cloud\'s managed messaging service used as a job queue. Like SQS it has no machine and effectively no depth limit; it is billed by the volume of data passing through.',
      qmax: 5e6, cost: (n) => (((n.inRate + n.outRate) * 4e3 * SECONDS) / TIB) * 40, basis: '$40 per TiB of message data (~4 kB per job)',
    },
  },

  // ------------------------------------------------------------------ workers
  // rateMul: jobs/s per worker vs baseline · perJob: billed per job instead of per machine
  worker: {
    ec2: {
      name: 'AWS EC2', vendor: 'AWS', logo: badge('EC2', AWS), kind: 'Worker VMs',
      about: 'Worker processes on rented machines. Fixed capacity: the number of workers decides how fast the queue drains.',
      rateMul: 1, cost: (n, p) => vm(0.17, p.workerCount), basis: 'c5.xlarge (4 vCPU, 8 GB) at $0.17/h per worker',
    },
    gce: {
      name: 'Compute Engine', vendor: 'Google Cloud', logo: icon(siGooglecloud), kind: 'Worker VMs',
      about: 'Worker processes on Google Cloud machines. Same model as EC2: you decide how many, and pay for them around the clock.',
      rateMul: 1, cost: (n, p) => vm(0.209, p.workerCount), basis: 'c2-standard-4 (4 vCPU, 16 GB) at $0.21/h per worker',
    },
    lambda: {
      name: 'AWS Lambda', vendor: 'AWS', logo: badge('λ', AWS), kind: 'Serverless job functions', serverless: true,
      about: 'Each job runs as a function invocation, triggered straight from the queue. Capacity follows the backlog automatically, so the queue rarely builds up; you pay per job instead of per machine.',
      rateMul: 5, cost: (n) => perMillion(n.outRate, 2.0), basis: '~$2 per million jobs (≈100 ms at 1 GB each)',
    },
    cloudrun: {
      name: 'Cloud Run', vendor: 'Google Cloud', logo: icon(siGooglecloud), kind: 'Serverless job containers', serverless: true,
      about: 'Jobs pushed to autoscaling containers. Like Lambda, capacity follows demand and idle time is free.',
      rateMul: 5, cost: (n) => perMillion(n.outRate, 2.4), basis: '~$2.40 per million jobs (CPU and memory time)',
    },
  },

  // ------------------------------------------------------------------ event stream
  // cap: events/s it can accept · retention: unread events kept before the oldest are dropped
  kafka: {
    kafka: {
      name: 'Apache Kafka', vendor: 'Self-hosted', logo: icon(siApachekafka), kind: 'Event stream (append-only log)',
      about: 'Every request appends an event to a partitioned log on disk. Producers never wait for consumers: if a consumer is slow, unread messages simply pile up as "lag". Messages older than the retention limit are deleted — read or not. Running it yourself is cheap in dollars and expensive in attention.',
      cap: 25000, retention: 150000, cost: () => vm(0.384) + 2000 * 0.08, basis: 'm5.2xlarge at $0.38/h + 2 TB disk; you run it',
    },
    msk: {
      name: 'AWS MSK', vendor: 'AWS', logo: badge('MSK', AWS), kind: 'Managed Kafka',
      about: 'Real Apache Kafka, with AWS running the brokers, patching and replacing failed ones. Identical behaviour to self-hosted Kafka at roughly twice the machine price.',
      cap: 25000, retention: 150000, restart: 4, cost: () => vm(0.84) + 2000 * 0.1, basis: 'kafka.m5.2xlarge broker at $0.84/h + 2 TB storage',
    },
    kinesis: {
      name: 'AWS Kinesis', vendor: 'AWS', logo: badge('KDS', AWS), kind: 'Managed stream (shards)', serverless: true,
      about: 'AWS\'s own streaming service. Capacity comes in "shards", each accepting 1,000 records a second — eight here, so 8,000/s. Go past that and producers are throttled. No brokers to run; you pay per shard-hour and per record.',
      cap: 8000, retention: 150000, cost: (n) => 8 * 0.015 * HOURS + perMillion(n.inRate, 0.014), basis: '8 shards at $0.015/h each + $0.014 per million records',
    },
    pubsub: {
      name: 'Pub/Sub', vendor: 'Google Cloud', logo: icon(siGooglepubsub), kind: 'Managed messaging', serverless: true, managedDisk: true,
      about: 'Google Cloud\'s serverless messaging. No partitions or shards to size — it scales with traffic — and each subscriber keeps its own backlog. Billed by data volume, so cost rises directly with event rate.',
      cap: 100000, retention: 150000, cost: (n) => (((n.inRate + n.outRate) * 2e3 * SECONDS) / TIB) * 40, basis: '$40 per TiB published and delivered (~2 kB per event)',
    },
  },

  // ------------------------------------------------------------------ lake writer (stream processor)
  // cap: events/s · files: small Parquet files written per second
  consumer: {
    flink: {
      name: 'Apache Flink', vendor: 'Self-hosted', logo: icon(siApacheflink), kind: 'Stream processor',
      about: 'Processes events one at a time with low latency, checkpointing its progress so nothing is lost or duplicated. Commits to the lake every second, which keeps data fresh but creates many small files.',
      cap: 3000, files: 3, cost: () => vm(0.34), basis: 'c5.2xlarge (8 vCPU, 16 GB) at $0.34/h',
    },
    spark: {
      name: 'Spark Streaming', vendor: 'Self-hosted', logo: icon(siApachespark), kind: 'Micro-batch stream processor',
      about: 'Processes the stream in small batches every several seconds rather than event by event. Higher throughput and far fewer, larger files — at the cost of data arriving a little later.',
      cap: 4000, files: 0.3, cost: () => vm(0.34), basis: 'c5.2xlarge (8 vCPU, 16 GB) at $0.34/h',
    },
    firehose: {
      name: 'Data Firehose', vendor: 'AWS', logo: badge('FH', AWS), kind: 'Managed delivery stream', serverless: true,
      about: 'A fully managed pipe from a stream into storage: no code and no cluster. It buffers for about a minute and writes large Parquet files, so there is almost no small-files problem — but data is a minute late and you cannot run custom logic.',
      cap: 10000, files: 0.05, cost: (n) => gbMonth(n.outRate * 2e3) * 0.047, basis: '$0.029 per GB ingested + $0.018 per GB converted to Parquet',
    },
    dataflow: {
      name: 'Dataflow', vendor: 'Google Cloud', logo: icon(siGoogledataflow), kind: 'Managed stream processor',
      about: 'Google Cloud\'s managed runner for Apache Beam pipelines. Adds and removes workers automatically as the stream speeds up or slows down.',
      cap: 6000, files: 1, cost: () => vm(0.7), basis: '~2 streaming workers (8 vCPU total) at ~$0.70/h',
    },
  },

  // ------------------------------------------------------------------ data lake
  lake: {
    s3iceberg: {
      name: 'S3 + Iceberg', vendor: 'AWS', logo: badge('S3', AWS), kind: 'S3 + Iceberg + Parquet', serverless: true, managedDisk: true,
      about: 'Three layers. S3 is cheap object storage with no capacity limit. Parquet is the file format: columnar and compressed, so a query reads only the columns it needs. Iceberg is the table format: metadata that says which files make up the table, giving atomic commits, snapshots and time travel. Frequent commits create many small files, which must be compacted or queries slow down.',
      cost: (n) => n.storedGB * 0.023 + (n.putRate * 0.000005 + n.getRate * 0.0000004) * SECONDS, basis: '$0.023 per GB-month + $0.005 per 1,000 PUTs + $0.0004 per 1,000 GETs',
    },
    gcsiceberg: {
      name: 'Cloud Storage + Iceberg', vendor: 'Google Cloud', logo: icon(siGooglecloudstorage), kind: 'GCS + Iceberg + Parquet', serverless: true, managedDisk: true,
      about: 'The same three layers on Google Cloud: Cloud Storage holds the objects, Parquet is the columnar file format, and Iceberg tracks which files make up the table. Because Iceberg is an open format, the same table can be read by Trino, Spark or BigQuery.',
      cost: (n) => n.storedGB * 0.02 + (n.putRate * 0.000005 + n.getRate * 0.0000004) * SECONDS, basis: '$0.020 per GB-month + per-operation fees',
    },
    s3delta: {
      name: 'S3 + Delta Lake', vendor: 'AWS', logo: icon(siDelta), kind: 'S3 + Delta Lake + Parquet', serverless: true, managedDisk: true,
      about: 'Parquet files on S3 again, but with Delta Lake as the table format. Instead of Iceberg\'s tree of metadata files it keeps an ordered transaction log beside the data. Same guarantees (atomic commits, time travel) and the same small-files problem; it is most at home with Spark and Databricks.',
      cost: (n) => n.storedGB * 0.023 + (n.putRate * 0.000005 + n.getRate * 0.0000004) * SECONDS, basis: '$0.023 per GB-month + $0.005 per 1,000 PUTs + $0.0004 per 1,000 GETs',
    },
  },

  // ------------------------------------------------------------------ OLAP database (node id "clickhouse")
  // cores · qCost: core-seconds per query · shared: queries, inserts and merges share CPU · parts: merge model
  // baseLat: seconds per query when idle · ingestDelay: seconds before new data is queryable
  clickhouse: {
    clickhouse: {
      name: 'ClickHouse', vendor: 'Self-hosted', logo: icon(siClickhouse), kind: 'OLAP · columnar, real-time',
      about: 'An OLAP database: built for a few heavy queries that scan and aggregate billions of rows, not for row-by-row updates. Data is stored by column and compressed. It ingests from Kafka in batches; each batch becomes an immutable "part" that background merges combine. Queries, inserts and merges share one machine\'s CPU, so heavy dashboards can starve ingestion.',
      cores: 16, qCost: 0.11, shared: true, parts: true, crash: true, baseLat: 0.05, ingestDelay: 0, insertMax: 9000, qmax: 150,
      spec: { cores: 16, ramGB: 64, diskGB: 1000 }, cost: () => vm(0.768) + 1000 * 0.08, basis: 'm5.4xlarge (16 vCPU, 64 GB) at $0.77/h + 1 TB disk; you run it',
    },
    redshift: {
      name: 'AWS Redshift', vendor: 'AWS', logo: badge('RS', AWS), kind: 'OLAP · cloud data warehouse (cluster)',
      about: 'AWS\'s columnar warehouse, run as a cluster you size. Loading and queries share the cluster, so heavy queries slow ingestion, but a workload manager queues excess queries instead of letting them crash it. Built for scheduled reporting more than sub-second dashboards.',
      cores: 16, qCost: 0.2, shared: true, parts: false, crash: false, baseLat: 0.3, ingestDelay: 10, insertMax: 9000, qmax: 500,
      spec: { cores: 16, ramGB: 128, diskGB: 1000 }, cost: () => vm(1.086, 4), basis: '4 × ra3.xlplus nodes at $1.09/h each',
    },
    snowflake: {
      name: 'Snowflake', vendor: 'Multi-cloud', logo: icon(siSnowflake), kind: 'OLAP · cloud data warehouse', managedDisk: true,
      about: 'An OLAP warehouse that separates storage from compute. Data lives in cloud object storage with no capacity limit; queries run on a "virtual warehouse" (16 cores here) you can resize or pause. Loading is done by a separate service (Snowpipe) in micro-batches, so queries never starve ingestion — but data arrives about a minute late, and each query is slower than ClickHouse. When the warehouse is busy, queries queue rather than crash it.',
      cores: 16, qCost: 0.3, shared: false, parts: false, crash: false, baseLat: 0.4, ingestDelay: 45, insertMax: 9000, qmax: 600,
      spec: { cores: 16, ramGB: 64, diskGB: 1000 }, cost: (n) => 4 * 3 * HOURS + n.diskGB * 0.023, basis: 'Medium warehouse running 24/7: 4 credits/h at ~$3 per credit, plus storage',
    },
    bigquery: {
      name: 'BigQuery', vendor: 'Google Cloud', logo: icon(siGooglebigquery), kind: 'OLAP · serverless warehouse', serverless: true, managedDisk: true,
      about: 'A serverless OLAP warehouse: no machines, no sizing. Each query borrows compute "slots" from a huge shared pool, so concurrency is rarely the limit and nothing can crash. The cost is latency — even a small query takes around a second — and you pay per byte scanned, which adds up fast under constant dashboard traffic.',
      cores: 100, qCost: 0.2, shared: false, parts: false, crash: false, baseLat: 1.0, ingestDelay: 3, insertMax: 20000, qmax: 2000,
      spec: { cores: 0, ramGB: 0, diskGB: 1000 },
      cost: (n) => ((n.outRate * 200e6 * SECONDS) / TIB) * 6.25 + gbMonth(n.insertRate * 2e3) * 0.05 + n.diskGB * 0.02,
      basis: 'On demand: $6.25 per TiB scanned (assuming 200 MB per query), plus streaming inserts and storage',
    },
  },

  // ------------------------------------------------------------------ lake query engine (node id "trino")
  // costMul: CPU per query vs Trino · noCrash
  trino: {
    trino: {
      name: 'Trino', vendor: 'Self-hosted', logo: icon(siTrino), kind: 'Lake query engine',
      about: 'Runs SQL directly on the Parquet files in the lake — it stores nothing itself. Compute and storage are separate, so you can scale either alone. Slower than an OLAP database per query, but it can reach all history cheaply.',
      costMul: 1, cost: () => vm(0.768), basis: 'm5.4xlarge (16 vCPU, 64 GB) at $0.77/h',
    },
    athena: {
      name: 'AWS Athena', vendor: 'AWS', logo: badge('ATH', AWS), kind: 'Serverless lake queries', serverless: true, noCrash: true,
      about: 'A serverless query service from AWS, built on Trino: there is no cluster to run — you submit SQL and it reads the files in S3. You pay for the data each query scans, so well-partitioned, compacted Parquet matters twice — for speed and for the bill. Concurrency is capped by an account quota rather than by machines.',
      costMul: 0.8, cost: (n) => ((n.outRate * 40e6 * SECONDS) / 1e12) * 5, basis: '$5 per TB scanned (~40 MB of Parquet per query)',
    },
    spark: {
      name: 'Spark SQL', vendor: 'Self-hosted', logo: icon(siApachespark), kind: 'Batch query engine',
      about: 'A general-purpose engine built for large batch jobs. It survives failures mid-query and handles huge joins, but has more start-up overhead, so interactive queries are noticeably slower than on Trino.',
      costMul: 2.5, noCrash: true, cost: () => vm(0.768), basis: 'm5.4xlarge (16 vCPU, 64 GB) at $0.77/h',
    },
  },

  // ------------------------------------------------------------------ dashboards
  bi: {
    grafana: {
      name: 'Grafana', vendor: 'Self-hosted', logo: icon(siGrafana), kind: 'Dashboards (open source)',
      about: 'Open-source dashboards aimed at live operational metrics. Panels refresh every few seconds, which is exactly the constant query load that real-time OLAP databases are built for.',
      cost: () => vm(0.17), basis: 'One c5.xlarge to host it at $0.17/h',
    },
    superset: {
      name: 'Apache Superset', vendor: 'Self-hosted', logo: icon(siApachesuperset), kind: 'BI tool (open source)',
      about: 'An open-source BI tool: charts, dashboards and a SQL editor for analysts. Free software; you pay for the machine and for running it.',
      cost: () => vm(0.17), basis: 'One c5.xlarge to host it at $0.17/h',
    },
    metabase: {
      name: 'Metabase', vendor: 'Self-hosted', logo: icon(siMetabase), kind: 'BI tool (open source)',
      about: 'An open-source BI tool designed so people who do not write SQL can still ask questions of the data.',
      cost: () => vm(0.17), basis: 'One c5.xlarge to host it at $0.17/h',
    },
    tableau: {
      name: 'Tableau', vendor: 'SaaS', logo: badge('T', '#e97627'), kind: 'BI tool (commercial)', serverless: true,
      about: 'A commercial BI product with polished visual analysis. Nothing to host, but it is licensed per person, so the cost depends on how many analysts you have rather than how much data.',
      cost: () => 20 * 75, basis: '20 Creator licences at $75 per user per month',
    },
    quicksight: {
      name: 'Amazon QuickSight', vendor: 'AWS', logo: badge('QS', AWS), kind: 'Managed BI', serverless: true,
      about: 'AWS\'s managed BI service. No servers, priced per author and per reader, and tightly integrated with Athena and Redshift.',
      cost: () => 20 * 24, basis: '20 authors at $24 per user per month',
    },
    looker: {
      name: 'Looker Studio', vendor: 'Google Cloud', logo: icon(siLooker), kind: 'Managed BI', serverless: true,
      about: 'Google\'s free hosted dashboard tool. It costs nothing itself — but every chart refresh runs queries on your warehouse, so on BigQuery the dashboards are where the bill comes from.',
      cost: () => 0, basis: 'Free; you pay for the queries it runs',
    },
  },
};

export const DEFAULT_TECH = {
  lb: 'nginx', web: 'ec2', cache: 'redis', db: 'postgres', queue: 'rabbitmq', worker: 'ec2',
  kafka: 'kafka', consumer: 'flink', lake: 's3iceberg', clickhouse: 'clickhouse', trino: 'trino', bi: 'grafana',
};

export { HOURS, SECONDS, GB };

// ---- logo rendering -------------------------------------------------------

const isLight = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150;
};

// Inline SVG badge: brand colour tile with the glyph (or letters) on top.
export function logoSVG(logo, size = 16) {
  if (!logo) return '';
  const fg = isLight(logo.color) ? '#0b0b0b' : '#ffffff';
  const inner = logo.path
    ? `<path transform="translate(4.2 4.2) scale(0.65)" d="${logo.path}" fill="${fg}"/>`
    : `<text x="12" y="${logo.text.length > 2 ? 15.2 : 16}" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700" font-size="${logo.text.length > 2 ? 8.5 : logo.text.length > 1 ? 11 : 14}" fill="${fg}">${logo.text}</text>`;
  return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5" fill="${logo.color}" stroke="rgba(255,255,255,0.25)" stroke-width="0.6"/>${inner}</svg>`;
}

// The same badge drawn on a canvas, for use as a texture in the 3D scene.
export function logoCanvas(logo, px = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  g.scale(px / 24, px / 24);
  g.fillStyle = logo.color;
  g.beginPath();
  g.roundRect(0.5, 0.5, 23, 23, 5);
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.3)';
  g.lineWidth = 0.6;
  g.stroke();
  g.fillStyle = isLight(logo.color) ? '#0b0b0b' : '#ffffff';
  if (logo.path) {
    g.translate(4.2, 4.2);
    g.scale(0.65, 0.65);
    g.fill(new Path2D(logo.path));
  } else {
    const n = logo.text.length;
    g.font = `700 ${n > 2 ? 8.5 : n > 1 ? 11 : 14}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.fillText(logo.text, 12, n > 2 ? 15.2 : 16);
  }
  return c;
}
