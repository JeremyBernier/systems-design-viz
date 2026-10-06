// Content for the Kafka deep dive (kafkaui.js): the core concepts, then how to choose a partition
// key, with worked examples, a small model to try keys on, and questions to check yourself.
//
// The concepts are Apache Kafka's documented behaviour (defaults are those of Kafka 3.x and later).
// `sim` says where this simulator shows the idea; it is null where the simulator does not model it.
// The key playground computes its figures from generated events (keyModel below): nothing in its
// output is typed in. The quiz asks only about documented behaviour, never about judgment calls.

export const CONCEPTS = [
  {
    id: 'log',
    title: 'Topics and the log',
    one: 'A topic is a named stream of records. Kafka stores it as a log: records are only ever added at the end.',
    what: [
      'A producer <b>appends</b> a record (a key, a value and a timestamp) to a topic such as <code>trip-events</code>. Records are never changed in place, and reading one does not remove it. That is the main difference from a job queue, where a message is deleted once a worker has handled it.',
      'Because the log stays, any number of readers can go through it independently, each at its own speed, and a reader can go back and read it again. Appending to the end of a file is also about the cheapest thing a disk can do, which is where Kafka\'s throughput comes from.',
    ],
    pros: ['Many independent readers of the same data', 'History can be replayed after a bug or for a new consumer', 'Sequential disk writes: very high throughput'],
    cons: ['No "delete this message once done": retention is by time or size', 'No lookup by key and no per-message routing or priorities'],
    sim: 'Select the event stream and zoom in. Select the job queue and zoom in to compare: its messages leave once a worker acknowledges them.',
  },
  {
    id: 'partitions',
    title: 'Partitions',
    one: 'A topic is split into partitions. Each one is its own ordered log, and the unit of both scaling and ordering.',
    what: [
      'One log on one machine would limit a topic to that machine\'s disk and network. So a topic is divided into <b>partitions</b>, spread over the brokers. Producers write to many partitions at once and consumers read them in parallel.',
      'The cost is ordering. Records are ordered <b>within a partition</b> and not across partitions: there is no way to say which of two records in different partitions came first. Everything about choosing a partition key follows from this one fact.',
      'The number of partitions also caps how many consumers of one group can work in parallel. It can be raised later but never lowered, and raising it has a side effect covered under partition keys.',
    ],
    pros: ['Throughput beyond one machine', 'Parallel consumers', 'Strict order where it matters: inside a partition'],
    cons: ['No order across partitions', 'Uneven keys make uneven partitions', 'The count is awkward to change once data is flowing'],
    sim: 'The event stream here has three partitions. Zoomed in, each is drawn as its own bar, and the bright part is backlog not yet read.',
  },
  {
    id: 'offsets',
    title: 'Offsets',
    one: 'Every record in a partition has a number, its offset. A consumer\'s place in the log is just an offset.',
    what: [
      'Offsets count up from 0 within each partition: 0, 1, 2 and so on. An offset means nothing without its partition, so a position in a topic is one offset per partition.',
      'A consumer reads from an offset onwards and periodically <b>commits</b> the offset it has reached. Kafka stores committed offsets in an internal topic. After a crash or a restart, the consumer resumes from the last committed offset.',
      'Because the position belongs to the consumer and not to the broker, a consumer can also move it: back to the start to reprocess everything, or to a timestamp to redo the last hour.',
      '<b>Lag</b> is the distance between the newest offset in a partition and the consumer\'s committed offset. It is the first number to watch on any consumer: steady lag is fine, growing lag means records arrive faster than they are processed.',
    ],
    pros: ['Restart and resume exactly where you were', 'Replay by moving the offset back', 'Lag is a direct measure of whether consumers keep up'],
    cons: ['Commit too early and a crash skips records; too late and it repeats them'],
    sim: 'Select the event stream: its metrics show lag separately for each consumer group. Raise traffic past what the lake writer can read and its lag climbs.',
  },
  {
    id: 'producers',
    title: 'Producers and keys',
    one: 'The producer decides which partition a record goes to. With a key, the same key always goes to the same partition.',
    what: [
      'If a record has a <b>key</b>, the producer hashes it and takes the result modulo the number of partitions. So every record with key <code>driver-42</code> lands in the same partition, in the order it was sent.',
      'If a record has <b>no key</b>, the producer spreads records over all partitions (it fills a batch for one partition, then moves to the next). The load is as even as it can be, and there is no ordering between related records.',
      'Producers also choose how safe a write is with <code>acks</code>. With <code>acks=all</code>, the default, a write is acknowledged only after the in-sync replicas have it. The default producer is also <b>idempotent</b>: if it retries after a lost acknowledgement, the broker drops the duplicate.',
    ],
    pros: ['Per-key ordering with no coordination between producers', 'No key: perfectly even load'],
    cons: ['A popular key makes a hot partition', 'The mapping from key to partition depends on the partition count'],
    sim: null,
  },
  {
    id: 'brokers',
    title: 'Brokers and replication',
    one: 'Each partition is copied to several brokers. One copy leads; the others follow and can take over.',
    what: [
      'A Kafka cluster is a set of servers called <b>brokers</b>. Each partition has a <b>replication factor</b>, usually 3: one broker holds the <b>leader</b> copy, which takes all writes, and two hold <b>followers</b> that copy from it.',
      'Followers that are caught up form the <b>in-sync replicas</b>. If the leader\'s broker dies, one of them is elected leader and clients reconnect to it. With <code>acks=all</code> and a minimum of two in-sync replicas, an acknowledged record survives the loss of any one broker.',
    ],
    pros: ['A broker can die without losing acknowledged data', 'Failover is automatic'],
    cons: ['Three times the disk', 'Waiting for replicas adds a little latency to each write', 'If too few replicas are in sync, writes are refused rather than risked'],
    sim: 'Not modelled: the event stream here is a single broker, so stopping it stops the stream.',
    partial: true,
  },
  {
    id: 'groups',
    title: 'Consumer groups',
    one: 'Consumers that share a group ID split a topic\'s partitions between them. Different groups each get everything.',
    what: [
      'Within a <b>consumer group</b>, each partition is assigned to exactly one consumer. Three partitions and three consumers: one each. Three partitions and two consumers: one of them reads two. Three partitions and five consumers: two sit idle. So the partition count is the ceiling on a group\'s parallelism.',
      'Each group has its own committed offsets, so <b>different groups are independent</b>. A fraud detector and an analytics loader can both read every record of the same topic, at their own pace, without knowing about each other.',
      'When a consumer joins, leaves or crashes, the group <b>rebalances</b>: partitions are reassigned among the consumers that remain. Processing of the affected partitions pauses briefly while this happens.',
    ],
    pros: ['Add consumers to a group to go faster, up to the partition count', 'Add a group to build a new feature on the same data', 'A crashed consumer\'s partitions are taken over automatically'],
    cons: ['Consumers beyond the partition count do nothing', 'Rebalances pause processing', 'One slow record holds up everything behind it in its partition'],
    sim: 'The event stream here has two consumer groups: the lake writer and the OLAP database\'s loader. Stop the lake writer: its lag grows while the other group carries on unaffected.',
  },
  {
    id: 'retention',
    title: 'Retention and compaction',
    one: 'Kafka keeps records for a set time or size, whether or not anyone has read them.',
    what: [
      'By default a topic keeps records for <b>seven days</b>, then deletes the oldest. A size limit can be set as well or instead. Retention is what makes replay possible, and it is also a deadline: a consumer that is down or lagging for longer than the retention period loses what it had not read.',
      'A topic can instead be <b>compacted</b>: Kafka keeps at least the latest record for each key and discards older ones with the same key. That turns a topic into a table of current values ("the latest profile for each user") that a new consumer can load from the start.',
    ],
    pros: ['Consumers can be offline for hours and catch up', 'Compacted topics hold current state per key, indefinitely'],
    cons: ['Disk use is retention × throughput × replication factor', 'Fall behind by more than the retention and data is gone for that consumer'],
    sim: 'Stop the lake writer and keep traffic high. Once the unread backlog exceeds what the stream retains, the event stream\'s status reports events expiring before they were read.',
  },
  {
    id: 'delivery',
    title: 'Delivery guarantees',
    one: 'In practice: at least once. Design consumers so that seeing a record twice is harmless.',
    what: [
      'The guarantee comes from when the consumer commits its offset. Commit <b>after</b> processing, and a crash in between means the record is processed again on restart: <b>at least once</b>. Commit <b>before</b> processing, and the same crash means the record is skipped: <b>at most once</b>.',
      'Almost everyone chooses at least once and makes processing <b>idempotent</b>: upsert by an ID instead of inserting, or remember which record IDs have been handled.',
      'Kafka\'s <b>transactions</b> give exactly-once for one specific pattern: read from Kafka, process, write back to Kafka, with the output and the offset commit made atomic. They do not cover side effects outside Kafka, such as sending an email or charging a card.',
    ],
    pros: ['At least once never loses a record', 'Idempotent consumers make duplicates harmless'],
    cons: ['Duplicates are normal, not exceptional', 'Exactly-once stops at Kafka\'s edge'],
    sim: null,
  },
  {
    id: 'endtoend',
    title: 'Exactly-once across systems',
    one: 'Exactly-once processing is not exactly-once side effects. When exactly-once delivery is hard, aim for at-least-once delivery plus idempotent writes.',
    what: [
      'Take a common pipeline: <b>Kafka → Flink → ClickHouse</b>. Flink periodically takes a <b>checkpoint</b>: a consistent snapshot of its state together with the Kafka offsets it had read. After a crash it restores the last checkpoint and re-reads Kafka from those offsets. Inside Flink, every record then affects the state exactly once.',
      'The sink is outside that guarantee. Rows Flink wrote to ClickHouse after the last checkpoint and before the crash are <b>already there</b>, and the replay writes them again. Flink did nothing wrong: its internal result is correct, and the outside world has been told twice.',
      'There are two ways to close the gap. If the sink supports transactions that Flink can tie to its checkpoints, use <b>two-phase commit</b>: output is prepared as the job runs and committed only when the checkpoint completes, so a replay never commits the same output twice. Kafka as a sink works this way.',
      'Otherwise, assume the physical writes are at least once and make them <b>idempotent</b>. Give each output batch or each aggregate a <b>deterministic ID</b>, one that comes out the same when the same input is replayed (for example the window\'s key and start time, never a random ID or the wall clock). Then let the store collapse repeats: ClickHouse can drop a re-sent insert that carries a deduplication token it has already seen, and a ReplacingMergeTree table keeps one row per key, though only once its background merges have run, so a query that needs the exact answer in the meantime must ask for it with <code>FINAL</code>.',
      'In an interview, say it in that order: checkpoints give exactly-once inside Flink; the sink must also tolerate retries; use two-phase commit if the sink supports it, and otherwise at-least-once writes designed so that a retry produces the same logical result.',
    ],
    pros: ['Correct results without needing a transactional sink', 'Works across any boundary: databases, HTTP APIs, payment providers', 'Retries become safe, so failure handling gets simpler everywhere'],
    cons: ['Every output needs an ID that is the same on replay', 'Deduplication costs the sink storage or query time', 'Two-phase commit delays output until the next checkpoint'],
    sim: null,
  },
];

// ---------------------------------------------------------------- partition keys
export const KEY_RULES = [
  ['Start from ordering', 'Ask: which records must be read in the order they were written, relative to each other? The key is the ID of that thing. Events of one order: the order ID. Messages in one conversation: the conversation ID.'],
  ['Many more keys than partitions', 'A hash only spreads load evenly when there are far more distinct keys than partitions. A key with five possible values can fill at most five partitions, however many the topic has.'],
  ['No single key that dominates', 'All records for one key go to one partition, so the busiest key sets the size of the busiest partition. If one customer is 40% of your traffic, a key of customer ID puts 40% of the topic on one partition.'],
  ['Stable for the life of the entity', 'If the key of an entity changes (a ride that is re-keyed when it changes driver, say), its later records go to a different partition and are no longer ordered with its earlier ones.'],
  ['No ordering needed? No key', 'For records that are independent, such as log lines or page views that are only ever counted, leave the key empty. The producer spreads them evenly and nothing can become hot.'],
  ['Settle the partition count early', 'The partition is hash(key) modulo the partition count. Add partitions later and existing keys start going to different partitions, so a key\'s new records are no longer in order with its old ones. Start with more partitions than you need today.'],
];

// [system, what must stay in order, a good key, why, a tempting key and what goes wrong with it]
export const KEY_EXAMPLES = [
  ['Order events in a shop (created, paid, shipped, refunded)', 'The events of one order', '<code>order_id</code>', 'Millions of orders, none much busier than another. A consumer never sees "shipped" before "paid".', '<code>event_type</code>', 'Four values, so at most four partitions do all the work, and an order\'s events are split across them: their order is lost.'],
  ['Account ledger in a bank', 'The transactions on one account', '<code>account_id</code>', 'A balance is only right if debits and credits are applied in order.', '<code>transaction_id</code>', 'Unique per record, so the spread is perfect, and two transactions on one account land in different partitions with no order between them.'],
  ['Driver location pings in ride-hailing', 'The pings of one driver', '<code>driver_id</code>', 'The newest position must not be overwritten by an older one. Many drivers, each sending at about the same rate.', '<code>city_id</code>', 'A handful of large cities carry most of the traffic, so their partitions run hot while others idle.'],
  ['Chat messages', 'The messages in one conversation', '<code>conversation_id</code>', 'Everyone in the conversation sees the same order.', '<code>sender_id</code>', 'Two people in one conversation write to two partitions, so a reply can be delivered before the message it answers.'],
  ['Events from a multi-tenant product', 'Usually the events of one user or document', '<code>tenant_id:user_id</code>', 'Keeps a user\'s events in order while spreading a large tenant over many partitions.', '<code>tenant_id</code>', 'Right only if order across the whole tenant is truly required. Otherwise the largest customer becomes a hot partition, and their backlog delays everyone who shares it.'],
  ['Sensor readings', 'The readings of one device', '<code>device_id</code>', 'Many devices, similar rates.', 'The hour or the date', 'Every record being written now has the same key, so the whole topic\'s load lands on one partition at a time.'],
  ['Page views, used only for counts', 'Nothing', 'No key', 'Counting does not depend on order. Even load, nothing to become hot.', '<code>country</code>', 'A few countries dominate, and nothing was gained: no consumer needed the order.'],
];

export const HOT_KEYS = [
  ['Check that the ordering is really needed', 'Often only a narrower order matters. A tenant\'s events rarely need a total order; each of its users\' events do. Use the narrower ID as the key.'],
  ['Make a composite key', 'Add a second field: <code>tenant_id:user_id</code>. The big key\'s records now spread over many partitions, and you keep order within each sub-key.'],
  ['Salt the key', 'Append a small number: <code>celebrity-7:0</code> to <code>celebrity-7:9</code>. This spreads one key over up to ten partitions and gives up its ordering entirely, so it suits only work that does not need it, such as counting.'],
  ['Give the outlier its own topic', 'Route the one enormous key to a separate topic with its own partitions and consumers, so it cannot delay everyone else.'],
];

export const OTHER_SYSTEMS =
  'The same idea appears elsewhere under other names. Amazon Kinesis calls partitions <b>shards</b> and requires a partition key on every record. Google Pub/Sub has no partitions to manage; an optional <b>ordering key</b> plays the same role, and messages that share one are delivered in order.';

// ---------------------------------------------------------------- key playground
// A made-up ride-hailing stream: each trip produces four events in sequence, belongs to one driver,
// and each driver works in one city. Trips are spread over drivers unevenly and drivers over cities
// very unevenly (Zipf), which is what makes some keys balance and others not.
const EVENTS = ['requested', 'accepted', 'started', 'completed'];
export const KEY_CHOICES = [
  { id: 'none', label: 'No key', key: null },
  { id: 'trip', label: 'trip_id', key: (e) => 't' + e.trip },
  { id: 'driver', label: 'driver_id', key: (e) => 'd' + e.driver },
  { id: 'city', label: 'city_id', key: (e) => 'c' + e.city },
  { id: 'type', label: 'event_type', key: (e) => e.type },
];
export const PARTITION_CHOICES = [3, 6, 12];

// deterministic, so the picture is the same every time it is drawn
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// pick index 0..n-1 with probability proportional to 1 / (i + 1)^s
function zipf(n, s, rand) {
  const w = Array.from({ length: n }, (_, i) => 1 / (i + 1) ** s);
  const total = w.reduce((a, b) => a + b, 0);
  return () => {
    let r = rand() * total;
    for (let i = 0; i < n; i++) if ((r -= w[i]) <= 0) return i;
    return n - 1;
  };
}
// FNV-1a. Kafka's own producer uses murmur2; any good hash shows the same behaviour.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const TRIPS = 6000;
const DRIVERS = 900;
const CITIES = 12;
let stream = null;
function events() {
  if (stream) return stream;
  const rand = rng(7);
  const cityOf = Array.from({ length: DRIVERS }, zipf(CITIES, 1.1, rand));
  const pickDriver = zipf(DRIVERS, 0.4, rand);
  stream = [];
  for (let trip = 0; trip < TRIPS; trip++) {
    const driver = pickDriver();
    for (const type of EVENTS) stream.push({ trip, driver, city: cityOf[driver], type });
  }
  return stream;
}

// Send every event through a key choice and count what happened.
// → { share: fraction of records per partition, hottest: busiest partition ÷ an even share,
//     tripOrder / driverOrder: fraction of trips / drivers whose records all landed in one partition,
//     keys: distinct key values }
export function keyModel(choiceId, partitions) {
  const choice = KEY_CHOICES.find((c) => c.id === choiceId);
  const evs = events();
  const count = new Array(partitions).fill(0);
  const tripPart = new Map();
  const driverPart = new Map();
  const keys = new Set();
  const note = (map, id, part) => map.set(id, map.has(id) && map.get(id) !== part ? -1 : part);
  evs.forEach((e, i) => {
    const k = choice.key ? choice.key(e) : null;
    if (k !== null) keys.add(k);
    const part = k === null ? i % partitions : hash(k) % partitions; // no key: spread evenly in turn
    count[part]++;
    note(tripPart, e.trip, part);
    note(driverPart, e.driver, part);
  });
  const kept = (map) => [...map.values()].filter((p) => p !== -1).length / map.size;
  return { share: count.map((c) => c / evs.length), hottest: Math.max(...count) / (evs.length / partitions), tripOrder: kept(tripPart), driverOrder: kept(driverPart), keys: keys.size, records: evs.length };
}

// ---------------------------------------------------------------- check yourself
// [question, right answer, wrong answers, why]. All are documented Kafka behaviour.
export const QUIZ = [
  ['Two records are sent with the same key to a topic with 12 partitions. Where do they go?', 'Both to the same partition', ['To two partitions chosen at random', 'To the partition with the least data', 'To all 12, one copy each'], 'The producer hashes the key and takes it modulo the partition count, so one key always maps to one partition. That is what keeps a key\'s records in order.'],
  ['Record A is in partition 0 and record B is in partition 3 of the same topic. Which was written first?', 'Kafka cannot tell you: order exists only within a partition', ['A, because its partition number is lower', 'Whichever has the lower offset', 'B, because higher partitions are filled first'], 'Offsets are counted separately in each partition, so offset 5 in one partition and offset 9 in another say nothing about each other. If two records must be ordered, they need the same key.'],
  ['A topic has 4 partitions. A consumer group reading it has 6 consumers. How many are doing work?', '4', ['6', '2', '1'], 'Within a group, a partition is read by exactly one consumer. Four partitions can keep four consumers busy; the other two wait as spares. To use six, the topic needs at least six partitions.'],
  ['Two different consumer groups subscribe to the same topic. How are the records shared between them?', 'Each group receives every record', ['Each record goes to one group or the other', 'The first group to commit an offset gets the record', 'They alternate partition by partition'], 'Each group keeps its own offsets, so groups do not affect each other. Records are divided between the consumers <i>inside</i> a group, never between groups.'],
  ['A consumer processes a record, then crashes before committing its offset. What happens when it restarts?', 'It processes that record again', ['The record is skipped', 'Kafka deletes the record', 'The whole partition is replayed from offset 0'], 'It resumes from the last committed offset, which is before that record. This is at-least-once delivery, and why consumers should be idempotent.'],
  ['A topic keyed by user_id grows from 6 to 12 partitions. What happens to one user\'s records?', 'New ones may go to a different partition than the old ones', ['All existing records are moved to their new partitions', 'Nothing: a key\'s partition is fixed for ever', 'The topic rejects that user until it is rebuilt'], 'The partition is hash(key) modulo the count, so changing the count changes the answer for most keys. Existing records stay where they are; new ones go to the new partition, and order across the change is not guaranteed.'],
  ['A Flink job reads Kafka and writes to an external database. It crashes and restores its last checkpoint. What happens to rows it wrote after that checkpoint?', 'They are written again, unless the sink is transactional or idempotent', ['Flink deletes them from the database first', 'They are skipped: Flink remembers having written them', 'Kafka refuses to serve those records twice'], 'A checkpoint restores Flink\'s own state and its Kafka offsets, and nothing outside. The replayed records produce the same writes again. Exactly-once processing is not exactly-once side effects: the sink needs two-phase commit or idempotent writes.'],
  ['You key a topic by country, and 60% of your users are in one country. What is the result?', 'One partition takes about 60% of the load', ['Kafka splits that country over several partitions automatically', 'The producer falls back to spreading records evenly', 'Nothing: the hash evens it out'], 'Hashing spreads <i>keys</i> evenly, not records. All of one key\'s records go to one partition, so a dominant key means a hot partition and a consumer that falls behind.'],
];
