import { TECH } from './tech.js';
import { SPECS, NIC_BPS, WORKLOAD, fmtBits as simBits, fmtGB } from './sim.js';
import { CACHE_NODE_CAP } from './datatier.js';
import { DAY, fmtSize } from './planner.js';

// "Numbers to know": the handful of figures that back-of-envelope estimates are built from, and a
// quiz that drills them. Opened from the left panel.
//
// Where the figures come from (kept here so a reviewer can check each one):
//   LATENCY   – the widely circulated "latency numbers every programmer should know" (Jeff Dean, Peter
//               Norvig), rounded to a power of ten, plus the datacenter figures from the free section of
//               Hello Interview's "Numbers to Know" (same zone < 1 ms, across zones 1–2 ms, across regions 50–150 ms).
//   HARDWARE  – the same Hello Interview section; each matches AWS's published instance specification.
//   Everything under "In this simulator" is read from sim.js / tech.js / datatier.js at render time.
// Quiz answers are either one of those figures or arithmetic done in code, never a typed-in result.
// Questions of judgment are not asked here: the database guide handles those without grading them.

const $ = (id) => document.getElementById(id);
const SOURCE = 'https://www.hellointerview.com/learn/system-design/core-concepts/numbers-to-know';

// [what, seconds, shown as, why it matters]
const LATENCY = [
  ['Read from the CPU\'s own cache', 1e-9, '~1 ns', 'What the processor does a billion times a second.'],
  ['Read from main memory', 1e-7, '~100 ns', 'An in-memory cache lookup costs this, plus the network to reach it.'],
  ['Random read from an SSD', 1e-4, '~100 µs', 'About 1,000× slower than memory: the reason caches and buffer pools exist.'],
  ['Round trip inside one datacenter zone', 5e-4, '< 1 ms', 'Every call to a cache, database or other service pays at least this.'],
  ['Round trip between zones of one region', 1.5e-3, '1–2 ms', 'The price of surviving the loss of a zone.'],
  ['Seek on a spinning disk', 1e-2, '~10 ms', 'Why spinning disks are kept for sequential work: logs, backups, archives.'],
  ['Round trip between regions', 1e-1, '50–150 ms', 'Set by distance. No hardware removes it; only putting data near the user does (CDN, regional replicas).'],
];

// [instance, what it has, the lesson]
const HARDWARE = [
  ['AWS m6i.32xlarge', '128 vCPUs · 512 GiB of memory', 'An ordinary general-purpose machine, not an exotic one.'],
  ['AWS x1e.32xlarge', '4 TB of memory', 'A dataset of a few terabytes can sit entirely in the memory of one machine.'],
  ['AWS u-24tb1.metal', '24 TB of memory', 'The top of the range.'],
  ['AWS i3en.24xlarge', '60 TB of local SSD', 'Tens of terabytes on fast local disk, in one machine.'],
  ['AWS d3en.12xlarge', '336 TB of spinning disk', 'Hundreds of terabytes, if sequential access is enough.'],
  ['Network between machines', '25 Gbps on large instances, 50–100 Gbps on the fastest', 'Smaller instances get far less: see the simulator\'s own machines below.'],
];

const fmtBits = (bps) => (bps >= 1e12 ? parseFloat((bps / 1e12).toFixed(2)) + ' Tbps' : simBits(bps));
const sig = (v, n = 2) => Number(v.toPrecision(n)).toLocaleString('en-US');
const rate = (v) => sig(v) + '/s';
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const shuffle = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const big = (v) => (v >= 1e9 ? v / 1e9 + ' billion' : v >= 1e6 ? v / 1e6 + ' million' : v.toLocaleString('en-US'));
const span = (s) => (s >= 3600 ? sig(s / 3600) + ' hours' : s >= 60 ? sig(s / 60) + ' minutes' : sig(s) + ' seconds');

// Four options a factor of ten apart, the right one at a random position, so the only way to choose is to do the sum.
function tens(value, fmt) {
  const k = Math.floor(Math.random() * 4);
  return { choices: [0, 1, 2, 3].map((i) => fmt(value * 10 ** (i - k))), answer: k };
}
// Fixed options: the first one given is the right answer; they are shuffled for display.
function among(right, wrong) {
  const choices = shuffle([right, ...wrong]);
  return { choices, answer: choices.indexOf(right) };
}

// Each entry returns { q, choices, answer, why }. Generated ones draw fresh numbers every round.
const QUESTIONS = [
  // ---- estimation: the answer is computed
  () => {
    const dau = pick([1e6, 1e7, 5e7, 1e8, 5e8]);
    const per = pick([10, 20, 50, 100]);
    const v = (dau * per) / DAY;
    return {
      q: `A product has ${big(dau)} daily active users, each making ${per} requests a day. What is the average request rate?`,
      ...tens(v, (x) => `≈ ${sig(x)} requests/s`),
      why: `${big(dau)} × ${per} = ${big(dau * per)} requests a day. A day has 86,400 seconds, which rounds to 10⁵, so divide by 100,000: about ${sig((dau * per) / 1e5)}/s. Exactly: ${sig(v, 3)}/s. The peak is usually a few times the average.`,
    };
  },
  () => {
    const writes = pick([1e6, 1e7, 1e8]);
    const [bytes, what] = pick([[1e3, 'a 1 kB row'], [1e4, '10 kB of JSON'], [2e5, 'a 200 kB photo'], [2e6, 'a 2 MB upload']]);
    const v = writes * bytes * 365;
    return {
      q: `A service stores ${big(writes)} new records a day, each ${what}. How much storage does a year of them need, before replication?`,
      ...tens(v, (x) => `≈ ${fmtSize(Number(x.toPrecision(2)))}`),
      why: `${big(writes)} × ${fmtSize(bytes)} = ${fmtSize(writes * bytes)} a day, × 365 = ${fmtSize(Number(v.toPrecision(3)))} a year. Three copies for durability triples it. For scale: one large machine holds tens of terabytes of local SSD.`,
    };
  },
  () => {
    const rps = pick([1e3, 5e3, 2e4]);
    const [bytes, what] = pick([[2e4, 'a 20 kB API response'], [2e5, 'a 200 kB photo'], [1.5e6, 'a 1.5 MB video segment']]);
    const v = rps * bytes * 8;
    const nics = v / NIC_BPS.web;
    return {
      q: `A service sends ${sig(rps)} responses a second, each ${what}. How much bandwidth is that?`,
      ...tens(v, (x) => `≈ ${fmtBits(Number(x.toPrecision(2)))}`),
      why: `${sig(rps)} × ${fmtSize(bytes)} = ${fmtSize(rps * bytes)} per second; × 8 bits = ${fmtBits(v)}. A web server in this simulator sustains ${fmtBits(NIC_BPS.web)}, so that is ${nics < 0.1 ? 'a small fraction of one network card' : nics <= 1 ? `${Math.round(nics * 100)}% of one network card` : `the network cards of ${Math.ceil(nics)} servers, whatever their CPUs are doing: the job of a CDN`}.`,
    };
  },
  () => {
    const ms = pick([2, 5, 10, 50]);
    const cores = pick([4, 8, 16]);
    const v = cores / (ms / 1e3);
    return {
      q: `Each request needs ${ms} ms of CPU time. Roughly how many requests a second can one ${cores}-vCPU server handle before its CPU is full?`,
      ...tens(v, (x) => `≈ ${rate(x)}`),
      why: `One vCPU does 1,000 ms of work a second, so ${sig(1000 / ms)} of these requests. ${cores} vCPUs: ${cores} × ${sig(1000 / ms)} = ${sig(v, 3)}/s. That is the ceiling; in practice you would plan to run at 50–70% of it. The CPU meter in the simulator shows this "CPU per request" figure live.`,
    };
  },
  () => {
    const peak = pick([3000, 6000, 12000, 30000]);
    const per = WORKLOAD.webRps;
    const need = Math.ceil(peak / (per * 0.6));
    return {
      q: `Peak traffic is ${sig(peak)} requests/s. One server handles ${sig(per)} requests/s flat out. You want servers no more than 60% busy at peak, plus one spare so that losing a server is harmless. How many servers?`,
      ...among(String(need + 1), [...new Set([Math.ceil(peak / per), need, (need + 1) * 2])].filter((n) => n !== need + 1).map(String)),
      why: `At 60% a server takes ${sig(per * 0.6)} requests/s. ${sig(peak)} ÷ ${sig(per * 0.6)} = ${sig(peak / (per * 0.6), 3)}, rounded up to ${need}. One spare ("N+1") makes ${need + 1}. Dividing by the full ${sig(per)} gives ${Math.ceil(peak / per)}, which leaves no room for a spike or a failure.`,
    };
  },
  () => {
    const slos = [99, 99.9, 99.99, 99.999];
    const slo = pick(slos);
    const down = (s) => span(30 * DAY * (1 - s / 100));
    return {
      q: `An availability target of ${slo}% allows how much downtime in a 30-day month?`,
      ...among(down(slo), slos.filter((s) => s !== slo).map(down)),
      why: `A 30-day month is 43,200 minutes. ${slo}% up means ${parseFloat((100 - slo).toFixed(3))}% down: ${down(slo)}. Each extra nine divides the allowance by ten: ${slos.map((s) => `${s}% → ${down(s)}`).join(', ')}.`,
    };
  },
  () => {
    const items = pick([1e6, 1e7, 1e8]);
    const bytes = pick([1e3, 1e4]);
    const v = items * bytes;
    const node = SPECS.cache.ramGB * 1e9;
    return {
      q: `You want to cache ${big(items)} objects of about ${fmtSize(bytes)} each. How much memory is that?`,
      ...tens(v, (x) => `≈ ${fmtSize(Number(x.toPrecision(2)))}`),
      why: `${big(items)} × ${fmtSize(bytes)} = ${fmtSize(v)}. ${v <= node ? `That fits in the single ${fmtGB(SPECS.cache.ramGB)} cache node this simulator starts with.` : `That is ${Math.ceil(v / node)} of the ${fmtGB(SPECS.cache.ramGB)} cache nodes this simulator uses, or one large-memory machine: 512 GiB is an ordinary size today.`}`,
    };
  },
  // ---- figures worth knowing by heart
  () => ({
    q: 'Roughly how many seconds are there in a day?',
    ...among('About 10⁵ (86,400)', ['About 10³ (1,440)', 'About 10⁴ (8,640)', 'About 10⁶ (864,000)']),
    why: '24 × 60 × 60 = 86,400. Rounding it to 100,000 turns "per day" into "per second" by dropping five zeros: a million a day is about 12 a second.',
  }),
  () => ({
    q: 'A read from an SSD is roughly how much slower than a read from memory?',
    ...among('About 1,000 times', ['About 2 times', 'About 10 times', 'About 1,000,000 times']),
    why: 'About 100 nanoseconds from memory against about 100 microseconds from an SSD. That factor of a thousand is why a cache in front of a database pays for itself, and why a database slows sharply once its working set no longer fits in memory.',
  }),
  () => ({
    q: 'How long does a network round trip take between two zones of the same cloud region?',
    ...among('1–2 ms', ['Under 0.01 ms', '20–30 ms', 'About 150 ms']),
    why: 'Inside one zone it is under a millisecond; between zones of a region, 1–2 ms; between regions, 50–150 ms. So replicating across zones is cheap, while a request that crosses regions several times cannot be fast.',
  }),
  () => ({
    q: 'How many megabytes a second can a 1 Gbps network link carry?',
    ...among('125 MB/s', ['8 MB/s', '1,000 MB/s', '8,000 MB/s']),
    why: 'Links are quoted in bits, files in bytes: divide by 8. 1 Gbps = 125 MB/s, which is about 80 video segments of 1.5 MB each, every second.',
  }),
  () => ({
    q: 'Your dataset is 300 GB. Can it be held entirely in the memory of one machine?',
    ...among('Yes: 512 GiB is an ordinary large instance', ['No: about 64 GB is the practical limit', 'No: memory tops out near 128 GB', 'Only on specialised hardware not offered by cloud providers']),
    why: 'A general-purpose AWS m6i.32xlarge has 512 GiB, and memory-optimised instances reach 4 TB and beyond. A common mistake is to split data across machines for capacity long before one machine is full. Split for availability or for write throughput instead.',
  }),
  () => ({
    q: 'With no CDN, a web server is streaming 1.5 MB video segments. Requests are failing, but its CPU is at 30%. What has most likely run out?',
    ...among('Its network bandwidth', ['Its memory', 'Its disk space', 'Its database connections']),
    why: `Sending bytes costs little CPU, but every byte has to pass through the network card. At the ${fmtBits(NIC_BPS.web)} a web server sustains in this simulator, that is ${sig(NIC_BPS.web / 8 / 1.5e6)} segments a second and no more. Try it: load the YouTube system and remove the CDN.`,
  }),
  () => ({
    q: 'A database is overloaded and 90% of its work is writes. Will adding read replicas fix it?',
    ...among('No: every replica must apply every write too', ['Yes: each replica takes a share of the writes', 'Yes: replicas double capacity each time', 'Only if there are at least three replicas']),
    why: 'A replica takes reads off the primary, and nothing else. All writes still go to the one primary, and each replica has to replay them as well. Write capacity comes from a bigger machine, sharding, or an engine that spreads writes across nodes.',
  }),
];
const ROUND = 8;

export function initNumbers(sim) {
  const dlg = document.createElement('dialog');
  dlg.id = 'numbers';
  dlg.className = 'dlg';
  dlg.innerHTML = `
    <form method="dialog" class="pl-head"><div><h3><span class="learn-tag">Learn</span>Numbers to know</h3><p class="hint">Estimating a system means multiplying a few remembered figures. They only need to be right to the nearest power of ten.</p></div><button aria-label="Close">✕</button></form>
    <div class="seg dg-tabs" role="group" aria-label="Section"><button data-tab="learn">The numbers</button><button data-tab="quiz">Quiz</button></div>
    <div class="dg-body" id="nm-body"></div>`;
  document.body.append(dlg);
  let tab = 'learn';
  let quiz = null; // { items, i, picked, score }
  let best = 0;
  try {
    best = +localStorage.getItem('numbers-best') || 0;
  } catch {
    // storage is unavailable in private windows; the quiz works without it
  }

  const learn = () => {
    const lo = Math.log10(LATENCY[0][1]);
    const hi = Math.log10(LATENCY[LATENCY.length - 1][1]);
    const db = sim.techOf('db');
    const lb = sim.techOf('lb');
    const kafka = sim.techOf('kafka');
    const gbps = (t) => fmtBits(NIC_BPS[t]);
    const model = [
      ['Web server', `${SPECS.web.cores} vCPUs · ${fmtGB(SPECS.web.ramGB)} · ${gbps('web')}`, `${sig(WORKLOAD.webRps)} requests/s (≈ ${sig((SPECS.web.cores / WORKLOAD.webRps) * 1e3)} ms of CPU each)`],
      ['Worker', `${SPECS.worker.cores} vCPUs · ${fmtGB(SPECS.worker.ramGB)} · ${gbps('worker')}`, `${sig(WORKLOAD.jobRate)} jobs/s`],
      ['Cache node', `${SPECS.cache.cores} vCPUs · ${fmtGB(SPECS.cache.ramGB)} · ${gbps('cache')}`, `${sig(CACHE_NODE_CAP)} lookups/s`],
      [`Database (${db.name})`, `${(db.spec || SPECS.db).cores || '—'} vCPUs · ${fmtGB((db.spec || SPECS.db).ramGB)} · ${gbps('db')}`, `${sig(db.cap)} reads/s; a write costs ${db.writeCost === 1 ? 'the same' : db.writeCost + ' reads'}`],
      [`Load balancer (${lb.name})`, gbps('lb'), `${sig(lb.cap)} requests/s`],
      [`Event stream (${kafka.name})`, `${SPECS.kafka.cores} vCPUs · ${gbps('kafka')}`, `${sig(kafka.cap)} events/s`],
    ];
    return `
      <section><h2>How long things take</h2>
        <p class="d-about">Each step down this list is ten to a thousand times slower than the one above. The bars are on a logarithmic scale; on a linear one, everything but the last row would be invisible.</p>
        <div class="nm-lat">${LATENCY.map(([what, s, shown, why]) => `<div class="nm-row"><span>${what}</span><b>${shown}</b><i style="width:${Math.max(2, ((Math.log10(s) - lo) / (hi - lo)) * 100)}%"></i><small>${why}</small></div>`).join('')}</div>
      </section>
      <section><h2>How big one machine can be</h2>
        <p class="d-about">Hardware has grown faster than most intuitions about it. Before deciding that something needs many machines, check that it would not fit on one.</p>
        <div class="dg-scroll"><table class="dg-table"><tbody>${HARDWARE.map(([a, b, c]) => `<tr><th>${a}</th><td><b>${b}</b></td><td>${c}</td></tr>`).join('')}</tbody></table></div>
      </section>
      <section><h2>The machines in this simulator</h2>
        <p class="d-about">Mid-sized instances, which is why they are easy to overload. The network figure is the sustained baseline AWS publishes for that instance size; each can burst to 10 Gbps for a short while. Throughput is this model's assumption for the technology currently selected: measure your own with a load test.</p>
        <div class="dg-scroll"><table class="dg-table"><thead><tr><th>Component</th><th>Machine</th><th>Handles, before it saturates</th></tr></thead><tbody>${model.map(([a, b, c]) => `<tr><th>${a}</th><td>${b}</td><td>${c}</td></tr>`).join('')}</tbody></table></div>
      </section>
      <section><h2>Shortcuts for estimating</h2>
        <ul class="tips">
          <li><b>A day is about 10⁵ seconds</b> (86,400). So 1 million a day ≈ 12 a second, and 1 billion a day ≈ 12,000 a second.</li>
          <li><b>A month is about 2.6 million seconds</b>, which is why $0.10 an hour is about $73 a month.</li>
          <li><b>Bits and bytes differ by 8.</b> 1 Gbps = 125 MB/s.</li>
          <li><b>Each "nine" of availability is ten times stricter.</b> Per 30-day month: 99% allows 7.2 hours of downtime, 99.9% 43 minutes, 99.99% 4.3 minutes.</li>
          <li><b>Sizes to carry around:</b> a database row ≈ 1 kB, a compressed photo ≈ 200 kB, a few seconds of video ≈ 1.5 MB. These are the figures the preset systems here use.</li>
          <li><b>Peak is a multiple of average.</b> Size for the peak, then leave headroom: servers at 50–70% busy, plus one spare.</li>
        </ul>
      </section>
      <p class="hint">Latencies are the widely quoted "latency numbers every programmer should know", rounded to a power of ten; they vary with hardware. Machine sizes and datacenter latencies follow the free section of <a href="${SOURCE}" target="_blank" rel="noopener">Hello Interview: Numbers to Know</a>, and match AWS's published instance specifications.</p>`;
  };

  const start = () => (quiz = { items: shuffle(QUESTIONS).slice(0, ROUND).map((make) => make()), i: 0, picked: null, score: 0 });
  const quizView = () => {
    if (!quiz) start();
    if (quiz.i >= quiz.items.length) {
      const s = quiz.score;
      const n = quiz.items.length;
      return `<div class="nm-done"><h2>Round complete</h2><p class="nm-score">${s} / ${n}</p>
        <p class="d-about">${s === n ? 'All correct.' : s >= n * 0.75 ? 'Solid. The ones you missed are worth another look in "The numbers".' : 'These get easier quickly: most are one multiplication once the figures in "The numbers" are familiar.'} Best so far: ${best} / ${n}.</p>
        <div class="btns"><button data-act="again" class="primary">New round, new numbers</button><button data-tab="learn">Review the numbers</button></div></div>`;
    }
    const it = quiz.items[quiz.i];
    const done = quiz.picked !== null;
    return `<div class="nm-quiz">
      <p class="hint">Question ${quiz.i + 1} of ${quiz.items.length} · ${quiz.score} correct so far</p>
      <p class="nm-q">${it.q}</p>
      <div class="nm-choices">${it.choices
        .map((c, i) => `<button data-choice="${i}"${done ? ' disabled' : ''}${done && i === it.answer ? ' data-mark="right"' : done && i === quiz.picked ? ' data-mark="wrong"' : ''}>${c}${done && i === it.answer ? ' ✓' : done && i === quiz.picked ? ' ✕' : ''}</button>`)
        .join('')}</div>
      ${done ? `<div class="nm-why" data-ok="${quiz.picked === it.answer}"><b>${quiz.picked === it.answer ? 'Correct.' : 'Not quite.'}</b> ${it.why}</div><div class="btns"><button data-act="next" class="primary">${quiz.i + 1 < quiz.items.length ? 'Next question' : 'See result'}</button></div>` : ''}
    </div>`;
  };

  const render = () => {
    for (const b of dlg.querySelectorAll('.dg-tabs [data-tab]')) b.setAttribute('aria-pressed', b.dataset.tab === tab);
    $('nm-body').innerHTML = tab === 'learn' ? learn() : quizView();
  };

  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) return dlg.close(); // click on the backdrop
    const t = e.target.closest('[data-tab]');
    const choice = e.target.closest('[data-choice]');
    const act = e.target.closest('[data-act]');
    if (t) {
      tab = t.dataset.tab;
      $('nm-body').scrollTop = 0;
    } else if (choice && quiz.picked === null) {
      quiz.picked = +choice.dataset.choice;
      if (quiz.picked === quiz.items[quiz.i].answer) quiz.score++;
    } else if (act && act.dataset.act === 'next') {
      quiz.i++;
      quiz.picked = null;
      if (quiz.i >= quiz.items.length && quiz.score > best) {
        best = quiz.score;
        try {
          localStorage.setItem('numbers-best', best);
        } catch {
          // not saved; it still shows for this session
        }
      }
    } else if (act && act.dataset.act === 'again') start();
    else return;
    render();
  });
  // Esc closes the dialog natively; keep it from also reaching the app's own Esc handler
  dlg.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation());
  $('numbers-open').addEventListener('click', () => {
    render();
    dlg.showModal();
  });
}
