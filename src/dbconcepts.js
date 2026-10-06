// Content for the database guide (dbguide.js): the engines at a glance, and the mechanisms every
// database is built from. General knowledge, written to be read next to the simulator; where a
// mechanism is modelled here, `tryIt` says where to see it, and quotes the model's own numbers.

// One row per engine: the handful of properties that decide most choices.
// [data model, joins, transactions, how writes scale, what a read sees, who runs it]
export const AT_A_GLANCE = {
  postgres: ['Relational tables', 'Yes', 'Full, multi-row', 'One primary; shard by hand', 'Latest (replicas may lag)', 'You'],
  mysql: ['Relational tables', 'Yes', 'Full, multi-row', 'One primary; shard by hand', 'Latest (replicas may lag)', 'You'],
  rds: ['Relational tables', 'Yes', 'Full, multi-row', 'One primary', 'Latest (replicas may lag)', 'AWS'],
  aurora: ['Relational tables', 'Yes', 'Full, multi-row', 'One primary', 'Latest (replicas lag by milliseconds)', 'AWS'],
  cloudsql: ['Relational tables', 'Yes', 'Full, multi-row', 'One primary', 'Latest (replicas may lag)', 'Google'],
  spanner: ['Relational tables', 'Yes', 'Full, across machines and regions', 'Scales out by itself', 'Always the latest', 'Google'],
  cassandra: ['Wide rows grouped by partition key', 'No', 'Within one partition only', 'Scales out; any node takes writes', 'Possibly stale, unless you ask for a quorum', 'You'],
  bigtable: ['Wide rows sorted by row key', 'No', 'Within one row only', 'Scales out by itself', 'Latest within one cluster', 'Google'],
  dynamodb: ['Items found by key', 'No', 'Up to 100 items at a time', 'Scales out by itself', 'Possibly stale by default; latest on request', 'AWS'],
  clickhouse: ['Columns, sorted by a key', 'Yes, but large ones strain memory', 'None across rows', 'Bulk inserts; shards you manage', 'Latest after each batch lands', 'You'],
  redshift: ['Columns', 'Yes', 'Full', 'Resize the cluster', 'Latest', 'AWS (you size it)'],
  snowflake: ['Columns', 'Yes', 'Full', 'Add compute, separate from storage', 'Latest', 'Snowflake'],
  bigquery: ['Columns', 'Yes', 'Full', 'Nothing to size', 'Latest', 'Google'],
};
export const GLANCE_COLUMNS = ['Data model', 'Joins', 'Transactions', 'Growing writes', 'A read sees', 'Run by'];

// The mechanisms. `what` paragraphs, then pros / cons, how the engines here differ, and where to see it.
export const MECHANICS = [
  {
    id: 'indexes',
    title: 'Indexes',
    one: 'A sorted side-structure that turns "scan every row" into "walk a few steps".',
    what: [
      'A table on its own is an unordered pile of rows: finding one means reading them all. An <b>index</b> is a second structure, usually a <b>B-tree</b>, that keeps one or more columns in sorted order with a pointer to each row. A lookup walks from the root through a few levels to a leaf, so a table of a billion rows is searched in about four steps.',
      'An index helps only the queries that filter or sort on its leading columns. A <b>composite</b> index on (customer, date) serves "this customer\'s recent orders" but not "all orders on this date". A <b>covering</b> index holds every column the query needs, so the table itself is never touched.',
    ],
    pros: ['Lookups and range scans read a handful of pages instead of the whole table', 'Can enforce uniqueness', 'Sorted output comes for free'],
    cons: ['Every insert and update must also change every index: this is most of why a write costs several times a read', 'Each one takes disk and memory', 'An index on a column with few distinct values is rarely used at all'],
    engines:
      'PostgreSQL and MySQL offer many index types and let you add them at any time. DynamoDB gives you the primary key plus secondary indexes that you pay to keep updated and that can lag the table. Cassandra and Bigtable expect you to design the key so that the queries you need are lookups by it. ClickHouse keeps a sparse index on its sort key: enough to skip most of the data, not to find one row quickly.',
    tryIt: 'Zoom into the OLTP database and choose "Database internals". Each read walks an index tree from root to leaf and then to a row; each write lights a row <i>and</i> an index leaf. In this model a PostgreSQL write costs 4 times a read.',
  },
  {
    id: 'partitioning',
    title: 'Partitioning',
    one: 'One big table split into pieces inside one database, usually by date.',
    what: [
      'A <b>partitioned</b> table is stored as many smaller tables, split on a column such as the month. A query that filters on that column reads only the partitions that can match, which is called pruning. Dropping a month of old data becomes deleting one partition instead of deleting a billion rows one at a time.',
      'Everything still lives on one machine. Partitioning makes a large table manageable; it does not make the database able to take more writes. The word is also used differently by Cassandra and DynamoDB, where a "partition" is a slice of data on a particular node: that is sharding, below.',
    ],
    pros: ['Queries on the partition column skip most of the data', 'Each partition\'s indexes are small enough to stay in memory', 'Old data is removed or archived instantly'],
    cons: ['No extra write capacity: it is still one machine', 'A query that does not filter on the partition column reads every partition', 'Thousands of partitions slow down query planning', 'Unique constraints must include the partition column'],
    engines:
      'PostgreSQL and MySQL partition by range, list or hash. ClickHouse tables are almost always partitioned by month, and its "parts" are merged within a partition. In BigQuery and Athena partitioning is a cost control as much as a speed one, because you are billed for the bytes a query scans.',
    tryIt: 'Not modelled as a control here. The closest thing to watch is the data lake: turn off Iceberg compaction and the count of small files climbs until every query slows, which is the same "too many pieces" problem.',
  },
  {
    id: 'sharding',
    title: 'Sharding',
    one: 'The data split across machines by a key, each with its own primary.',
    what: [
      '<b>Sharding</b> puts different rows on different machines: every row has a <b>shard key</b> (a user id, a tenant), and a hash or range of that key decides which shard owns it. Each shard takes its own writes, so capacity grows with the number of shards. It is the only way past the write limit of a single primary.',
      'The price is that the database stops being one thing. A query that carries the shard key goes to one machine; one that does not must ask every shard and merge the answers. A transaction that touches two shards needs a slow two-phase commit. And load is never even: one large customer or one celebrity makes one shard hot while the rest sit idle.',
    ],
    pros: ['Write capacity grows with the number of shards', 'A failure takes out one slice of the data, not all of it', 'Each shard\'s data and indexes stay small'],
    cons: ['Queries without the shard key hit every shard', 'Joins and transactions across shards are slow or unavailable', 'The busiest shard fills up long before the average one', 'Changing the shard key or the shard count later is a major migration'],
    engines:
      'PostgreSQL and MySQL do not shard themselves: the application does it, or a layer such as Citus or Vitess. Cassandra, DynamoDB, Bigtable and Spanner shard automatically and move data as it grows, which is much of the reason to choose them.',
    tryIt: 'Under Architecture, raise "Database shards" from 1 to 4 at a write-heavy load. Capacity rises about 3.2 times, not 4: the model sends 5% of queries to more than one shard and lets the busiest shard carry up to 25% more than its even share.',
  },
  {
    id: 'replication',
    title: 'Replication',
    one: 'Copies of the same data on other machines, for reads and for survival.',
    what: [
      'The common form is <b>leader and followers</b>: one primary takes every write and streams its log of changes to replicas, which replay it. Replicas can answer reads, and one can be promoted if the primary dies. If the primary waits for a replica to confirm each write (<b>synchronous</b>) nothing is lost in a failover but every write is slower; if it does not wait (<b>asynchronous</b>) writes are fast and the last few can be lost.',
      'Replicas are always slightly behind. A user who saves a change and immediately reloads from a replica may not see it. And because every replica must replay every write, adding replicas does nothing for a write-heavy load. The alternative designs give up the single leader: <b>leaderless</b> systems let any node take a write and settle disagreements with quorums, and <b>consensus</b> systems make a majority agree on every write.',
    ],
    pros: ['Read capacity grows with each replica', 'A dead primary is replaced in seconds to minutes instead of restored from backup', 'A copy can sit near users in another region'],
    cons: ['Replicas lag, so reads from them can be stale', 'No extra write capacity', 'Waiting for replicas slows every write; not waiting risks losing the latest ones', 'Failover is its own source of outages when two nodes both believe they are the primary'],
    engines:
      'PostgreSQL and MySQL stream their log to followers. Aurora\'s replicas share one storage layer with the primary, so they lag by milliseconds. Cassandra is leaderless: you choose per query how many copies must answer. Spanner runs consensus on every write, which is why its commits are slower and its reads are never stale. DynamoDB keeps three copies across zones without telling you.',
    tryIt: 'Remove the cache and set writes to 2%: add read replicas and the database recovers. Raise writes to 40% and the replicas stop helping and fall behind (watch "Replication lag"). Then kill the database: with a replica, writes fail for about 30 seconds during promotion while reads continue; without one, everything fails until it restarts.',
  },
  {
    id: 'matviews',
    title: 'Materialized views',
    one: 'A query\'s answer stored as a table, so the expensive work is done once.',
    what: [
      'An ordinary view is a saved query that runs every time you read it. A <b>materialized view</b> stores the result. A dashboard that needs "revenue per country per day" reads a few thousand precomputed rows instead of aggregating a billion on every load.',
      'The stored answer goes out of date as the underlying tables change, so it must be refreshed. A <b>full refresh</b> recomputes everything on a schedule: simple, but the data is as stale as the schedule and the refresh itself is heavy. An <b>incremental</b> view is updated as each row arrives: always fresh, but every insert now does extra work.',
    ],
    pros: ['Turns a heavy aggregation or join into a cheap read', 'Keeps dashboards fast without touching application code', 'Incremental views stay fresh to the second'],
    cons: ['Stale between refreshes, or extra work on every insert', 'Uses storage for data you already have', 'One more thing that can silently be wrong or out of date'],
    engines:
      'PostgreSQL refreshes a materialized view only when told to, by recomputing it. In ClickHouse a materialized view is a trigger on insert, which makes it incremental and is also how ClickHouse moves rows out of its Kafka engine into a real table. Redshift\'s streaming ingestion is likewise a materialized view over the topic. BigQuery and Snowflake maintain theirs automatically and charge for the upkeep. DynamoDB and Cassandra have nothing reliable here: you precompute in the application.',
    tryIt: 'Select the OLAP database and read "Reads Kafka through" in its live metrics: for ClickHouse and Redshift the answer is a built-in engine feeding a materialized view. Then push dashboard queries past about 100 a second and watch queries starve ingestion, which is the load precomputed views exist to remove.',
  },
  {
    id: 'transactions',
    title: 'Transactions and isolation',
    one: 'Several changes that succeed or fail together, as if nobody else were writing.',
    what: [
      'A <b>transaction</b> groups operations so that either all of them happen or none do: money leaves one account and arrives in another, or neither. <b>Isolation</b> decides what concurrent transactions see of each other. At the strict end (<b>serializable</b>) the result is as if they ran one after another; weaker levels allow more to run at once and let through specific anomalies, such as two people each booking the last seat.',
      'Most databases implement this by keeping several versions of a row, so readers never block writers. The cost appears under contention: transactions that conflict must wait or be retried, and a long-running one holds old versions alive for everyone.',
    ],
    pros: ['Invariants hold: no half-finished transfers, no double-spent stock', 'Application code does not have to handle partial failure', 'Readers get a consistent snapshot'],
    cons: ['Conflicting transactions wait or are aborted and retried', 'Across shards they need two-phase commit, which is slow and fragile', 'Long transactions bloat the database and block cleanup'],
    engines:
      'PostgreSQL, MySQL and the managed versions of them give full multi-row transactions on one primary. Spanner extends them across machines and regions, at the cost of slower commits. DynamoDB allows up to 100 items in one transaction; Cassandra and Bigtable keep them within one partition or row. The OLAP engines here are built for bulk loads and big reads, not for this.',
    tryIt: 'Not modelled directly. Its shadow is in the sharding numbers: 5% of writes are assumed to touch two shards and cost more, which is the price of a cross-shard transaction.',
  },
  {
    id: 'wal',
    title: 'The write-ahead log',
    one: 'Every change is appended to a log on disk before it is acknowledged.',
    what: [
      'Updating data in place means random writes all over the disk, and a crash halfway through leaves it corrupt. So a database first appends a description of the change to a sequential <b>write-ahead log</b> and forces it to disk; only then does it say "committed". The data files themselves are updated later, in the background. After a crash it replays the log from the last checkpoint.',
      'The same log is what replicas consume, and what change-data-capture tools read to feed search indexes, caches and warehouses. It is the most important file in the database.',
    ],
    pros: ['A committed write survives a crash', 'Sequential appends are the fastest thing a disk does', 'The basis of replication, point-in-time recovery and change streams'],
    cons: ['Every change is written twice: once to the log, once to the data files', 'How fast the disk can confirm an append caps how fast you can commit', 'The log must be shipped, archived and eventually discarded'],
    engines:
      'PostgreSQL calls it the WAL; MySQL has a redo log plus a binlog for replication; Cassandra a commit log in front of its in-memory table. Aurora goes furthest: the storage layer is the log, shared by every replica.',
    tryIt: 'Zoom into the OLTP database: the strip on the right is the log, advancing with every write, with the replicas that replay it beside it. Its label changes with the engine: WAL, redo log, commit log.',
  },
  {
    id: 'pooling',
    title: 'Connections and pooling',
    one: 'A database can hold far fewer connections than an application wants to open.',
    what: [
      'Opening a connection is expensive, and holding one costs the database memory: in PostgreSQL each is a whole operating-system process. A database that serves thousands of queries a second may allow only a few hundred connections. An application therefore keeps a small <b>pool</b> of open connections and lends one to each request for a few milliseconds.',
      'When queries slow down, each one holds its connection longer, the pool runs dry, and requests queue for a connection: the web tier looks dead although its CPUs are idle. Fleets of small processes and serverless functions make this worse, since each one wants its own connections; a separate <b>pooler</b> in front of the database fixes that.',
    ],
    pros: ['Thousands of requests share a few dozen connections', 'Protects the database\'s memory from a traffic spike', 'No connection setup on each request'],
    cons: ['A dry pool looks exactly like a slow database', 'Pooling per transaction breaks features that depend on a session', 'One more hop and one more thing to size'],
    engines:
      'PostgreSQL needs a pooler (PgBouncer, RDS Proxy) sooner than MySQL, whose connections are threads. DynamoDB, Bigtable and Spanner are reached over stateless HTTP or gRPC calls and have no connection limit to exhaust.',
    tryIt: 'Push the OLTP database past its capacity and watch "Connections open" reach its limit; PostgreSQL then falls over with "connection pool exhausted" while the web servers report their thread pools stuck waiting. Switch the engine to DynamoDB and the same overload is throttled instead.',
  },
];
