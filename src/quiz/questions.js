// Questions for the estimation quiz (quiz.html). No DOM here, so they can be checked from Node.
//
// Every question is generated: it draws its inputs from a short list of round numbers, states each
// assumption it needs in the question itself, and computes its answer and its worked steps from
// those inputs. No answer is typed in. Where a question uses a price or a hardware speed, the
// figure is given in the question as an assumption, so the arithmetic is what is being tested.
//
// The questions are the conversions a system design interview actually calls for: events × size to
// throughput, bytes to bits, count × size to storage, a day's data to a year's, load to servers. Rates
// are given per second, as an interviewer would give them; only one question starts from daily users.
// Nothing asks for a per-month figure or a cloud bill.
//
// A generator returns:
//   cat      – category shown on the card and used by the filter
//   level    – 1: a single conversion · 2: a short scenario · 3: several steps. The quiz starts at 1 and works up.
//   q        – the question (HTML)
//   answer   – the exact result, in the base unit of `units`
//   units    – [[label, size in base units], …] offered for the answer; one entry means a fixed unit
//   hint     – the shortcut that makes it easy
//   steps    – the working, one line each
//   takeaway – what the size of the answer means for a design
//   tol      – a guess within this factor of the answer counts as on target (default 2)
//   show     – optional formatter for the answer, where a plain "number unit" reads badly (money)

export const DAY = 86400;
const YEAR = 365 * DAY;

const BW = [['Mbps', 1e6], ['Gbps', 1e9], ['Tbps', 1e12]];
const SIZE = [['GB', 1e9], ['TB', 1e12], ['PB', 1e15], ['EB', 1e18]];
const TIME = [['seconds', 1], ['minutes', 60], ['hours', 3600], ['days', DAY], ['years', YEAR]];
const BIG = [['million', 1e6], ['billion', 1e9], ['trillion', 1e12]];

const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const sig = (v, n = 2) => Number(v.toPrecision(n)).toLocaleString('en-US', { maximumFractionDigits: 6 });
// 5000000 → "5 million"
export const words = (v) => (v >= 1e12 ? sig(v / 1e12, 3) + ' trillion' : v >= 1e9 ? sig(v / 1e9, 3) + ' billion' : v >= 1e6 ? sig(v / 1e6, 3) + ' million' : sig(v, 3));
// a value in the largest unit of `units` that keeps it at 1 or more
export function inUnits(v, units, n = 2) {
  let u = units[0];
  for (const x of units) if (v >= x[1]) u = x;
  return `${sig(v / u[1], n)} ${u[0]}`;
}
const bytes = (v, n = 2) => inUnits(v, [['B', 1], ['kB', 1e3], ['MB', 1e6], ['GB', 1e9], ['TB', 1e12], ['PB', 1e15], ['EB', 1e18]], n);
const bits = (v, n = 2) => inUnits(v, [['bps', 1], ['kbps', 1e3], ['Mbps', 1e6], ['Gbps', 1e9], ['Tbps', 1e12]], n);
const time = (s, n = 2) => inUnits(s, TIME, n);

const DAY_HINT = 'A day has 86,400 seconds. Round it to 100,000 (10⁵) and "per day" becomes "per second" by dropping five zeros.';

export const GENERATORS = [
  // ------------------------------------------------------------ traffic
  // ------------------------------------------------------------ conversions: one step each
  () => {
    const rps = pick([1000, 10000, 50000, 200000]);
    const ratio = pick([10, 100]);
    const v = rps / (ratio + 1);
    return {
      cat: 'Conversions',
      level: 1,
      q: `A service handles <b>${sig(rps)}</b> requests per second, with about <b>${ratio} reads for every write</b>. Roughly how many writes per second is that?`,
      answer: v,
      units: [['writes per second', 1]],
      hint: `${ratio} reads to 1 write means about one request in ${ratio} is a write.`,
      steps: [`One request in ${ratio + 1} is a write: ${sig(rps)} ÷ ${ratio + 1} ≈ ${sig(v, 3)} writes per second`, `Close enough: ${sig(rps)} ÷ ${ratio} = ${sig(rps / ratio)}`],
      takeaway: 'Split the load before sizing anything. Reads can be spread over caches and replicas; writes all land on the primary, so the write rate is what decides whether one database is enough.',
    };
  },
  () => {
    const r = pick([100, 1000, 10000]);
    const v = r * DAY;
    return {
      cat: 'Conversions',
      level: 1,
      q: `A service receives <b>${sig(r)}</b> writes per second, around the clock. About how many is that per day?`,
      answer: v,
      units: BIG,
      hint: DAY_HINT,
      steps: [`${sig(r)} × 86,400 seconds (≈ 10⁵) ≈ ${words(r * 1e5)} a day`, `Exactly: ${words(v)} a day`],
      takeaway: 'The same shortcut in reverse: per second × 100,000 ≈ per day. It is the first step of most storage estimates.',
    };
  },
  () => {
    const n = pick([1e6, 1e7, 1e8, 1e9]);
    const size = pick([100, 1000, 10000]);
    const v = n * size;
    return {
      cat: 'Conversions',
      level: 1,
      q: `You store <b>${words(n)}</b> records of about <b>${bytes(size)}</b> each. How much data is that?`,
      answer: v,
      units: SIZE,
      hint: 'A million × 1 kB = 1 GB. A billion × 1 kB = 1 TB.',
      steps: [`${words(n)} × ${bytes(size)} = ${bytes(v)}`],
      takeaway: 'Two anchors cover most cases: a million 1 kB records is a gigabyte, and a billion is a terabyte. A terabyte fits comfortably on one machine.',
    };
  },
  () => {
    const mb = pick([10, 50, 125, 500]);
    const v = mb * 1e6 * 8;
    return {
      cat: 'Conversions',
      level: 1,
      q: `A service sends <b>${mb} MB</b> of data every second. How much bandwidth is that?`,
      answer: v,
      units: BW,
      hint: 'Data sizes are in bytes, bandwidth is in bits: multiply by 8.',
      steps: [`${mb} MB × 8 bits per byte = ${sig(mb * 8)} Mbps`, v >= 1e9 ? `= ${bits(v)}` : null].filter(Boolean),
      takeaway: 'Worth remembering in the other direction too: a 1 Gbps link carries 125 MB a second.',
    };
  },
  () => {
    const [day, label] = pick([[1e10, '10 GB'], [1e11, '100 GB'], [1e12, '1 TB'], [1e13, '10 TB']]);
    const v = day * 365;
    return {
      cat: 'Conversions',
      level: 1,
      q: `A service writes <b>${label}</b> of new data every day. How much is that per year?`,
      answer: v,
      units: SIZE,
      hint: 'A year is 365 days. Rounding it to 400 is close enough.',
      steps: [`${label} × 365 = ${bytes(v, 3)} a year`, `Roughly: ${label} × 400 = ${bytes(day * 400)}`],
      takeaway: 'Interviewers usually ask for one year or five years of data. Multiply the daily figure by about 400, or by about 2,000.',
    };
  },
  () => {
    const [who, what, per] = pick([
      ['A social app', 'feed requests', [20, 50]],
      ['A messaging app', 'messages sent', [20, 40]],
      ['A search engine', 'searches', [5, 10]],
      ['A ride-hailing app', 'API requests', [30, 100]],
    ]);
    const dau = pick([1e6, 1e7, 1e8, 5e8, 1e9]);
    const n = pick(per);
    const v = (dau * n) / DAY;
    return {
      cat: 'Traffic',
      level: 2,
      q: `${who} has <b>${words(dau)}</b> daily active users, and each one generates about <b>${n}</b> ${what} a day. What is the average rate per second?`,
      answer: v,
      units: [['per second', 1]],
      hint: DAY_HINT,
      steps: [`${words(dau)} × ${n} = ${words(dau * n)} a day`, `÷ 86,400 seconds (≈ 10⁵) ≈ ${sig((dau * n) / 1e5)} per second`, `Exactly: ${sig(v, 3)} per second`],
      takeaway: 'This is the average. Traffic follows the day, so the peak is commonly two to five times higher, and the peak is what you size for.',
    };
  },
  () => {
    const avg = pick([2000, 10000, 50000]);
    const mult = pick([3, 5]);
    const per = pick([500, 1000, 2000]);
    const v = Math.ceil((avg * mult) / (per * 0.6));
    return {
      cat: 'Capacity',
      level: 3,
      q: `A service averages <b>${sig(avg)}</b> requests per second, and its daily peak is <b>${mult}×</b> the average. Load tests show one server handles <b>${sig(per)}</b> requests per second flat out. How many servers keep each one at or below 60% busy at peak?`,
      answer: v,
      units: [['servers', 1]],
      tol: 1.2,
      hint: 'Work out the peak first, then divide by what a server takes at 60%, not at 100%.',
      steps: [`Peak: ${sig(avg)} × ${mult} = ${sig(avg * mult)} requests/s`, `One server at 60%: ${sig(per)} × 0.6 = ${sig(per * 0.6)} requests/s`, `${sig(avg * mult)} ÷ ${sig(per * 0.6)} = ${sig((avg * mult) / (per * 0.6), 3)}${Number.isInteger((avg * mult) / (per * 0.6)) ? '' : `, rounded up to ${v}`}`],
      takeaway: `Sizing for the average at 100% would give ${Math.ceil(avg / per)} servers: ${sig(v / Math.ceil(avg / per), 2)}× too few. Add one more so that losing a server is harmless.`,
    };
  },
  () => {
    const rate = pick([20000, 100000, 500000]);
    const per = pick([2000, 5000, 10000]);
    const v = Math.ceil(rate / per);
    return {
      cat: 'Capacity',
      level: 2,
      q: `A stream receives <b>${sig(rate)}</b> events per second. One consumer can process <b>${sig(per)}</b> events per second. In a consumer group, each partition is read by one consumer. At least how many partitions does the topic need for consumers to keep up?`,
      answer: v,
      units: [['partitions', 1]],
      tol: 1.2,
      hint: 'A group cannot have more working consumers than the topic has partitions.',
      steps: [`Consumers needed: ${sig(rate)} ÷ ${sig(per)} = ${sig(rate / per, 3)}${Number.isInteger(rate / per) ? '' : `, rounded up to ${v}`}`, `One partition per consumer at least: ${v} partitions`],
      takeaway: 'That is the floor, with no headroom. Partitions are awkward to add later, so real topics are created with a few times this.',
    };
  },
  // ------------------------------------------------------------ throughput
  () => {
    const rate = pick([1e5, 1e6, 5e6]);
    const size = pick([200, 500, 1000]);
    const v = rate * size;
    return {
      cat: 'Throughput',
      level: 2,
      q: `Your ingest pipeline takes in roughly <b>${words(rate)}</b> click events per second. Assume about <b>${bytes(size)}</b> per event. What is the raw write throughput?`,
      answer: v,
      units: [['MB/s', 1e6], ['GB/s', 1e9]],
      hint: 'Events per second × bytes per event. A million × 1 kB = 1 GB.',
      steps: [`${words(rate)} × ${bytes(size)} = ${bytes(v)} per second`],
      takeaway: `Say it this way in an interview: "about ${words(rate)} events a second at ~${bytes(size)} each, so roughly ${bytes(v)}/s of raw incoming data." From there, × 8 gives ${bits(v * 8)} of network, and × 86,400 gives about ${bytes(v * DAY)} a day to store.`,
    };
  },
  // ------------------------------------------------------------ bandwidth
  () => {
    const rate = pick([1e5, 1e6, 5e6]);
    const size = pick([200, 500, 1000]);
    const v = rate * size * 8;
    return {
      cat: 'Bandwidth',
      level: 2,
      q: `An ad platform records <b>${words(rate)}</b> clicks per second. Each click is sent as an event of about <b>${bytes(size)}</b>. How much network bandwidth does ingesting them take?`,
      answer: v,
      units: BW,
      hint: 'Bytes per second first, then multiply by 8: bandwidth is quoted in bits.',
      steps: [`${words(rate)} × ${bytes(size)} = ${bytes(rate * size)} per second`, `× 8 bits per byte = ${bits(v)}`],
      takeaway: `A mid-sized cloud server sustains roughly 1 to 5 Gbps, so this is ${v < 1e9 ? 'within one machine\'s network, though not something to put on one machine' : `more than one machine can take: at least ${Math.ceil(v / 5e9) + 1} ingest servers or brokers for the network alone`}.`,
    };
  },
  () => {
    const viewers = pick([1e4, 1e5, 1e6, 1e7]);
    const mbps = pick([3, 5, 8]);
    const v = viewers * mbps * 1e6;
    return {
      cat: 'Bandwidth',
      level: 2,
      q: `A live stream has <b>${words(viewers)}</b> concurrent viewers, each receiving video at <b>${mbps} Mbps</b>. How much bandwidth is being delivered in total?`,
      answer: v,
      units: BW,
      hint: 'A thousand Mbps is a Gbps; a thousand Gbps is a Tbps.',
      steps: [`${words(viewers)} × ${mbps} Mbps = ${words(viewers * mbps)} Mbps`, `= ${bits(v)}`],
      takeaway: 'No origin serves this itself. It is what a CDN is for: the bytes leave from thousands of edge locations close to the viewers.',
    };
  },
  () => {
    const rate = pick([1e5, 1e6, 5e6]);
    const size = pick([200, 500, 1000]);
    const v = rate * size * DAY;
    return {
      cat: 'Storage',
      level: 2,
      q: `An ad platform records <b>${words(rate)}</b> clicks per second, at about <b>${bytes(size)}</b> per event. How much raw data is that per day?`,
      answer: v,
      units: SIZE,
      hint: DAY_HINT,
      steps: [`${words(rate)} × ${bytes(size)} = ${bytes(rate * size)} per second`, `× 86,400 seconds (≈ 10⁵) ≈ ${bytes(rate * size * 1e5)} a day`, `Exactly: ${bytes(v, 3)} a day`],
      takeaway: 'Before replication, which usually triples it, and before compression, which shrinks repetitive event data several times over.',
    };
  },
  () => {
    const ups = pick([1e6, 5e7, 1e8]);
    const [size, what] = pick([[2e5, 'a 200 kB photo'], [2e6, 'a 2 MB photo kept in several sizes'], [5e7, 'a 50 MB video']]);
    const v = ups * size * 365;
    return {
      cat: 'Storage',
      level: 3,
      q: `Users upload <b>${words(ups)}</b> items a day, each about ${what.replace(/^a ([\d.]+ \w+)/, 'a <b>$1</b>')}. How much new storage is needed per year?`,
      answer: v,
      units: SIZE,
      hint: 'Per day first, then × 365. A thousand GB is a TB; a thousand TB is a PB.',
      steps: [`${words(ups)} × ${bytes(size)} = ${bytes(ups * size)} a day`, `× 365 = ${bytes(v, 3)} a year`],
      takeaway: 'At this scale the data goes in object storage, not a database, and the database keeps only a pointer to each object.',
    };
  },
  () => {
    const rate = pick([1e4, 1e5, 1e6]);
    const size = pick([500, 1000, 2000]);
    const days = pick([3, 7]);
    const v = rate * size * days * DAY * 3;
    return {
      cat: 'Storage',
      level: 3,
      q: `A Kafka topic receives <b>${words(rate)}</b> events per second of about <b>${bytes(size)}</b> each. It keeps them for <b>${days} days</b> with a replication factor of <b>3</b>. How much disk does the cluster need for this topic?`,
      answer: v,
      units: SIZE,
      hint: 'Bytes per second × seconds retained × number of copies.',
      steps: [`${words(rate)} × ${bytes(size)} = ${bytes(rate * size)} per second`, `× 86,400 = ${bytes(rate * size * DAY, 3)} a day`, `× ${days} days = ${bytes(rate * size * DAY * days, 3)}`, `× 3 copies = ${bytes(v, 3)}`],
      takeaway: 'Retention is a disk bill: doubling how long you keep events doubles it, and so does every extra replica.',
    };
  },
  // ------------------------------------------------------------ memory
  () => {
    const users = pick([1e7, 1e8, 5e8]);
    const frac = pick([10, 20]);
    const size = pick([1000, 2000, 10000]);
    const v = users * (frac / 100) * size;
    return {
      cat: 'Memory',
      level: 2,
      q: `A service has <b>${words(users)}</b> user profiles of about <b>${bytes(size)}</b> each. You want to cache the most active <b>${frac}%</b> of them. How much memory does the cache need?`,
      answer: v,
      units: SIZE,
      hint: 'Number of items × size of each. A million kilobytes is a gigabyte.',
      steps: [`${frac}% of ${words(users)} = ${words(users * (frac / 100))} profiles`, `× ${bytes(size)} = ${bytes(v)}`],
      takeaway: v <= 5e11 ? 'That fits in the memory of one large machine (512 GiB is an ordinary instance size). You would still run several nodes, for availability rather than capacity.' : 'More than one ordinary machine holds, so this is a cache cluster with the keys spread across nodes.',
    };
  },
  // ------------------------------------------------------------ limits and time
  () => {
    const rate = pick([100, 1000, 10000]);
    const v = 2 ** 31 / rate;
    return {
      cat: 'Time',
      level: 3,
      q: `A table uses a signed 32-bit integer as its ID, which tops out at about <b>2.1 billion</b>. Rows are inserted at <b>${sig(rate)}</b> per second. How long until the IDs run out?`,
      answer: v,
      units: TIME,
      hint: DAY_HINT,
      steps: [`2.1 billion ÷ ${sig(rate)} per second = ${sig(2 ** 31 / rate)} seconds`, `÷ 86,400 = ${sig(v / DAY, 3)} days`, v > YEAR ? `= ${sig(v / YEAR, 2)} years` : `= ${time(v)}`],
      takeaway: 'Short enough to matter within the life of a product. A 64-bit ID at the same rate lasts for longer than anyone needs to plan for.',
    };
  },
  () => {
    const n = pick([6, 7, 8]);
    const v = 62 ** n;
    return {
      cat: 'Capacity',
      level: 3,
      q: `A URL shortener makes codes of <b>${n}</b> characters, each one of 62 symbols (a–z, A–Z, 0–9). How many distinct codes are there?`,
      answer: v,
      units: BIG,
      tol: 2.5,
      hint: '62² is about 3,800 and 62³ about 240,000. Build up from there.',
      steps: [`62³ ≈ 238,000`, `62⁶ = (62³)² ≈ ${words(62 ** 6)}`, n === 6 ? `So 6 characters give about ${words(v)} codes` : `62^${n} = 62⁶ × 62${n === 8 ? '²' : ''} ≈ ${words(v)}`],
      takeaway: `At 1,000 new links per second that is ${time(v / 1000)} of codes.`,
    };
  },
  () => {
    const slo = pick([99, 99.9, 99.95, 99.99]);
    const v = (1 - slo / 100) * YEAR;
    return {
      cat: 'Time',
      level: 2,
      q: `A service promises <b>${slo}%</b> availability. How much downtime does that allow in a year?`,
      answer: v,
      units: TIME,
      hint: 'A year is 8,760 hours, or about 525,600 minutes.',
      steps: [`${slo}% up leaves ${parseFloat((100 - slo).toFixed(3))}% down`, `${parseFloat((100 - slo).toFixed(3))}% of 8,760 hours = ${sig(v / 3600, 3)} hours`, `= ${time(v)}`],
      takeaway: 'Each extra nine cuts the allowance by ten. At 99.99% the whole year allows under an hour, less than one slow incident, so recovery has to be automatic.',
    };
  },

];

export const CATEGORIES = [...new Set(GENERATORS.map((g) => g().cat))];

// How a guess compares: 'hit' within the question's tolerance, 'near' within a factor of ten, else 'miss'.
// → { grade, factor (always ≥ 1), high (guess above the answer) }
export function grade(guess, answer, tol = 2) {
  if (!(guess > 0)) return { grade: 'miss', factor: Infinity, high: false };
  const r = guess / answer;
  const factor = Math.max(r, 1 / r);
  return { grade: factor <= tol * 1.0001 ? 'hit' : factor <= 10 ? 'near' : 'miss', factor, high: r > 1 };
}

// "4,000", "4k", "1.5e6", "2 million" → a number, or NaN
export function parse(text) {
  const t = String(text).trim().toLowerCase().replace(/[,\s$]/g, '');
  const m = /^(\d*\.?\d+(?:e[+-]?\d+)?)(k|m|b|t|thousand|million|billion|trillion)?$/.exec(t);
  if (!m) return NaN;
  const mult = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 }[m[2]] || 1;
  return parseFloat(m[1]) * mult;
}
