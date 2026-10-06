// Traffic shape over time, and the autoscalers that chase it.
// Kept out of sim.js: Sim.step calls in from its clients, web server and worker sections.
//
// Time is compressed. Provisioning and control-loop timings run roughly 10× faster
// than life (1 simulated second ≈ 10 real seconds); the daily cycle is compressed far
// more (a day in two minutes) so a whole one fits on screen. What is kept is what
// matters: VMs boot much slower than containers, serverless has no boot at all, and
// scaling in is slower than scaling out.
import { costs } from './cost.js';

// Settings added to Sim.params.
export const AUTO_PARAMS = {
  pattern: 'steady', // traffic shape applied on top of the slider
  autoscale: false, // target-tracking autoscaling of the web tier
  asMin: 2,
  asMax: 6,
  asTarget: 60, // % CPU the web tier is held at
  workerAuto: false, // scale workers on queue depth
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (x) => x * x * (3 - 2 * x);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- traffic patterns
export const DAY = 120; // simulated seconds per 24 hours
const DAY_START = 6; // the clock starts at 06:00, just before the morning climb
// Consumer web traffic as a fraction of the evening peak, by hour of day: a trough
// around 04:00–05:00 at about a third of the peak (peak-to-trough ≈ 3:1 is typical
// for a service whose users share a few time zones), a lunchtime shoulder, and the
// busiest hour after dinner.
const DAY_CURVE = [[0, 0.55], [2, 0.38], [4.5, 0.3], [7, 0.42], [9, 0.68], [12, 0.8], [14, 0.76], [17, 0.85], [20.5, 1], [22.5, 0.8], [24, 0.55]];
const hourAt = (t) => (DAY_START + (t / DAY) * 24) % 24;
function dayMul(h) {
  for (let i = 1; i < DAY_CURVE.length; i++) {
    const [h0, m0] = DAY_CURVE[i - 1];
    const [h1, m1] = DAY_CURVE[i];
    if (h <= h1) return m0 + (m1 - m0) * smooth((h - h0) / (h1 - h0));
  }
  return DAY_CURVE[0][1];
}
const clock = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 6) * 10).padStart(2, '0')}`;
const dayPart = (h) => (h < 6 ? 'night trough' : h < 11 ? 'morning climb' : h < 15 ? 'midday' : h < 19 ? 'afternoon' : h < 22.5 ? 'evening peak' : 'winding down');

// Launch day: start at a tenth of the planned load and grow to all of it.
const RAMP_FROM = 0.1;
const RAMP_SECS = 90;

// Flash crowd (a viral link, a push notification to every user): traffic multiplies
// within a minute or two and takes an hour or more to fade. 3–10× is the usual range.
const FLASH_PEAK = 5;
const FLASH_LEAD = 3; // seconds of calm before it hits
const FLASH_RISE = 2;
const FLASH_DECAY = 35; // seconds for the excess to fall to 37%
const FLASH_EVERY = 120; // it repeats, so there is always another one coming
function flashMul(t) {
  const ph = t % FLASH_EVERY;
  if (ph < FLASH_LEAD) return 1;
  if (ph < FLASH_LEAD + FLASH_RISE) return 1 + (FLASH_PEAK - 1) * smooth((ph - FLASH_LEAD) / FLASH_RISE);
  return 1 + (FLASH_PEAK - 1) * Math.exp(-(ph - FLASH_LEAD - FLASH_RISE) / FLASH_DECAY);
}

// mul(t): multiplier on the slider's rate, t seconds after the pattern was chosen.
export const PATTERNS = {
  steady: { name: 'Steady', mul: () => 1, info: () => 'Flat: the slider is the load.' },
  daily: {
    name: 'Daily cycle (slider = evening peak)',
    mul: (t) => dayMul(hourAt(t)),
    info: (t, m) => `${clock(hourAt(t))} · ${dayPart(hourAt(t))} · ×${m.toFixed(2)} of the peak. One day takes ${DAY / 60} minutes.`,
  },
  ramp: {
    name: 'Gradual ramp (launch day)',
    mul: (t) => RAMP_FROM + (1 - RAMP_FROM) * Math.min(1, t / RAMP_SECS),
    info: (t, m) => (t < RAMP_SECS ? `Launch day · ×${m.toFixed(2)} and growing · full load in ${Math.ceil(RAMP_SECS - t)}s.` : 'Launch day · ×1.00, fully ramped.'),
  },
  flash: {
    name: `Flash crowd (${FLASH_PEAK}×, fades slowly)`,
    mul: flashMul,
    info: (t, m) => (t % FLASH_EVERY < FLASH_LEAD ? `Calm · ×1.00 · flash crowd in ${Math.ceil(FLASH_LEAD - (t % FLASH_EVERY))}s.` : `Flash crowd · ×${m.toFixed(2)} and fading · next in ${Math.ceil(FLASH_EVERY - (t % FLASH_EVERY))}s.`),
  },
};

// ---------------------------------------------------------------- autoscaling constants
// Seconds from "launch" to "in service" (boot + application start + first passing
// health check), compressed ~10×. null: cannot be provisioned on demand at all.
//   VM         ~3 min   EC2 / Compute Engine instance boot, app start, health-check grace
//   Fargate    ~60 s    network interface attach + image pull
//   Kubernetes ~40 s    pod scheduled onto a node that already exists
//   serverless  none    the platform starts an environment per request; the first
//                       request to each new one pays a cold start instead (COLD_START)
const LAUNCH = {
  web: { ec2: 18, gce: 18, fargate: 6, gke: 4, lambda: 0, cloudrun: 0, metal: null },
  worker: { ec2: 18, gce: 18, lambda: 0, cloudrun: 0 },
};
// Extra latency on a freshly started serverless environment, in real seconds (a cold
// start is not compressed, it is a property of each request): ~0.4 s for a Lambda
// function with a normal-sized runtime, ~1 s to start a Cloud Run container.
const COLD_START = { lambda: 0.4, cloudrun: 1 };
const COLD_FADE = 2; // seconds until a new environment is serving warm

const EVAL = 1; // the policy runs once a second (Kubernetes HPA: every 15 s; CloudWatch: 1-minute datapoints)
const WINDOW = 4; // the metric is averaged over this long, so one noisy sample cannot trigger scaling
const TOLERANCE = 0.1; // no action within ±10% of the target (the HPA default)
// Scale in only to the highest capacity recommended over this window (HPA's
// "stabilization window", 5 minutes by default), then one server per cooldown.
// Shortened further than 10× so that a two-minute day still shows a night-time scale-in.
const STABILIZE = 15;
const COOLDOWN = 5;

// Workers: "backlog per instance", the policy AWS recommends for queue consumers.
// The target is how long a job may wait: 2 s of work queued per worker.
const BACKLOG_SECS = 2;
const WORKER_MAX = 6; // the pool the scene draws
const WORKER_HEADROOM = 0.85; // scale in only if one fewer worker would still be under 85% busy

// Per-run state lives beside the nodes, so Sim.reset() starts it afresh.
function state(sim) {
  let s = sim._auto;
  if (!s || s.nodes !== sim.nodes)
    s = sim._auto = { nodes: sim.nodes, pattern: null, t: 0, mul: 1, acc: 0, sum: 0, win: [], recs: [], wait: 0, metric: 0, wAcc: 0, wSum: 0, wArr: 0, wLow: 0, wWait: 0, wDepth: 0, wPending: [], cAcc: 0, cost: [] };
  return s;
}
const launching = (w) => w.launching > 0;
const inService = (w) => w.active && !w.down && !launching(w);

// ---------------------------------------------------------------- clients
// Multiplier on the traffic slider for this step.
export function trafficShape(sim, dt) {
  const s = state(sim);
  const pat = PATTERNS[sim.params.pattern] || PATTERNS.steady;
  const before = s.t;
  if (s.pattern !== pat) {
    s.pattern = pat;
    s.t = 0;
  } else s.t += dt;
  s.mul = pat.mul(s.t);
  if (pat === PATTERNS.flash && before % FLASH_EVERY < FLASH_LEAD && s.t % FLASH_EVERY >= FLASH_LEAD)
    sim.emit('log', 'warn', `Flash crowd: traffic jumps ${FLASH_PEAK}× within seconds and fades slowly`);
  sampleCost(sim, s, dt);
  return s.mul;
}

// → { mul, text } for the line under the traffic slider
export function trafficInfo(sim) {
  const s = state(sim);
  const pat = PATTERNS[sim.params.pattern] || PATTERNS.steady;
  const mul = s.pattern === pat ? s.mul : pat.mul(0);
  return { mul, text: pat.info(s.pattern === pat ? s.t : 0, mul) };
}

// ---------------------------------------------------------------- web tier
// Runs boot timers and the target-tracking policy, then rewrites `alive` (the servers
// the load balancer routes to) so that launching servers get no traffic. Returns how
// many are in service.
export function scaleWeb(sim, dt, alive, lbOut) {
  const s = state(sim);
  const p = sim.params;
  const tech = sim.techOf('web');
  const lag = LAUNCH.web[p.tech.web];

  // a launch in flight finishes whether or not the policy is still on
  for (const w of sim.webs) {
    if (w.coldLat > 0) w.coldLat = w.coldLat < 1e-3 ? 0 : w.coldLat * Math.exp(-dt / COLD_FADE);
    if (!w.active || w.down) w.launching = 0;
    if (!launching(w)) continue;
    w.launching -= dt;
    if (!launching(w)) {
      w.launching = 0;
      sim.emit('log', 'good', `${w.label} in service after a ${lag}s launch`);
      continue;
    }
    // booting: billed from the moment it is requested, useless until it passes a health check
    w._cache = w._db = w._events = w._jobs = 0;
    w.inRate = w.outRate = w.dropRate = w.util = w.queue = w.stress = w.threads = w.latency = w.bps = 0;
    w.cpu = 0.35;
    w.mem = 0.15;
    w.disk = 0.18;
    w.status = `Launching: ${tech.name} is booting, starting the application and waiting for its first health check. In service in ${Math.ceil(w.launching)}s — until then it takes no traffic, but it is already on the bill.`;
  }

  if (p.autoscale && lag != null) policy(sim, s, dt, lag, lbOut);
  else {
    s.acc = s.sum = 0;
    s.win.length = s.recs.length = 0;
  }

  const before = alive.length;
  alive.length = 0;
  for (const w of sim.webs) if (inService(w) && sim.edges.has(`lb>${w.id}`)) alive.push(w);
  const lb = sim.nodes.lb;
  const booting = sim.webs.filter(launching).length;
  if (booting && lbOut > 0) {
    if (!alive.length) {
      lb.outRate = 0;
      lb.dropRate = lb.inRate;
      lb.status = 'Every web server is still launching. Requests fail with 503 until one passes its health check.';
    } else if (alive.length !== before) lb.status = `Routing across ${plural(alive.length, 'healthy server')}; ${booting} more still launching.`;
  }
  return alive.length;
}

function policy(sim, s, dt, lag, lbOut) {
  const p = sim.params;
  const tech = sim.techOf('web');
  const total = sim.webs.filter((w) => w.active); // provisioned: in service, launching or restarting
  const live = total.filter(inService);
  const max = Math.min(p.asMax, sim.webs.length);
  const min = Math.min(p.asMin, max);
  const target = p.asTarget / 100;
  const what = tech.serverless ? 'concurrency' : 'CPU';
  s.wait -= dt;

  const add = (want, why) => {
    const n = Math.min(want, max) - total.length;
    if (n <= 0) return;
    sim.emit('log', 'warn', `Autoscaling out: ${why} → ${plural(total.length + n, 'web server')}${lag ? ` (${tech.name} takes ~${lag}s to launch)` : ''}`);
    for (let i = 0; i < n; i++) {
      const w = sim.webs.find((x) => !x.active);
      sim.setActive(w.id, true);
      w.launching = lag;
      w.coldLat = COLD_START[p.tech.web] || 0;
      total.push(w);
    }
    s.wait = COOLDOWN;
  };

  // Serverless scales on requests in flight, not on a polled average: the platform
  // sees real demand and adds environments at once. It is the reason it survives a flash crowd.
  const unit = live.reduce((a, w) => a + (w.cap || 0), 0) / (live.length || 1);
  if (tech.serverless && unit > 0) add(Math.ceil(lbOut / (unit * target) - 1e-9), `${Math.round(lbOut)} req/s in flight`);

  // The metric: average CPU across in-service servers. CPU cannot read above 100%, so
  // a fleet that is 3× overloaded still only asks for 1/target more capacity per round.
  const metric = !live.length ? 0 : tech.serverless ? (unit > 0 ? lbOut / (unit * live.length) : 0) : live.reduce((a, w) => a + w.cpu, 0) / live.length;
  s.sum += metric * dt;
  s.acc += dt;
  if (s.acc < EVAL) return;
  s.win.push(s.sum / s.acc);
  s.acc = s.sum = 0;
  if (s.win.length > WINDOW / EVAL) s.win.shift();
  const avg = s.win.reduce((a, v) => a + v, 0) / s.win.length;
  s.metric = avg;

  // desired = ceil(in service × metric ÷ target): the rule behind both AWS target tracking and the HPA
  const ratio = avg / target;
  let want = total.length;
  if (live.length && Math.abs(ratio - 1) > TOLERANCE) want = Math.ceil(live.length * ratio - 1e-9);
  want = clamp(want, min, max);
  s.recs.push(want);
  if (s.recs.length > STABILIZE / EVAL) s.recs.shift();
  const pct = `${what} ${Math.round(avg * 100)}% vs ${p.asTarget}% target`;

  if (want > total.length) add(want, total.length < min ? `below the minimum of ${min}` : pct);
  else if (total.some(launching) || s.wait > 0) return;
  else {
    // scale in: slowly, and never below anything recommended recently
    const settled = total.length > max ? max : s.recs.length >= STABILIZE / EVAL ? Math.max(...s.recs) : total.length;
    if (settled >= total.length) return;
    const w = total[total.length - 1];
    sim.emit('log', 'good', `Autoscaling in: ${pct} for ${STABILIZE}s → ${plural(total.length - 1, 'web server')}`);
    sim.setActive(w.id, false);
    s.wait = COOLDOWN;
  }
}

// ---------------------------------------------------------------- workers
// Backlog-per-worker scaling. Called at the end of the queue + workers section.
export function scaleWorkers(sim, dt) {
  const s = state(sim);
  const p = sim.params;
  const { queue, worker } = sim.nodes;
  const tech = sim.techOf('worker');
  const lag = LAUNCH.worker[p.tech.worker];

  s.wPending = s.wPending.map((t) => t - dt);
  while (s.wPending.length && s.wPending[0] <= 0) {
    s.wPending.shift();
    if (p.workerCount >= WORKER_MAX) continue;
    p.workerCount++;
    sim.emit('log', 'good', `Worker ${p.workerCount} in service after its launch`);
  }
  if (s.wPending.length && !worker.down && worker.active) worker.status += ` ${plural(s.wPending.length, 'more worker')} launching (${Math.ceil(s.wPending[0])}s).`;

  if (!p.workerAuto || lag == null || !worker.active || worker.down || !queue.active || queue.down) {
    s.wAcc = s.wSum = s.wArr = s.wLow = 0;
    return;
  }
  s.wWait -= dt;
  s.wSum += queue.queue * dt;
  s.wArr += queue.inRate * dt;
  s.wAcc += dt;
  if (s.wAcc < EVAL) return;
  const depth = s.wSum / s.wAcc;
  const arriving = s.wArr / s.wAcc;
  const took = s.wAcc;
  s.wAcc = s.wSum = s.wArr = 0;
  s.wDepth = depth;

  const rate = worker.cap / p.workerCount; // jobs/s one worker finishes
  const have = p.workerCount + s.wPending.length;
  const want = clamp(Math.ceil(depth / (rate * BACKLOG_SECS)), 1, WORKER_MAX);
  if (want > have) {
    sim.emit('log', 'warn', `Workers scaling out: ${Math.round(depth).toLocaleString()} jobs waiting → ${plural(want, 'worker')}${lag ? ` (${tech.name} takes ~${lag}s to launch)` : ''}`);
    for (let i = have; i < want; i++) lag ? s.wPending.push(lag) : p.workerCount++;
    s.wWait = COOLDOWN;
    s.wLow = 0;
    return;
  }
  // An empty queue says nothing about how many workers it takes to keep it empty, so
  // scaling in on backlog alone flaps. Also require that one fewer could keep up.
  const spare = depth < rate * BACKLOG_SECS * 0.25 && arriving <= (p.workerCount - 1) * rate * WORKER_HEADROOM;
  s.wLow = spare && !s.wPending.length ? s.wLow + took : 0;
  if (s.wLow >= STABILIZE && s.wWait <= 0 && p.workerCount > 1) {
    p.workerCount--;
    sim.emit('log', 'good', `Workers scaling in: queue empty for ${STABILIZE}s → ${plural(p.workerCount, 'worker')}`);
    s.wWait = COOLDOWN;
  }
}

// ---------------------------------------------------------------- for the control panel
// → { web, worker, locked }: one line of status each; `locked` when the web stepper is the autoscaler's
export function autoInfo(sim) {
  const s = state(sim);
  const p = sim.params;
  const tech = sim.techOf('web');
  const lag = LAUNCH.web[p.tech.web];
  const boot = sim.webs.filter(launching);
  const live = sim.webs.filter(inService).length;
  let web;
  if (lag == null) web = `${tech.name} cannot autoscale: new hardware takes weeks to arrive, not seconds.`;
  else if (!p.autoscale) web = lag ? `${tech.name}: a new server takes ~${lag}s to come into service.` : `${tech.name}: new capacity is instant, but its first requests pay a ${COLD_START[p.tech.web]}s cold start.`;
  else
    web =
      `${live} in service` +
      (boot.length ? ` · ${boot.length} launching (${Math.ceil(Math.max(...boot.map((w) => w.launching)))}s)` : '') +
      ` · ${tech.serverless ? 'concurrency' : 'CPU'} ${Math.round(s.metric * 100)}% vs ${p.asTarget}% target`;
  const wt = sim.techOf('worker');
  const wlag = LAUNCH.worker[p.tech.worker];
  const per = Math.round(((sim.nodes.worker.cap || 0) / p.workerCount) * BACKLOG_SECS);
  const worker = !p.workerAuto
    ? ''
    : `${Math.round(s.wDepth).toLocaleString()} jobs waiting · target ${per.toLocaleString()} per worker` + (s.wPending.length ? ` · ${s.wPending.length} launching (${Math.ceil(s.wPending[0])}s)` : wlag ? ` · ${wt.name} launches in ~${wlag}s` : '');
  return { web, worker, locked: p.autoscale && lag != null };
}

// Deep links: ?pattern=daily&autoscale=1&asmin=2&asmax=6&astarget=60&wauto=1
export function autoQuery(p, q) {
  if (PATTERNS[q.get('pattern')]) p.pattern = q.get('pattern');
  if (q.has('autoscale')) p.autoscale = q.get('autoscale') !== '0';
  if (q.has('wauto')) p.workerAuto = q.get('wauto') !== '0';
  if (q.has('asmax')) p.asMax = clamp(Math.round(+q.get('asmax')) || 6, 1, 6);
  if (q.has('asmin')) p.asMin = clamp(Math.round(+q.get('asmin')) || 1, 1, p.asMax);
  p.asMin = Math.min(p.asMin, p.asMax);
  if (q.has('astarget')) p.asTarget = clamp(Math.round(+q.get('astarget')) || 60, 30, 90);
}

// ---------------------------------------------------------------- cost over time
// The header shows what this instant would cost if it lasted all month. With traffic
// that moves, the bill is the average: sample once a second, keep one cycle.
function sampleCost(sim, s, dt) {
  s.cAcc += dt;
  if (s.cAcc < 1) return;
  s.cAcc = 0;
  s.cost.push({ total: costs(sim).total, webs: sim.webCount, workers: sim.params.workerCount });
  if (s.cost.length > DAY) s.cost.shift();
}

// → null until there is enough history, else { secs, avg, webAvg, webPeak, workerAvg, workerPeak, saved }
// `saved` is what a fixed fleet sized for the busiest moment would have cost on top.
export function costAverage(sim) {
  const c = state(sim).cost;
  if (c.length < 10) return null;
  const mean = (k) => c.reduce((a, x) => a + x[k], 0) / c.length;
  const peak = (k) => Math.max(...c.map((x) => x[k]));
  const out = { secs: c.length, avg: mean('total'), webAvg: mean('webs'), webPeak: peak('webs'), workerAvg: mean('workers'), workerPeak: peak('workers'), saved: 0 };
  // serverless is billed per request, so there is no idle fleet to save on
  const web = sim.techOf('web');
  const worker = sim.techOf('worker');
  if (!web.serverless) out.saved += (out.webPeak - out.webAvg) * web.cost(sim.webs[0], sim.params);
  if (!worker.serverless) out.saved += (out.workerPeak - out.workerAvg) * worker.cost(sim.nodes.worker, { ...sim.params, workerCount: 1 });
  return out;
}
