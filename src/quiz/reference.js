// Reference figures shown under the quiz (quiz.html): how long things take, and how big one machine can be.
//
// Where they come from:
//   LATENCY   – the widely circulated "latency numbers every programmer should know" (Jeff Dean, Peter
//               Norvig), rounded to a power of ten, plus the datacenter figures from the free section of
//               Hello Interview's "Numbers to Know" (same zone < 1 ms, across zones 1–2 ms, across regions 50–150 ms).
//   HARDWARE  – the same Hello Interview section; each matches AWS's published instance specification.
export const SOURCE = 'https://www.hellointerview.com/learn/system-design/core-concepts/numbers-to-know';

// [what, seconds, shown as, why it matters]
export const LATENCY = [
  ['Read from the CPU\'s own cache', 1e-9, '~1 ns', 'What the processor does a billion times a second.'],
  ['Read from main memory', 1e-7, '~100 ns', 'An in-memory cache lookup costs this, plus the network to reach it.'],
  ['Random read from an SSD', 1e-4, '~100 µs', 'About 1,000× slower than memory: the reason caches and buffer pools exist.'],
  ['Round trip inside one datacenter zone', 5e-4, '< 1 ms', 'Every call to a cache, database or other service pays at least this.'],
  ['Round trip between zones of one region', 1.5e-3, '1–2 ms', 'The price of surviving the loss of a zone.'],
  ['Seek on a spinning disk', 1e-2, '~10 ms', 'Why spinning disks are kept for sequential work: logs, backups, archives.'],
  ['Round trip between regions', 1e-1, '50–150 ms', 'Set by distance. No hardware removes it; only putting data near the user does (CDN, regional replicas).'],
];

// [instance, what it has, the lesson]
export const HARDWARE = [
  ['AWS m6i.32xlarge', '128 vCPUs · 512 GiB of memory', 'An ordinary general-purpose machine, not an exotic one.'],
  ['AWS x1e.32xlarge', '4 TB of memory', 'A dataset of a few terabytes can sit entirely in the memory of one machine.'],
  ['AWS u-24tb1.metal', '24 TB of memory', 'The top of the range.'],
  ['AWS i3en.24xlarge', '60 TB of local SSD', 'Tens of terabytes on fast local disk, in one machine.'],
  ['AWS d3en.12xlarge', '336 TB of spinning disk', 'Hundreds of terabytes, if sequential access is enough.'],
  ['Network between machines', '25 Gbps on large instances, 50–100 Gbps on the fastest', 'Smaller instances get far less: a mid-sized one sustains 1 to 5 Gbps.'],
];
