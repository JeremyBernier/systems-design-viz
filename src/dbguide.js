import { TECH, logoSVG } from './tech.js';
import { fmtUSD } from './cost.js';
import { fmtDur } from './sim.js';

// The database guide: a dialog opened from the detail panel of the database or the OLAP database.
// Three tabs — the engines in the catalog side by side, the concepts behind their differences, and
// a few "which would you pick?" scenarios. The prose here is general knowledge about each engine;
// every number in the "In this simulator" column is read from tech.js, so it cannot drift from
// what the simulation actually does.

const $ = (id) => document.getElementById(id);

// Families group engines that make the same basic trade. `type` is the component they belong to.
const FAMILIES = [
  {
    type: 'db',
    name: 'Relational, single primary',
    engines: ['postgres', 'mysql', 'rds', 'aurora', 'cloudsql'],
    trade: 'Tables, joins and multi-row ACID transactions, with one machine (the primary) taking every write. You can ask questions you did not plan for, and the database enforces your invariants. The price is a write ceiling: reads scale out with replicas, writes only by buying a bigger machine or sharding.',
    pick: 'The default. Choose it unless you can name the specific limit you will hit.',
  },
  {
    type: 'db',
    name: 'Distributed SQL',
    engines: ['spanner'],
    trade: 'Keeps SQL and ACID transactions but splits the data over many machines, each split replicated by a consensus protocol. Writes are no longer limited to one machine. The price is latency and money: every write waits for a majority of replicas to agree, and a transaction touching several splits needs a two-phase commit on top.',
    pick: 'You need transactions and you have outgrown one primary, or you need the same strongly consistent data in several regions.',
  },
  {
    type: 'db',
    name: 'Wide-column (NoSQL)',
    engines: ['cassandra', 'bigtable'],
    trade: 'Rows are found by key, sorted within a partition, and spread over nodes automatically. Writes are appends, so they are about as cheap as reads, and capacity grows by adding nodes. The price is flexibility: no joins, and you design each table around one query. A new question usually means a new table.',
    pick: 'Very high write volume with access patterns you know in advance: time series, event logs, messages, counters.',
  },
  {
    type: 'db',
    name: 'Managed key-value',
    engines: ['dynamodb'],
    trade: 'Get and put an item by its key, with the provider running the partitions. Nothing to operate, and lookups stay fast at any size. The price is the same loss of flexibility as wide-column stores, plus a bill tied directly to throughput: go over capacity and requests are throttled.',
    pick: 'Lookups by a known key, spiky or unpredictable load, and a team that does not want to run a database.',
  },
  {
    type: 'clickhouse',
    name: 'OLAP: self-managed columnar',
    engines: ['clickhouse'],
    trade: 'Stores each column separately and compressed, so a query that sums one column over a billion rows reads only that column. Very fast for aggregation. The price: changing or deleting a single row is an expensive rewrite, and on one machine queries, inserts and merges compete for the same CPU.',
    pick: 'Dashboards and user-facing analytics that must answer in well under a second on fresh data.',
  },
  {
    type: 'clickhouse',
    name: 'OLAP: cloud data warehouses',
    engines: ['redshift', 'snowflake', 'bigquery'],
    trade: 'Columnar too, but run by a provider and built for large, complex SQL across the whole company\'s data. Snowflake and BigQuery separate storage from compute, so capacity is elastic and queries do not starve loading. The price is latency (queries take from a few hundred milliseconds to seconds) and a bill that follows usage.',
    pick: 'Reporting, ad-hoc analysis and data science, where a second or two per query is fine.',
  },
];

// Per engine: what it is good at and what you give up for it.
const ENGINES = {
  postgres: {
    strong: 'Joins, constraints and multi-row ACID transactions. Rich index types (JSON, full-text, geospatial with PostGIS). Free, and runs anywhere.',
    giveUp: 'One primary takes every write. Each connection is a process, so a busy service needs a connection pooler. Backups, failover and upgrades are your job.',
  },
  mysql: {
    strong: 'The same relational model. Connections are threads, so it tolerates more of them. Long track record in large sharded fleets (Vitess grew up at YouTube).',
    giveUp: 'The same single write primary. Fewer advanced SQL and index features than PostgreSQL. You run it.',
  },
  rds: {
    strong: 'PostgreSQL with backups, patching and failover to a standby handled by AWS.',
    giveUp: 'Roughly twice the price of the bare VM. The engine\'s limits are unchanged. No access to the host, and only the extensions AWS allows.',
  },
  aurora: {
    strong: 'Storage is replicated six ways over three zones and grows by itself. Replicas read the same storage as the writer, so they lag very little, and failover is quick.',
    giveUp: 'Still one writer. AWS only. Instance-hours cost more than plain RDS, and I/O is billed separately unless you pay for the I/O-Optimized tier.',
  },
  cloudsql: {
    strong: 'Google Cloud\'s counterpart of RDS: managed PostgreSQL or MySQL with backups and failover run for you.',
    giveUp: 'The same single-primary limits, at a managed-service price. Google Cloud only.',
  },
  spanner: {
    strong: 'SQL and ACID transactions across rows that live on different machines. Write capacity grows by adding nodes. Replication across zones or regions is synchronous, so a failover loses nothing.',
    giveUp: 'Each write waits for a majority of replicas, so it is slower than a write to a single primary. Expensive at small scale. Google Cloud only. Keys that only ever increase (timestamps, sequences) pile writes onto one split.',
  },
  cassandra: {
    strong: 'Every node accepts writes, so there is no primary to fail over. Capacity grows linearly with nodes. Replication across datacenters is built in. Consistency is chosen per query, from one replica to all of them.',
    giveUp: 'No joins, and a query must name the partition key. Concurrent writes to the same cell are resolved by timestamp: the last one wins, silently. Compaction and repair are real operational work.',
  },
  dynamodb: {
    strong: 'Nothing to operate. Key lookups take single-digit milliseconds at any table size. No connections to exhaust.',
    giveUp: 'You can only query by the key or by a secondary index you declared. Items are capped at 400 KB. Over capacity, or with one hot key, requests are throttled. Reads are eventually consistent unless you ask, and pay double, for strong ones. AWS only.',
  },
  bigtable: {
    strong: 'Very high read and write throughput by row key, and fast scans over a range of sorted keys. Scales linearly with nodes. Well suited to time series and counters.',
    giveUp: 'The row key is the only index. No joins, no secondary indexes, and transactions cover a single row. A badly chosen row key sends all the traffic to one node. Google Cloud only.',
  },
  clickhouse: {
    strong: 'Sub-second aggregations over billions of rows. Fast ingestion straight from Kafka. Open source, on your own machines.',
    giveUp: 'Updating or deleting individual rows is a slow background rewrite. No multi-statement transactions. Heavy queries, inserts and merges share the CPU. You run it.',
  },
  redshift: {
    strong: 'A mature SQL warehouse that fits into the rest of AWS. A workload manager queues excess queries rather than letting them overload the cluster.',
    giveUp: 'In its provisioned form, a cluster you size yourself, with loading and queries sharing it. Built for reporting more than for sub-second dashboards.',
  },
  snowflake: {
    strong: 'Storage and compute are separate: several warehouses can query the same data without getting in each other\'s way, and compute can be paused when idle. Runs on all three big clouds.',
    giveUp: 'You pay for every second a warehouse is running, so an always-on dashboard is costly. Loaded continuously with Snowpipe, data arrives in micro-batches about a minute behind.',
  },
  bigquery: {
    strong: 'No capacity to plan and nothing to size: each query borrows compute from a shared pool, so very large scans just work.',
    giveUp: 'Even a small query takes around a second. On-demand billing is per byte scanned, so a careless query on a big table is an expensive one. Google Cloud only.',
  },
};

// What the simulation assumes about each engine, read straight from the catalog.
function simFacts(type, e) {
  if (type === 'db')
    return [
      `${e.cap.toLocaleString()} reads/s`,
      e.writeCost === 1 ? 'a write costs the same as a read' : `a write costs ${e.writeCost} reads`,
      e.conns ? `${e.conns.toLocaleString()} connections` : 'no connection limit',
      e.repl ? `failover in ~${fmtDur(e.repl.failover)}` : 'scales out by itself: no replica or shard controls',
    ];
  return [
    `${fmtDur(e.baseLat)} per query when idle`,
    e.ingestDelay ? `new data queryable after ~${fmtDur(e.ingestDelay)}` : 'new data queryable at once',
    e.shared ? 'queries and inserts share CPU' : 'queries cannot starve inserts',
    e.crash ? 'can be overloaded until it crashes' : 'queues excess queries',
  ];
}

// Each concept ends with something to try in the simulator, so the claim can be checked rather than believed.
const CONCEPTS = [
  {
    title: 'OLTP or OLAP: what shape are the queries?',
    body: [
      'An <b>OLTP</b> database serves the application: thousands of small operations a second, each reading or changing a handful of rows ("fetch this user", "insert this order"). It stores data <b>by row</b>, so everything about one record sits together and can be fetched or updated in one place.',
      'An <b>OLAP</b> database answers questions about the whole dataset: a few heavy queries that scan millions of rows but only some columns ("revenue per country per day"). It stores data <b>by column</b>, so a query reads only the columns it needs, and similar values next to each other compress well.',
      'Each is bad at the other\'s job. An aggregate over a year of orders in a row store reads every column of every row; a single-row update in a column store touches one file per column. That is why this diagram has both, with a stream carrying events from one side to the other.',
    ],
    tryIt: 'Select the database, then the OLAP database, and compare the "Live metrics": one counts thousands of small operations, the other a handful of expensive queries.',
  },
  {
    title: 'Data model: how much does the database know about your data?',
    body: [
      '<b>Relational</b>: tables with a fixed schema, related by keys and combined with joins. You store each fact once and can ask questions nobody planned for. The database enforces constraints such as uniqueness and foreign keys.',
      '<b>Key-value and document</b>: an item is fetched by its key. Anything else needs a secondary index declared in advance. Simple to spread over many machines, because an item lives wherever its key hashes to.',
      '<b>Wide-column</b>: rows are grouped into partitions by a partition key and kept sorted inside each one. "The latest 50 messages in this conversation" is one sequential read of one partition. Anything that crosses partitions is slow or not offered at all.',
      'The pattern: the less the database lets you ask, the easier it is to scale. With a relational database you model the data and work out the queries later. With the others you list the queries first and design a table for each, often storing the same data several times.',
    ],
    tryIt: 'Switch the YouTube preset\'s database from Cassandra to PostgreSQL and raise traffic: the flexible engine reaches its ceiling much sooner.',
  },
  {
    title: 'Scaling: where do writes go?',
    body: [
      '<b>Single primary with replicas.</b> One machine takes every write and ships its log to replicas, which serve reads. Read capacity scales with replicas. Write capacity does not: every replica has to replay every write as well.',
      '<b>Sharding.</b> Split the data over several primaries by a shard key. Write capacity multiplies, but a query that spans shards has to ask all of them, a transaction across shards is hard, and one very popular key can overload its shard while the others sit idle.',
      '<b>Leaderless.</b> Any node takes a write and passes it on to the other replicas (Cassandra, and the Dynamo design it descends from). There is no failover, because there is no primary. Two nodes can accept conflicting writes, and something has to decide which survives.',
      '<b>Distributed SQL.</b> The database shards itself, and each shard is a small group of replicas that agree on every write by consensus (Spanner). You keep transactions and lose some speed on each write.',
    ],
    tryIt: 'Load the Uber preset (45% writes), raise traffic until the database is overloaded and add read replicas: nothing improves. Add shards instead and the write ceiling moves.',
  },
  {
    title: 'Consistency: what does a read see?',
    body: [
      '<b>Transactions (ACID)</b> group several changes so that they all happen or none do, and so that concurrent transactions do not see each other\'s half-finished work. This is what stops two people buying the same seat. Relational and distributed SQL engines provide it across any rows. Most NoSQL engines provide it for one row or item, or for small, limited groups.',
      '<b>Replication lag.</b> With asynchronous replication, a write is acknowledged before the replicas have it. A read from a replica can miss a write the same user just made, and if the primary dies, the last few writes can be lost. Synchronous replication closes that gap by making each write wait for a replica.',
      '<b>Quorums.</b> Leaderless stores let you choose per query. With N copies, if a write waits for W of them and a read asks R, then R + W > N means every read reaches at least one copy that has the latest acknowledged write. Smaller numbers are faster and stay available with more nodes down, and may return stale data.',
      '<b>The CAP trade.</b> When the network splits replicas into groups that cannot talk, a system has two options: refuse the requests it cannot confirm with the other side (staying consistent), or keep answering and risk stale or conflicting data (staying available). It cannot do both. Without a split, the same trade shows up as latency: waiting for more replicas is slower.',
    ],
    tryIt: 'Give PostgreSQL a read replica, push traffic until "replication lag" appears in its metrics, then press "Kill this node" on the database to watch a failover.',
  },
  {
    title: 'Storage engine: B-tree or LSM-tree?',
    body: [
      'A <b>B-tree</b> keeps data in sorted pages and changes them in place (PostgreSQL and MySQL indexes). A read is one walk down the tree. A write has to find the right page and update it, plus a log entry for crash safety, which means random I/O.',
      'An <b>LSM-tree</b> appends every write to an in-memory table and flushes it to disk as a sorted, immutable file (Cassandra and Bigtable; ClickHouse\'s immutable parts and background merges follow the same idea). Writes are sequential and cheap. A read may have to look in several files, and a background process must keep merging files (compaction), which takes I/O at times you do not choose.',
      'So: B-trees favour reads and predictable latency, LSM-trees favour write throughput.',
    ],
    tryIt: 'Compare "a write costs N reads" in the Engines tab: 4 for PostgreSQL, 1 for Cassandra and Bigtable. Then raise the Writes slider with each.',
  },
  {
    title: 'Who runs it?',
    body: [
      '<b>Self-hosted</b> is the cheapest per machine and gives full control. You are also the one doing backups, upgrades, failover drills and 3 a.m. recoveries.',
      '<b>Managed</b> (RDS, Cloud SQL, Aurora) is the same engine with that work done by the provider, at roughly twice the VM price.',
      '<b>Serverless</b> (DynamoDB, BigQuery) has no machines at all: you pay per request or per byte. Very cheap when idle or spiky, and potentially the largest line on the bill under heavy, steady load.',
      'Managed and serverless engines are usually tied to one cloud, which matters if you ever have to move.',
    ],
    tryIt: 'Switch between PostgreSQL, AWS RDS and DynamoDB at low and at high traffic, and watch the database line in the cost breakdown.',
  },
];

// Not graded: these are judgment calls, so each answer gives the reasoning and what would change it.
const SCENARIOS = [
  {
    q: 'A ticketing site must never sell the same seat twice. A big on-sale brings a burst of bookings, but most traffic is people browsing events.',
    a: '<b>Relational</b> (PostgreSQL or a managed version). The hard requirement is correctness under concurrency, and a transaction with a row lock or a conditional update is exactly that. The browsing load is reads, which a cache and replicas absorb. Move to sharding or distributed SQL only if booking writes outgrow one primary.',
  },
  {
    q: 'A ride-hailing app receives a location ping from every active driver every few seconds: hundreds of thousands of writes a second. Only each driver\'s latest position matters.',
    a: '<b>Wide-column or key-value</b> (Cassandra, Bigtable, DynamoDB), or an in-memory store if losing a few seconds of pings is acceptable. Writes dominate, every access is by driver ID, there are no joins, and a lost update is replaced by the next ping. Paying for relational guarantees here buys nothing.',
  },
  {
    q: 'The business team wants a dashboard of revenue per country per day over two years of order events, refreshed every few seconds.',
    a: '<b>An OLAP database</b>, fed from the event stream. This query scans a huge number of rows and few columns, the opposite of what the application database is built for; running it there would also slow down customers. ClickHouse if it must feel instant, a warehouse if a second or two is acceptable.',
  },
  {
    q: 'A three-person startup is building a product whose features change every week. Traffic is about 200 requests a second.',
    a: '<b>Managed PostgreSQL.</b> At this size any engine copes with the load, so the scarce things are engineering time and the freedom to change your mind. A relational schema lets you add queries without redesigning tables, and a managed service removes the operations work. Scaling problems are far away, and well understood when they arrive.',
  },
  {
    q: 'A global shop stores each customer\'s cart. Adding an item must always succeed, even if a datacenter is unreachable; a briefly out-of-date cart is acceptable.',
    a: '<b>A leaderless or managed key-value store</b> (Cassandra, DynamoDB with global tables). Access is by one key, the customer ID, and availability matters more than every replica agreeing at once. The cost to accept: two regions may take conflicting updates, so decide how carts merge. This is the case Amazon\'s original Dynamo paper was written about.',
  },
];

const TABS = [
  ['engines', 'Engines side by side'],
  ['concepts', 'Concepts'],
  ['pick', 'Which would you pick?'],
];

export function initDbGuide(ui, sim) {
  const dlg = document.createElement('dialog');
  dlg.id = 'dbguide';
  dlg.className = 'dlg';
  dlg.innerHTML = `
    <form method="dialog" class="pl-head"><div><h3>Databases and their tradeoffs</h3><p class="hint">No database is best at everything. Each one buys something — scale, speed, flexibility, safety, less work — by giving something else up.</p></div><button aria-label="Close">✕</button></form>
    <div class="seg dg-tabs" role="group" aria-label="Guide section">${TABS.map(([k, t]) => `<button data-tab="${k}">${t}</button>`).join('')}</div>
    <div class="dg-body" id="dg-body"></div>`;
  document.body.append(dlg);
  let tab = 'engines';
  let type = 'db'; // which component the guide was opened from

  const nodeOf = (t) => Object.values(sim.nodes).find((n) => n.type === t);
  const monthly = (t, e) => {
    try {
      return fmtUSD(e.cost(nodeOf(t), sim.params));
    } catch {
      return '—';
    }
  };

  const family = (f) => {
    const current = sim.techOf(f.type);
    return `<section class="dg-fam">
      <h2>${f.name}</h2>
      <p class="d-about">${f.trade}</p>
      <p class="dg-pick"><b>Pick it when:</b> ${f.pick}</p>
      <div class="dg-scroll"><table class="dg-table">
        <thead><tr><th>Engine</th><th>Good at</th><th>What you give up</th><th>In this simulator</th></tr></thead>
        <tbody>${f.engines
          .map((k) => {
            const e = TECH[f.type][k];
            const on = e === current;
            return `<tr${on ? ' class="on"' : ''}>
              <th><div class="dg-eng">${logoSVG(e.logo, 22)}<span>${e.name}<small>${e.vendor}</small></span></div>${
                on ? '<em>In use</em>' : `<button data-use="${f.type}:${k}" title="Switch the simulation to ${e.name}">Use</button>`
              }</th>
              <td>${ENGINES[k].strong}</td>
              <td>${ENGINES[k].giveUp}</td>
              <td><ul>${simFacts(f.type, e).map((s) => `<li>${s}</li>`).join('')}<li>${monthly(f.type, e)} per month</li></ul></td>
            </tr>`;
          })
          .join('')}</tbody>
      </table></div>
    </section>`;
  };

  const views = {
    engines: () =>
      // the families of the component the guide was opened from come first
      [...FAMILIES].sort((a, b) => (b.type === type) - (a.type === type)).map(family).join('') +
      `<p class="hint">"In this simulator" shows the model's assumptions for the machine size in the catalog (<code>src/tech.js</code>): round figures chosen to keep the engines in a realistic order, not benchmarks. Cost is the on-demand list price at the current size and load.</p>`,
    concepts: () =>
      CONCEPTS.map((c) => `<section class="dg-concept"><h2>${c.title}</h2>${c.body.map((p) => `<p class="d-about">${p}</p>`).join('')}<p class="dg-try"><b>Try it:</b> ${c.tryIt}</p></section>`).join(''),
    pick: () =>
      `<p class="hint">Decide before you open each answer. These are judgment calls rather than right-or-wrong questions: each answer gives the reasoning, and a good engineer could argue for an alternative.</p>` +
      SCENARIOS.map((s, i) => `<details class="dg-q"><summary><b>${i + 1}.</b> ${s.q}</summary><p class="d-about">${s.a}</p></details>`).join('') +
      `<h2>Questions that settle most choices</h2><ol class="tips">
        <li><b>How will the data be read?</b> By one key, by many different filters and joins, or by scanning everything?</li>
        <li><b>Reads or writes?</b> How many of each per second at peak, and will writes fit on one machine?</li>
        <li><b>What must never be wrong?</b> Money and inventory need transactions; a view counter does not.</li>
        <li><b>What happens during a failure?</b> Is it better to refuse a request or to serve stale data?</li>
        <li><b>Who will run it,</b> and what does it cost at ten times today's load?</li>
      </ol>`,
  };

  const render = () => {
    for (const b of dlg.querySelectorAll('[data-tab]')) b.setAttribute('aria-pressed', b.dataset.tab === tab);
    $('dg-body').innerHTML = views[tab]();
  };

  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) return dlg.close(); // click on the backdrop
    const t = e.target.closest('[data-tab]');
    if (t) {
      tab = t.dataset.tab;
      render();
      $('dg-body').scrollTop = 0;
      return;
    }
    const use = e.target.closest('[data-use]');
    if (!use) return;
    const [ty, key] = use.dataset.use.split(':');
    sim.setTech(ty, key);
    if (ui.selected) ui.select(ui.selected); // the detail panel names the engine
    ui.toast(`Switched to ${TECH[ty][key].name}.`, 'ok');
    render();
  });
  // Esc closes the dialog natively; keep it from also reaching the app's own Esc handler
  dlg.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation());

  // the button is part of the detail panel, which ui.js rebuilds on every selection
  $('detail').addEventListener('click', (e) => {
    const b = e.target.closest('#d-guide');
    if (!b) return;
    type = b.dataset.type;
    tab = 'engines';
    render();
    dlg.showModal();
    $('dg-body').scrollTop = 0;
  });
}
