// Content for the "Core concepts" guide (conceptsui.js): the ideas that come up in every system
// design whatever the technology. Four themes, each a handful of topics. A topic says what the idea
// is, what it gets you and costs you, and where this simulator shows it, if it does.
//
// General knowledge, written to be read next to the simulator. `sim` is null where the idea is
// not modelled here, and the guide says so.

export const THEMES = [
  {
    id: 'concurrency',
    name: 'Doing many things at once',
    intro: 'A server handles thousands of requests that overlap in time. Most hard bugs in a system come from two of them touching the same thing at the same moment.',
    topics: [
      {
        id: 'parallelism',
        title: 'Concurrency and parallelism',
        one: 'Concurrency is juggling many tasks; parallelism is doing several at the same instant.',
        what: [
          'A web request spends most of its life waiting: for the database, for another service, for the network. <b>Concurrency</b> means a server makes progress on many requests by switching between them while they wait, even on a single core. <b>Parallelism</b> means work really runs at the same moment on several cores. Serving requests is mostly a concurrency problem; resizing images is a parallelism one.',
          'How a server gets concurrency sets its limits. One <b>thread per request</b> is simple, but every waiting request holds a thread and its memory, so a slow dependency can pin all of them. An <b>event loop</b> handles thousands of waiting requests on one thread, as long as nothing blocks it.',
        ],
        pros: ['One machine serves far more requests than it has cores', 'Waiting time is not wasted time'],
        cons: ['Waiting requests still hold threads, memory and connections', 'Shared state now needs protecting from simultaneous use'],
        sim: 'Overload the OLTP database, then select an application server. Its status reads "Thread pool exhausted": all 256 threads are stuck waiting on the database while the CPU sits idle.',
      },
      {
        id: 'races',
        title: 'Race conditions',
        one: 'Two operations interleave, and the result depends on who got there first.',
        what: [
          'The classic case is <b>read, modify, write</b>. Two requests each read a stock count of 1, each decide the item is available, and each write back 0: two customers have bought the last one. Each request was correct on its own; the bug exists only in the overlap.',
          'Races are rare under light load and common under heavy load, which is why they survive testing and appear in production. The fixes all make the check and the change a single step: do it inside the database (<code>UPDATE … SET stock = stock - 1 WHERE stock > 0</code>), take a lock, or detect the conflict and retry.',
        ],
        pros: [],
        cons: ['Invisible in tests and in code review', 'Gets more frequent exactly as traffic grows', 'Corrupts data silently instead of failing loudly'],
        sim: null,
      },
      {
        id: 'locks',
        title: 'Locks and deadlock',
        one: 'Make others wait while you work. Simple, until two holders wait for each other.',
        what: [
          'A <b>lock</b> lets one request at a time into a critical section; everyone else queues. This is <b>pessimistic</b> concurrency control: it assumes a conflict will happen and pays the waiting cost every time. Inside one process it is a mutex; inside a database it is a row lock; across machines it is a <b>distributed lock</b> held in something like Redis or ZooKeeper, with a time limit so a crashed holder does not hold it for ever.',
          '<b>Deadlock</b> is two requests each holding a lock the other needs. Databases detect it and abort one. The usual prevention is to always take locks in the same order. Distributed locks have a subtler failure: a holder that pauses past its time limit still believes it holds the lock, so anything it guards must also reject stale holders.',
        ],
        pros: ['Easy to reason about: one at a time', 'The right tool when conflicts are frequent'],
        cons: ['Everyone else waits, so throughput drops', 'Deadlocks when locks are taken in different orders', 'A distributed lock can be held by two parties at once after a pause or a network split'],
        sim: null,
      },
      {
        id: 'optimistic',
        title: 'Optimistic concurrency',
        one: 'Do not lock; check at the end that nobody else changed it, and retry if they did.',
        what: [
          'Each record carries a <b>version</b>. You read the record and its version, do your work, and write back only if the version is still the one you read ("compare and swap"). If someone else got in first, your write is rejected and you start again from the new value.',
          'Nobody waits, so this is fast when conflicts are rare, which is the normal case for something like a user editing their own profile. When many writers fight over one hot record, most attempts fail and retry, and a lock would have been cheaper.',
        ],
        pros: ['No waiting and no deadlocks', 'Works across services and over HTTP, where a lock cannot be held'],
        cons: ['Wasted work and retries when conflicts are common', 'The caller must be written to retry'],
        sim: null,
      },
    ],
  },
  {
    id: 'failure',
    name: 'When things fail',
    intro: 'In a system of many machines something is always broken or slow. The design question is not how to prevent failure but what each part does when the part next to it fails.',
    topics: [
      {
        id: 'timeouts',
        title: 'Timeouts',
        one: 'Decide how long you will wait, because a slow dependency is worse than a dead one.',
        what: [
          'A dead server refuses connections at once and the caller moves on. A slow one accepts the request and then holds the caller\'s thread, memory and connection for as long as it likes. Without a <b>timeout</b>, one slow dependency spreads: its callers fill up with waiting requests, then their callers do.',
          'Choosing the value is a trade. Too long and the timeout protects nothing; too short and you abandon work the server was about to finish, which it then finishes anyway for nobody. A good timeout sits just above the slowest response you consider normal, and every hop\'s timeout is shorter than its caller\'s.',
        ],
        pros: ['Stops one slow component from stalling everything upstream', 'Turns an open-ended hang into a failure you can handle'],
        cons: ['A timed-out request may still have succeeded: you do not know', 'The abandoned work still loads the server'],
        sim: 'Under Reliability, lower the client timeout to 0.5 s while the application servers are near their limit. Requests that would have succeeded slowly now count as errors, and the "timed out (work wasted)" figure shows the server still doing them.',
      },
      {
        id: 'retries',
        title: 'Retries, backoff and jitter',
        one: 'Trying again fixes a blip and worsens an overload.',
        what: [
          'Many failures are momentary, so retrying is the cheapest reliability there is. The danger is that a struggling server now receives its normal load <i>plus</i> the retries of everything it just failed. That extra load causes more failures, which cause more retries: a <b>retry storm</b>. The system can stay down long after the original cause has gone.',
          'Three habits make retries safe. <b>Exponential backoff</b>: wait longer after each failure. <b>Jitter</b>: randomise the wait, so a thousand clients do not all return in the same instant. A <b>retry budget</b>: allow retries only up to a small fraction of normal traffic, so the amplification is bounded whatever happens.',
        ],
        pros: ['Hides brief failures from the user completely', 'Cheap to add'],
        cons: ['Multiplies load on a server that is already failing', 'Only safe if the operation can be repeated: see idempotency', 'Retries at every layer multiply each other'],
        sim: 'Under Reliability, set retries to Naive and press Traffic spike. Offered load jumps to about 4 times the real traffic and stays there after the spike has passed. Repeat with "Backoff + budget": the same spike is over in seconds.',
      },
      {
        id: 'idempotency',
        title: 'Idempotency',
        one: 'Doing it twice has the same effect as doing it once.',
        what: [
          'A request times out. Did the payment go through? The client cannot know, and the only way to make progress is to send it again. If the operation is <b>idempotent</b> that is safe; if it is not, the customer is charged twice. Since timeouts, retries and at-least-once queues all cause repeats, every operation that changes something needs an answer to "what if this arrives twice?".',
          'Some operations are idempotent by nature: "set the status to shipped" can be applied any number of times, where "add 1 to the count" cannot. The general technique is an <b>idempotency key</b>: the client generates a unique id for the operation and sends it with every attempt; the server records the id with the result, and on seeing it again returns the stored result instead of acting.',
        ],
        pros: ['Retries, redelivered messages and double-clicks all become harmless', 'The client can retry without knowing what happened'],
        cons: ['The server must store keys and results, and decide how long to keep them', 'The check and the action must happen together, or two copies arriving at once both pass'],
        sim: 'Not modelled directly, but it is the reason the queue cards say "handlers must tolerate duplicates". SQS, Pub/Sub and a worker that crashes mid-job all deliver the same job a second time.',
      },
      {
        id: 'delivery',
        title: 'Delivery guarantees',
        one: 'At most once, at least once, or the expensive illusion of exactly once.',
        what: [
          'A consumer takes a message, processes it and acknowledges it. If it crashes between processing and acknowledging, the broker cannot tell whether the work was done. It has two choices. Never redeliver, and the message may be lost: <b>at most once</b>. Redeliver, and the work may be done twice: <b>at least once</b>.',
          '<b>Exactly once</b> delivery over a network is not possible. What systems offer under that name is at-least-once delivery combined with idempotent or transactional processing, so that the duplicate has no effect. In practice: choose at least once, and make the handler idempotent.',
        ],
        pros: ['At least once never loses work', 'At most once is the simplest and fastest'],
        cons: ['At least once produces duplicates the handler must absorb', 'At most once silently drops work when a consumer dies', 'Ordering is usually lost on redelivery'],
        sim: 'Zoom into the job queue and choose "Queue internals". Each consumer holds a job that is delivered but not yet acknowledged. Kill the workers: those are the jobs a real broker would hand out again when they return.',
      },
      {
        id: 'breakers',
        title: 'Circuit breakers',
        one: 'Stop calling something that is failing, to give it room to recover.',
        what: [
          'A <b>circuit breaker</b> watches the calls to one dependency. When too many fail it "opens": further calls fail immediately without being sent. After a pause it lets a few through as a test, and closes again if they succeed.',
          'This protects both sides. The caller stops tying up threads on calls that will time out, and the failing service stops receiving traffic it cannot handle. It is most useful with a <b>fallback</b>: serve a cached or default answer while the breaker is open, so the user sees a degraded page instead of an error.',
        ],
        pros: ['Failing fast frees the caller\'s threads at once', 'Takes load off a struggling dependency so it can recover'],
        cons: ['Thresholds need tuning: too sensitive and it trips on noise', 'Without a fallback it only changes a slow error into a fast one'],
        sim: 'Not modelled. The nearest thing here is the retry budget, which also limits how much extra load a failing system is sent.',
      },
    ],
  },
  {
    id: 'load',
    name: 'Handling load',
    intro: 'Every component has a rate at which it can work. These are the ways a system behaves when asked for more than that, and the ways to raise the limit.',
    topics: [
      {
        id: 'backpressure',
        title: 'Backpressure and load shedding',
        one: 'When you cannot keep up, say so early instead of queueing without limit.',
        what: [
          'A server that receives more than it can process has three options: queue the excess, slow the sender down, or refuse it. An unbounded queue is the default and the worst. Latency grows with the queue until every request has waited so long that its client has given up, and the server is busy working on requests nobody wants.',
          '<b>Backpressure</b> pushes the limit back to the source: a full queue blocks or rejects the producer, which must then slow down. <b>Load shedding</b> rejects the excess immediately (HTTP 429 or 503) so that the requests which are accepted stay fast. Serving 80% of users well beats serving 100% of them a timeout.',
        ],
        pros: ['Latency stays bounded for the work that is accepted', 'An overload stays an overload instead of becoming a crash'],
        cons: ['Some requests are refused on purpose', 'Callers must handle rejection sensibly, not retry at once'],
        sim: 'Push traffic past what the application servers can take. On EC2 the request queue fills, memory climbs and the process is killed. Switch the technology to AWS Lambda: it sheds the excess with 429s and never falls over.',
      },
      {
        id: 'ratelimit',
        title: 'Rate limiting',
        one: 'A cap on how much any one caller may ask for.',
        what: [
          'Load shedding protects a server from the total; a <b>rate limit</b> protects everyone from one caller: a buggy client in a loop, a scraper, a customer running a batch job. Each caller gets an allowance, commonly a <b>token bucket</b> that refills at a steady rate and allows short bursts, and requests beyond it are rejected.',
          'With many servers the counts have to live somewhere shared, usually an in-memory store, or be divided approximately between servers. The limit is also a product decision: it is how a shared service promises one tenant that another cannot starve it.',
        ],
        pros: ['One misbehaving client cannot take the service down', 'Makes capacity predictable and fair between tenants'],
        cons: ['Shared counters add a lookup to every request', 'Legitimate bursts are rejected too', 'Limits set too low are an outage you caused yourself'],
        sim: 'Switch the OLTP database to DynamoDB and overload it. Requests above its provisioned capacity are throttled at once instead of queueing, which is a rate limit enforced by the service.',
      },
      {
        id: 'stateless',
        title: 'Statelessness and scaling out',
        one: 'If any server can handle any request, you can add servers freely.',
        what: [
          'There are two ways to get more capacity. <b>Scaling up</b> buys a bigger machine: simple, but it has a ceiling and is still one machine to lose. <b>Scaling out</b> adds more machines behind a load balancer, which works only if the servers are interchangeable.',
          'That requires the servers to be <b>stateless</b>: nothing a later request needs is kept in one server\'s memory or on its disk. Sessions, uploads and caches move to shared stores. The application tier then scales with a slider, and the hard problem moves to the place the state went: the database.',
        ],
        pros: ['Add or remove servers at any time, including automatically', 'Losing a server loses no data and no sessions'],
        cons: ['Every request pays a trip to a shared store for its state', 'The database becomes the bottleneck and the single point that matters'],
        sim: 'Add application servers and the bottleneck moves to the database. Then turn on autoscaling with the daily traffic pattern and watch the fleet follow the load, which is only possible because the servers hold no state.',
      },
      {
        id: 'stampede',
        title: 'Caching and the stampede',
        one: 'A cache hides load from the database, until the moment it stops.',
        what: [
          'The usual pattern is <b>cache-aside</b>: look in the cache; on a miss, read the database and put the answer in the cache with an expiry time. Most reads never reach the database, so it can be sized for a fraction of the real traffic. That saving is also the risk.',
          'When the cache is empty, after a restart or when a popular entry expires, every request misses at once and all of them go to the database together: a <b>stampede</b>. A database sized for the misses cannot take the full read load. Defences are to let only one request rebuild each entry while the others wait, to spread expiry times so entries do not all lapse together, and to warm a cache before it takes traffic.',
        ],
        pros: ['Removes most read load and latency for data that is read often', 'Cheap compared with scaling the database'],
        cons: ['Data can be stale for up to the expiry time', 'An empty cache can take the database down with it', 'Invalidating the right entry when data changes is hard to get right'],
        sim: 'At about 4,000 requests a second with four or more application servers, kill the cache. Every read falls through to the database, which is overwhelmed before the cache has warmed up again.',
      },
    ],
  },
  {
    id: 'consistency',
    name: 'Agreeing on the truth',
    intro: 'Once data lives on more than one machine, the copies can disagree. These ideas describe what a reader is allowed to see, and what it costs to make the copies agree.',
    topics: [
      {
        id: 'models',
        title: 'Strong and eventual consistency',
        one: 'Does every reader see the latest write, or will they agree later?',
        what: [
          'With <b>strong consistency</b> the system behaves like a single copy: once a write is acknowledged, every later read returns it. With <b>eventual consistency</b> the copies converge if writes stop, but a read may return an older value in the meantime.',
          'Eventual is faster and stays available when machines cannot reach each other, and it is fine for a like count or a product description. It is wrong for a bank balance. In between sit useful guarantees such as <b>read your own writes</b>: other users may see your change late, but you never see your own edit vanish, which is usually what people actually notice.',
        ],
        pros: ['Strong: simple to reason about, safe for money and inventory', 'Eventual: lower latency, and it keeps working when the network splits'],
        cons: ['Strong: slower writes, and unavailable when a majority cannot be reached', 'Eventual: the application must cope with stale and conflicting data'],
        sim: 'Add read replicas to the OLTP database and raise the write percentage. "Replication lag" in its live metrics is how stale a read from a replica can be.',
      },
      {
        id: 'cap',
        title: 'The CAP theorem',
        one: 'When the network splits, you choose between answering and being right.',
        what: [
          'Suppose the link between two groups of machines breaks: a <b>partition</b>. A request arrives at one side. That side can answer from what it has, and risk disagreeing with the other side: it stays <b>available</b>. Or it can refuse until the link is back: it stays <b>consistent</b>. It cannot do both. Partitions are not optional in a real network, so the choice is really between consistency and availability <i>during</i> one.',
          'The other half of the trade applies all the time, partition or not: keeping copies in agreement means waiting for them, so stronger consistency costs latency on every request. Most design decisions are made on that everyday trade, not on the rare partition.',
        ],
        pros: [],
        cons: ['Choosing consistency: some requests are refused while the network is split', 'Choosing availability: both sides accept writes that must be reconciled afterwards'],
        sim: null,
      },
      {
        id: 'consensus',
        title: 'Consensus and leader election',
        one: 'Getting a group of machines to agree on one value, even when some fail.',
        what: [
          'Many problems reduce to agreement: which node is the primary, what the configuration is, whether a transaction committed. <b>Consensus</b> protocols such as Raft and Paxos solve this with a <b>majority</b>: a decision stands once more than half the nodes have accepted it. Any two majorities overlap, so two conflicting decisions can never both be made.',
          'This is why such clusters have 3 or 5 members: 3 survive losing one, 5 survive losing two. It also explains the cost. Every decision waits for a round trip to a majority, so consensus is used for the small, critical things, such as who the leader is, and not for every piece of data.',
        ],
        pros: ['Exactly one leader, even through crashes and network splits', 'Nothing acknowledged is ever lost'],
        cons: ['Every decision waits for a majority, which adds latency', 'With fewer than a majority reachable, the cluster stops accepting writes', 'Difficult to implement correctly: use an existing system'],
        sim: 'Give the OLTP database a read replica and kill it. For about 30 seconds writes fail while a replica is promoted: that pause is a leader election. Cloud Spanner runs consensus on every write, which is why its card lists slower commits.',
      },
      {
        id: 'sagas',
        title: 'Two-phase commit and sagas',
        one: 'Two ways to make one change across several databases or services.',
        what: [
          '<b>Two-phase commit</b> asks every participant to prepare and promise it can commit, then tells them all to do so. It gives a true all-or-nothing result, but every participant holds locks while waiting, and if the coordinator fails at the wrong moment they are stuck holding them.',
          'A <b>saga</b> gives up all-or-nothing. It is a sequence of local transactions, each with a <b>compensating action</b> that undoes it: reserve the seat, charge the card, issue the ticket; if the charge fails, release the seat. Nothing is locked across services, but for a while the world is in a half-finished state that other requests can see, and every step and every undo must be idempotent.',
        ],
        pros: ['Two-phase commit: real atomicity across systems', 'Sagas: no cross-service locks, and each service stays independent'],
        cons: ['Two-phase commit: slow, and blocks everyone if the coordinator fails', 'Sagas: intermediate states are visible, and some actions cannot truly be undone'],
        sim: 'Not modelled directly. Its cost shows in the sharding model, where 5% of writes are assumed to touch two shards and cost more.',
      },
      {
        id: 'clocks',
        title: 'Clocks and ordering',
        one: 'Two machines never agree on the time, so "which happened first?" is a hard question.',
        what: [
          'Clocks on different machines drift apart by milliseconds or more, and can jump backwards when they are corrected. Deciding the order of two events by comparing timestamps from different machines will sometimes get it wrong. "Last write wins" by wall-clock time therefore silently discards some updates.',
          'Systems avoid depending on time. A single log, such as a Kafka partition or a database\'s write-ahead log, gives every event a position, which is an order everyone agrees on. <b>Logical clocks</b> count events instead of seconds. Where real time cannot be avoided, the uncertainty is measured and waited out, as Spanner does.',
        ],
        pros: ['A log gives one order that every reader agrees on'],
        cons: ['A single ordered log is also a single place every write must pass through', 'Ordering across several logs or partitions is not defined'],
        sim: 'The event stream here keeps order only within one of its three partitions, which is why its panel reports lag per partition.',
      },
    ],
  },
];
