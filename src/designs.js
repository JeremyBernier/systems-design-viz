// Content for "System designs" (designsui.js): worked answers to design problems, starting where an
// interview or a real project starts — with scoping — and ending in this simulator.
//
// A design is a list of sections (tabs); a section is a list of blocks. Block kinds:
//   { h, p: [..] }                     a heading and paragraphs
//   { table: { head: [..], rows } }    a table
//   { steps: [..] }                    a numbered sequence
//   { list: [..] }                     bullets
//   { note }                           a highlighted remark
// General knowledge and one reasonable set of assumptions, not the only right answer. The numbers
// are stated assumptions; the arithmetic on them is done in the text so it can be checked.

export const DESIGNS = [
  {
    id: 'adclicks',
    title: 'Ad click aggregator',
    preset: 'adclicks',
    problem:
      'Design a stream-processing system that counts ad clicks in real-time windows (the last 5 minutes, 1 hour and 24 hours) with exactly-once semantics.',
    sections: [
      {
        id: 'scope',
        name: '1 · Scoping',
        intro: 'The prompt fits in one sentence and hides most of the design. Before drawing anything, find out what the counts are for, what "exactly once" has to mean, and how big it is. Those three answers decide the architecture.',
        blocks: [
          {
            h: 'Start with the three questions that move the design',
            p: [
              '<b>What are the counts used for?</b> A dashboard an advertiser glances at can be a few seconds stale and briefly wrong. An invoice cannot be wrong at all, but can arrive tomorrow. If the answer is "both", that is two outputs with two correctness bars, and it is the single most useful thing to learn: it lets the real-time path be fast and nearly right while a slower path makes the money exact.',
              '<b>What does "exactly once" cover?</b> Nobody can deliver a message exactly once over a network. What can be promised is that each real click changes the stored count once, however many times it is retried, replayed or redelivered on the way. So ask where duplicates come from (a double click, a client retry, our own recovery after a crash) and whether a click carries anything that identifies it. Without an ID per click, exactly-once is not achievable and that must be said out loud.',
              '<b>How big, and how uneven?</b> Clicks per second at peak, the number of ads, and how skewed they are. The average decides almost nothing; the peak and the one ad that goes viral decide the hard parts.',
            ],
          },
          {
            h: 'Clarifying questions, why each matters, and what to assume',
            p: ['Ask these, and when the interviewer says "you decide", state the assumption and move on. An assumption said aloud is a requirement; one kept to yourself is a bug.'],
            table: {
              head: ['Question', 'Why it changes the design', 'Assume here'],
              rows: [
                ['Who sends us a click?', 'If the browser hits our endpoint we control the timestamp and can attach an ID. If partners send batches we inherit their duplicates and delays.', 'The user\'s browser hits our click endpoint, which records the click and redirects to the advertiser.'],
                ['What are the counts for?', 'Dashboards need speed; billing needs exactness. Different bars, possibly different paths.', 'Both: live dashboards for advertisers, and billing from the same data once it is final.'],
                ['What must "exactly once" mean?', 'Sets where deduplication happens and what every stage must tolerate.', 'Each real click counts once in the stored aggregates, whatever is retried or replayed.'],
                ['Does a click have a unique ID?', 'Deduplication needs one. A click on the same ad by the same user twice is otherwise indistinguishable from a retry.', 'Every ad impression carries a signed impression ID; at most one click per impression counts.'],
                ['Counted by what?', 'Every extra dimension multiplies the rows stored and the state held.', 'Per ad, rolled up to campaign and advertiser. No arbitrary slicing by user.'],
                ['Are the windows sliding?', '"The last 5 minutes" as of now is a sliding window. Computing three of them directly is expensive.', 'Sliding, to one-minute precision.'],
                ['How fresh must a count be?', 'Seconds rules out batch. Sub-second would rule out most of this design.', 'A click appears in the dashboard within about 10 to 30 seconds.'],
                ['Whose clock?', 'A timestamp from the device can be hours late or simply wrong. Ours is always close to now.', 'The time our server received the click. Lateness is then only our own pipeline delay.'],
                ['How much traffic?', 'Peak rate sizes the log and the processors; skew decides whether partitioning by ad works.', '10 million ads. 5,000 clicks a second on average, 10,000 at peak, and one ad can take over 10% of it.'],
                ['How long is data kept?', 'Minute-level rows for ever are large; raw clicks larger still.', 'Per-minute counts for 30 days, hourly and daily for years, raw clicks for 90 days.'],
                ['Is fraud filtering in scope?', 'It is a large problem of its own, and it means counts can change after the fact.', 'Out of scope, but raw clicks are kept so that counts can be corrected later.'],
                ['What may fail first?', 'A lost click is lost revenue; a stale dashboard is an annoyance.', 'Never lose a click once accepted. The aggregates may lag before the ingest path is allowed to fail.'],
              ],
            },
          },
          {
            h: 'The requirements that come out of it',
            list: [
              '<b>Functional:</b> record a click and redirect the user; return the click count for an ad, campaign or advertiser over the last 5 minutes, 1 hour and 24 hours; provide final per-ad counts for billing.',
              '<b>Correctness:</b> each click counted exactly once in the stored aggregates; billing figures exact; dashboard figures within seconds of exact, and corrected if they were not.',
              '<b>Freshness:</b> about 10 to 30 seconds from click to dashboard.',
              '<b>Durability and availability:</b> a click acknowledged to the browser is never lost; the click endpoint stays up when everything behind it is down.',
              '<b>Scale:</b> 10,000 clicks a second at peak with heavy skew toward a few ads; hundreds of dashboard queries a second.',
              '<b>Out of scope:</b> serving the ads, fraud detection, attribution of purchases to clicks, slicing by arbitrary user attributes.',
            ],
          },
          {
            h: 'Back-of-envelope',
            p: ['Do the arithmetic before designing: it shows which parts are easy.'],
            table: {
              head: ['Quantity', 'Working', 'Result'],
              rows: [
                ['Clicks per day', '5,000 a second × 86,400 seconds', 'About 430 million'],
                ['Bytes into the log at peak', '10,000 a second × about 0.5 kB per click', '5 MB a second: small for any log'],
                ['Raw clicks stored', '430 million × 0.5 kB, kept for 90 days', 'About 215 GB a day, 19 TB in all'],
                ['Per-minute rows per day', 'At most one per click; far fewer, since a busy ad shares a row per minute', 'Under 430 million'],
                ['Deduplication memory', '10,000 a second × a 10-minute horizon', '6 million click IDs held at once'],
                ['Rows read for a 24-hour count', '24 hourly rows, plus up to 60 minute rows at each end', 'About 150 rows per ad'],
              ],
            },
          },
          {
            note: 'What scoping bought. Throughput is not the problem: 5 MB a second is modest. The problems are (1) counting each click once across five hand-offs, (2) answering three overlapping windows cheaply, (3) one ad carrying a tenth of the traffic, and (4) being fast for dashboards and exact for billing at the same time. The design is organised around those four, and you can now say so before drawing a box.',
          },
        ],
      },
      {
        id: 'design',
        name: '2 · Design',
        intro: 'Accept the click durably and fast, then do everything else asynchronously from a log. One stream of small non-overlapping buckets serves all three windows.',
        blocks: [
          {
            h: 'Data',
            table: {
              head: ['Record', 'Fields', 'Notes'],
              rows: [
                ['Click event', 'impression_id, ad_id, campaign_id, advertiser_id, received_at', 'Immutable. impression_id is the deduplication key; received_at is our server\'s clock.'],
                ['Minute count', 'ad_id, minute_start → clicks', 'One row per ad per minute. Rewritten in full, never incremented.'],
                ['Rollups', 'ad_id, hour_start → clicks; ad_id, day → clicks', 'Sums of the minute rows, maintained by the store.'],
              ],
            },
          },
          {
            h: 'The path of a click',
            steps: [
              'The browser requests our click URL, which carries the ad and the signed impression ID. A load balancer passes it to a stateless <b>click service</b>.',
              'The service checks the signature, so that IDs cannot be invented, and finds the advertiser\'s URL in a <b>cache</b> in front of the ads database.',
              'It appends the click event to a <b>log</b> (Kafka), waiting for the write to be replicated, and only then answers with a redirect. From this moment the click cannot be lost, and the user is on their way in a few milliseconds.',
              'A <b>stream processor</b> reads the log. It drops any click whose impression ID it has already seen, then counts the rest per ad in one-minute tumbling windows on the received_at time.',
              'For each ad and minute it writes the window\'s <b>total</b> to an analytics database, as an upsert on (ad_id, minute_start). It also writes the running total for the current minute every few seconds, under the same key.',
              'A <b>query service</b> answers "last 5 minutes" by summing the 5 newest minute rows, and the longer windows from hourly rollups plus the minute rows at each edge.',
              'Separately, every raw click is archived to cheap storage. A <b>batch job</b> recounts each finished day from the archive and overwrites any minute that differs. Billing reads only reconciled days.',
            ],
          },
          {
            h: 'Why not just increment a counter?',
            p: ['The obvious first design is one row per ad in a database and an UPDATE … SET clicks = clicks + 1 on every click. It is worth saying why it fails, because each failure maps to a part of the real design.'],
            table: {
              head: ['', 'Counter in a database', 'Log, then aggregate'],
              rows: [
                ['A retried request', 'Increments twice', 'Same impression ID: dropped'],
                ['A popular ad', 'Every click fights for one row lock', 'Appends never contend'],
                ['"The last 5 minutes"', 'A single total cannot answer it', 'Minute buckets can'],
                ['The database is slow', 'The user\'s redirect is slow too', 'The redirect only waits for the log'],
                ['A bug in the counting', 'The original clicks are gone', 'Replay the log, or recount from the archive'],
              ],
            },
          },
          {
            h: 'Where to aggregate: in the stream, or in the database',
            p: [
              'There are two sound ways to turn clicks into minute counts. A stream processor such as Flink can aggregate and write only the totals, which keeps the database small and puts deduplication and windowing in one place. Or the analytics database can ingest every click itself and maintain the minute counts with a materialized view, which removes a moving part at the price of storing and scanning much more.',
            ],
            table: {
              head: ['', 'Aggregate in the stream processor', 'Aggregate in the analytics database'],
              rows: [
                ['The database stores', 'Minute totals only', 'Every click, plus the totals'],
                ['Deduplication happens', 'In the processor\'s state', 'In the table engine, by key'],
                ['Moving parts', 'Processor and database', 'Database only'],
                ['A change to the counting logic', 'Redeploy the job and replay', 'Rebuild the view over stored clicks'],
                ['Cost at this scale', 'Lower storage, more to operate', 'More storage and CPU, less to operate'],
              ],
            },
          },
          {
            note: 'This simulator models the second form: its analytics database reads the event stream directly, and its stream processor is the one that archives raw events to the lake. The reasoning in the deep dives applies to both.',
          },
        ],
      },
      {
        id: 'deep',
        name: '3 · Deep dives',
        intro: 'The four problems scoping exposed, then reconciliation and failure. Each links to a concept explained at more length in Core concepts or the Flink deep dive.',
        blocks: [
          {
            h: 'Three windows from one stream',
            p: [
              'The tempting design is three sliding windows in the stream processor: 5 minutes, 1 hour and 24 hours, each sliding by a minute. A click would then belong to 5 + 60 + 1,440 windows. State and output are multiplied by about 1,500, and the results cannot be combined or reused.',
              'Instead compute one thing: a <b>one-minute tumbling</b> count per ad. Tumbling windows do not overlap, so each click is counted once and the results add up. Every requested window is then a sum at query time: 5 rows, 60 rows, or 24 hourly rollup rows plus the minute rows at the two ragged ends. The sliding happens in the query, where it is free. If a 6-hour window is asked for next quarter, nothing upstream changes.',
              'The cost is precision: "the last 5 minutes" is accurate to the minute, not the second. Say so, and offer 10-second buckets if it matters; that is a constant, not a redesign.',
              'The current minute is not finished, so a window that fires only when it closes would make the dashboard up to a minute stale. Have the window also emit its running total every few seconds. Because every write for a given ad and minute uses the same key and carries the total so far, each one simply replaces the last.',
            ],
          },
          {
            h: 'Exactly once, hand-off by hand-off',
            p: ['"Exactly once" is not a switch. It is a chain, and the count is only as good as its weakest link. Go through it in order and name the defence at each step.'],
            table: {
              head: ['Hand-off', 'How a click is duplicated or lost', 'Defence'],
              rows: [
                ['Browser → click service', 'Double click; the browser or a proxy retries', 'One signed impression ID per ad shown; later copies are dropped downstream'],
                ['Click service → log', 'The write times out and is retried; a broker dies after accepting', 'Idempotent producer, and wait for all in-sync replicas before redirecting'],
                ['Log → stream processor', 'The processor crashes and re-reads from its last checkpoint', 'Checkpoints store the log offsets with the state, so state is rewound to match'],
                ['Inside the processor', 'The same impression ID arrives twice', 'Keyed "seen" state per ID, kept for a horizon longer than any retry'],
                ['Stream processor → database', 'Output written before the crash is written again after it', 'Upsert the window\'s total under (ad_id, minute_start): the repeat overwrites itself'],
                ['Database ingest', 'A batch insert is retried', 'The store collapses rows with the same key'],
                ['All of the above, plus bugs', 'Something nobody anticipated', 'Recount from the raw archive and overwrite'],
              ],
            },
          },
          {
            p: [
              'Two details carry most of the weight. First, write <b>totals, not increments</b>. "Add 37 to ad 9 for 12:04" applied twice is wrong; "ad 9 had 37 clicks in 12:04" applied twice is harmless. That one choice is what makes the sink idempotent, and it only works because the key is deterministic: the same clicks always land in the same minute, since the minute comes from the stored received_at and never from the processor\'s own clock.',
              'Second, the deduplication horizon is not the lateness bound. The horizon must cover how long after the first copy a second can appear, which is set by retries and replays and may be many minutes. It is usually held as state with a time-to-live that runs on the wall clock, so a long outage can expire it just before the replay that needs it. Past the horizon, the last two rows of the table are the safety net. The alternative to an idempotent sink is a transactional one committed with each checkpoint; it gives the same guarantee but delays every count to the checkpoint interval, which the freshness requirement does not allow.',
            ],
          },
          {
            h: 'Late and out-of-order clicks',
            p: [
              'Because the timestamp is our own server\'s, a click can be late only by the delay inside our pipeline: normally well under a second, a few seconds when a partition lags. A watermark that trails the newest timestamp by 5 to 10 seconds therefore closes each minute promptly and loses almost nothing.',
              'For the rare click later than that, give the window some allowed lateness, a few minutes, during which it re-emits a corrected total under the same key. A click later still, after a long partition outage for instance, misses the real-time count and is picked up by reconciliation. Had we used the device\'s clock, this section would be the hardest in the design; choosing the server\'s clock during scoping removed it.',
            ],
          },
          {
            h: 'The viral ad',
            p: [
              'Partitioning the log by ad_id keeps each ad\'s clicks together and in order, which is convenient and, for a skewed workload, a trap: the ad taking 10% of traffic puts 1,000 clicks a second on one partition and one processor subtask while the others idle. Adding machines does not help a single hot key.',
              'Partition the log by impression ID instead. Load is then even, and deduplication, which is per impression, is naturally local. Aggregate in two stages: each subtask first counts its own share per ad and minute, then those partial counts are regrouped by ad and added up. The first stage absorbs the volume; the second handles one small record per ad per subtask per emission, however hot the ad. A Count-Min Sketch over the stream is a cheap way to see which ads are hot.',
            ],
          },
          {
            h: 'Reconciliation: why exactly-once is not enough',
            p: [
              'Even a correct exactly-once pipeline produces counts that later turn out wrong: a deployment had a bug for an hour, clicks arrived after their window had closed, a batch of clicks is ruled fraudulent a day later. Money needs a path that does not depend on the streaming job having been right at the time.',
              'So keep every raw click, and once a day recount from the archive with a simple batch query: group by ad and minute, count distinct impression IDs. Compare with the stored minute rows, overwrite the differences, and alert if the difference is more than a hair. Billing reads only days that have been reconciled. The stream gives speed, the batch gives certainty, and the size of the gap between them is the best health metric the system has.',
            ],
          },
          {
            h: 'Serving the queries',
            p: [
              'A columnar analytics database sorted by (ad_id, minute_start) answers a 5-minute or 1-hour query by reading a handful of adjacent rows. Hourly and daily rollups are maintained by the store itself, so a 24-hour or 30-day query stays small. Campaign and advertiser totals are sums over a few ads and can be precomputed the same way if they are slow.',
              'Dashboards refresh often and tolerate a few seconds of staleness, so cache each answer briefly. If "unique users who clicked" is added later, it cannot be summed from minute rows, since the same user appears in many; store a HyperLogLog sketch per ad per minute instead, and merge sketches at query time.',
            ],
          },
          {
            h: 'What happens when each part fails',
            table: {
              head: ['Failure', 'What the user sees', 'Recovery'],
              rows: [
                ['A click service instance dies', 'Nothing: the load balancer stops routing to it', 'Stateless, so it is simply replaced'],
                ['A log broker dies', 'Nothing: replicas hold every acknowledged click', 'A replica takes over the partitions it led'],
                ['The stream processor crashes', 'Counts stop updating, then catch up', 'Restore the last checkpoint and replay; upserts overwrite the repeats'],
                ['The analytics database is down', 'Dashboards are stale or unavailable; clicks still succeed', 'The processor backs off; the backlog waits in the log'],
                ['The log itself is unavailable', 'Clicks cannot be recorded', 'The one failure that costs money: spread brokers across zones, and buffer briefly in the service'],
                ['An outage longer than the dedup horizon', 'Some duplicates counted in real time', 'Reconciliation removes them before billing'],
                ['An outage longer than log retention', 'Unprocessed clicks expire from the log', 'They are still in the raw archive: recount from it'],
              ],
            },
          },
        ],
      },
      {
        id: 'sim',
        name: '4 · In the simulator',
        intro: 'Load the design and break it. The preset is a 1:2 scale model: 5,000 clicks a second where the design allows for 10,000.',
        blocks: [
          { load: true },
          {
            h: 'Which box is which',
            table: {
              head: ['In the design', 'In the simulator', 'Technology'],
              rows: [
                ['Click service', 'Click Service (application servers)', 'EC2'],
                ['Ad URL cache', 'Ad Lookup Cache', 'Redis'],
                ['Ads database', 'Ads DB', 'PostgreSQL'],
                ['The log', 'Click Stream', 'Apache Kafka'],
                ['Aggregation and serving', 'Click Aggregates', 'ClickHouse, reading the stream itself'],
                ['Raw click archive', 'Raw Click Archiver → Raw Click Lake', 'Data Firehose → S3 + Iceberg'],
                ['Reconciliation', 'Reconciliation Queries', 'Trino over the lake'],
                ['Dashboards', 'Advertiser Dashboards', 'Superset'],
              ],
            },
          },
          {
            h: 'Things to try',
            list: [
              '<b>Freshness.</b> Select the dashboards and read "Click Aggregates data is behind by". That is the requirement of 10 to 30 seconds. Now switch the aggregates database to Snowflake: a connector appears, the data falls about 45 seconds behind, and the requirement is missed without anything being broken.',
              '<b>Ingest outlives everything behind it.</b> Turn off auto-restart and kill the aggregates database. Clicks keep succeeding at 0% errors, the stream\'s lag grows, and the dashboards go stale. Restart it and watch it catch up from the log.',
              '<b>Queries against ingestion.</b> Push "Dashboard queries per second" past about 100. Queries and inserts compete for the same CPUs, inserts fall behind and the counts age. This is the case for rollups and a short cache in front of the dashboards.',
              '<b>The archive is the last resort.</b> Kill the raw click archiver and leave it down. Lag climbs toward the stream\'s retention, then "Expired unread" starts counting: clicks that reconciliation will never see.',
              '<b>A viral ad.</b> Press the traffic spike. The click service absorbs it or sheds it; the stream simply holds the burst and the aggregates catch up afterwards.',
            ],
          },
          {
            h: 'What the simulator does not model',
            p: [
              'Deduplication by impression ID, windows and watermarks, the two-stage aggregation for hot ads, and the reconciliation job overwriting counts are not modelled: every event here is unique, on time and evenly spread. The simulator shows the shape of the system and how load and failure move through it; the correctness arguments are in the deep dives.',
            ],
          },
        ],
      },
    ],
  },
];
