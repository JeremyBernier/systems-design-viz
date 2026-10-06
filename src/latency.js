// Latency percentiles, client timeouts + retries, and SLO / error-budget accounting.
// Called once per step from the end of Sim.step; keeps its state in sim.rel.
//
// The simulation is a fluid model: it knows rates and mean latencies, not
// individual requests. So the latency distribution is derived analytically:
//
//   1. Service time on each path (cache hit / cache miss / write) is log-normal
//      around the mean the sim already computes. Measured service times are
//      right-skewed and a log-normal is the usual fit.
//   2. Waiting for a free core is the M/M/c queue: a request waits with
//      probability C (Erlang C), and if it waits, the wait is exponential with
//      rate cap × (1 − ρ). That is what makes the tail explode as utilisation
//      ρ approaches 1 while the median barely moves.
//   3. A backlog the fluid model is already carrying (queue ÷ capacity) delays
//      every request equally, so it shifts the whole distribution.
//   4. Service + wait is moment-matched to one log-normal per path
//      (Fenton–Wilkinson), and the end-to-end distribution is the mixture of
//      all paths on all web servers, weighted by traffic. Quantiles of that
//      mixture are found by bisection on its CDF: ≤ 18 components × 24 steps.
//
// Not modelled: correlation between a request's web wait and its database wait,
// and the truncation of slow queries at the web tier's query timeout.

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const ease = (cur, target, dt, tau = 0.3) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

// Spread of service time: σ of ln(latency). 0.5 puts p99 at e^(2.33σ) ≈ 3.2× the
// median, the usual shape of a healthy service (p99 a few times p50).
const SIGMA = 0.5;
// Steady-state M/M/c waits go to infinity at ρ = 1, but the queue needs ever longer
// to get there (~8 s at 0.98 for one web server, minutes beyond) and traffic never
// holds that still. Past this point the sim's own backlog (queue ÷ capacity) carries the delay.
const RHO_MAX = 0.98;
// Retry budget: retries may add at most 10% to a client's real traffic
// (Google SRE book, "Handling Overload"; Finagle's RetryBudget defaults to 20%).
const RETRY_BUDGET = 0.1;
// Mean extra delay from exponential backoff with full jitter: 100 ms base, doubling.
const BACKOFF = 0.3;
const FAIL_FAST = 0.05; // a rejected request comes back quickly, so its retry does too
const WINDOW = 60; // seconds of history the SLO is measured over (same as the charts)
const P99 = 0.99; // "p99 under X" means 99% of responses are faster than X

export const RETRY_POLICIES = {
  off: 'Off — a failed request just fails',
  naive: 'Naive — retry immediately',
  backoff: 'Backoff + jitter + 10% budget',
};
export const SLO_TARGETS = [99, 99.5, 99.9, 99.99];
export const DEFAULTS = {
  timeout: 1, // seconds a client waits before giving up
  retryPolicy: 'off',
  maxRetries: 3, // the SRE book's per-request cap is 3 attempts
  sloAvail: 99.9, // % of requests that must succeed
  sloP99: 300, // ms
};

// Standard normal CDF (Abramowitz & Stegun 26.2.17, error < 1e-7).
function phi(z) {
  const k = 1 / (1 + 0.2316419 * Math.abs(z));
  const tail = 0.3989423 * Math.exp((-z * z) / 2) * k * (0.3193815 + k * (-0.3565638 + k * (1.781478 + k * (-1.821256 + k * 1.330274))));
  return z > 0 ? 1 - tail : tail;
}

// Variance of a log-normal with this mean and spread SIGMA.
const lnVar = (mean) => mean * mean * (Math.exp(SIGMA * SIGMA) - 1);

const NO_WAIT = { mean: 0, vari: 0 };
// Queueing delay in an M/M/c queue: `cores` servers, `cap` requests/s in total.
// P(wait) uses Sakasegawa's approximation to Erlang C: ρ^(√(2(c+1)) − 1).
function wait(rho, cores, cap) {
  if (!(cap > 0) || !(rho > 0)) return NO_WAIT;
  const r = Math.min(rho, RHO_MAX);
  const pWait = Math.pow(r, Math.sqrt(2 * (cores + 1)) - 1);
  const drain = cap * (1 - r); // spare capacity empties the queue
  return { mean: pWait / drain, vari: (pWait * (2 - pWait)) / (drain * drain) };
}

// A mixture of shifted log-normals. parts: [weight, mean, variance, shift] in seconds.
function mixture(parts) {
  const c = [];
  let W = 0;
  let mean = 0;
  let lo = Infinity;
  let hi = 0;
  for (const [w, m, v, d] of parts) {
    if (!(w > 0) || !(m > 0) || !isFinite(m + v + d)) continue;
    const s2 = Math.max(1e-6, Math.log(1 + v / (m * m)));
    const s = Math.sqrt(s2);
    const mu = Math.log(m) - s2 / 2;
    c.push([w, mu, s, d]);
    W += w;
    mean += w * (m + d);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d + Math.exp(mu + 4 * s));
  }
  if (!W) return null;
  const cdf = (x) => {
    let a = 0;
    for (const [w, mu, s, d] of c) if (x > d) a += w * phi((Math.log(x - d) - mu) / s);
    return a / W;
  };
  const q = (p) => {
    let a = lo;
    let b = hi;
    for (let i = 0; i < 24; i++) {
      const m = (a + b) / 2;
      if (cdf(m) < p) a = m;
      else b = m;
    }
    return b;
  };
  return { mean: mean / W, p50: q(0.5), p95: q(0.95), p99: q(P99), tail: (x) => 1 - cdf(x) };
}

const IDLE = { mean: 0, p50: 0, p95: 0, p99: 0 };
// Smooth displayed percentiles the same way the sim smooths its other numbers.
function blend(cur, d, dt) {
  if (!cur) return { mean: d.mean, p50: d.p50, p95: d.p95, p99: d.p99 };
  for (const k in IDLE) cur[k] = ease(cur[k], d[k], dt);
  return cur;
}

export function initReliability(sim) {
  for (const k in DEFAULTS) if (!(k in sim.params)) sim.params[k] = DEFAULTS[k];
  sim.rel = {
    retryRate: 0, // retries arriving per second; added to the next step's traffic
    lat: { ...IDLE },
    win: [0, 1, 2, 3].map(() => new Array(WINDOW).fill(0)), // per second: responses, failed, served, slow
    sum: [0, 0, 0, 0],
    bucket: -1,
    avail: 1,
    fast: 1,
    availOk: true,
    latOk: true,
    budgetLeft: 1,
    badNow: 0,
    burn: 0,
    amp: 1,
    storm: false,
    capped: false,
    status: '',
    note: '',
  };
  Object.assign(sim.totals, { p50: 0, p95: 0, p99: 0, orig: 0, retries: 0, timeouts: 0 });
}

// `incoming` already includes last step's retries; `ok` and `err` are this step's
// responses as the servers see them (before client timeouts).
export function reliability(sim, dt, incoming, ok, err) {
  const p = sim.params;
  const N = sim.nodes;
  const r = sim.rel;
  const t = sim.totals;
  const off = (n) => n.down || !n.active;

  // ---- database: one path, queueing for its cores
  const db = N.db;
  let dbWait = NO_WAIT;
  db.pct = off(db) ? null : db.pct;
  if (!off(db) && db.capUnits > 0) {
    dbWait = wait(db.util, (db.spec && db.spec.cores) || 64, db.capUnits); // no fixed machine: a large fleet
    const shift = Math.min(db.queue / db.capUnits, db.latency);
    const base = db.latency - shift;
    const d = mixture([[1, base + dbWait.mean, lnVar(base) + dbWait.vari, shift]]);
    if (d) {
      db.latency = d.mean; // the average now includes the wait, so web threads feel it too
      db.pct = blend(db.pct, d, dt);
    }
  }

  // ---- web servers: three paths each, all queueing for the same cores
  const parts = [];
  for (const w of sim.webs) {
    if (off(w) || !w._mix || !(w.cap > 0)) {
      w.pct = null;
      continue;
    }
    const ww = wait(w.util, (w.spec && w.spec.cores) || 8, w.cap);
    const shift = w.queue / w.cap;
    const own = w._mix.map(([share, m, viaDb]) => [share, m + ww.mean, lnVar(m) + ww.vari + (viaDb ? dbWait.vari : 0), shift]);
    const d = mixture(own);
    if (!d) continue;
    w.latency = d.mean;
    w.pct = blend(w.pct, d, dt);
    for (const [share, m, v, s] of own) parts.push([share * w.outRate, m, v, s]);
  }

  // ---- end to end: every path on every server, weighted by traffic
  const e2e = ok > 0 ? mixture(parts) : null;
  blend(r.lat, e2e || IDLE, dt);
  t.p50 = r.lat.p50;
  t.p95 = r.lat.p95;
  t.p99 = r.lat.p99;
  t.latency = Math.min(r.lat.mean, 10); // the average is the mean of the same distribution
  N.client.pct = e2e ? r.lat : null;

  // ---- client timeout: an answer that arrives too late is a failure, and the work was wasted
  const timedOut = e2e ? ok * e2e.tail(p.timeout) : 0;
  // totals.ok / totals.err were just eased toward ok / err; move the same step toward ok − late / err + late
  const a = 1 - Math.exp(-dt / 0.3);
  t.ok -= timedOut * a;
  t.err += timedOut * a;
  t.errPct = t.ok + t.err > 0 ? t.err / (t.ok + t.err) : 0;
  t.timeouts = ease(t.timeouts, timedOut, dt);

  // ---- retries: each failed attempt is sent again, up to maxRetries times.
  // With attempt failure rate f, one request makes 1 + f + f² + … + fⁿ attempts.
  const orig = Math.max(0, incoming - r.retryRate);
  const failed = err + timedOut;
  const f = ok + err > 0 ? clamp(failed / (ok + err)) : 0;
  const n = p.maxRetries;
  let want = p.retryPolicy === 'off' ? 0 : orig * (f > 0.999 ? n : (f * (1 - Math.pow(f, n))) / (1 - f));
  // Backoff only delays retries; it is the budget that caps the extra load.
  r.capped = p.retryPolicy === 'backoff' && want > RETRY_BUDGET * orig;
  if (r.capped) want = RETRY_BUDGET * orig;
  // a retry follows its failure by the time it took to notice, plus any backoff
  const notice = failed > 0 ? (timedOut * p.timeout + err * FAIL_FAST) / failed : FAIL_FAST;
  r.retryRate = ease(r.retryRate, want, dt, Math.max(0.1, notice + (p.retryPolicy === 'backoff' ? BACKOFF : 0)));
  t.orig = ease(t.orig, orig, dt, 0.2);
  t.retries = ease(t.retries, incoming - orig, dt, 0.2);
  r.amp = t.orig > 1 ? Math.max(1, t.in / t.orig) : 1;

  // ---- SLO over the last WINDOW seconds, measured the usual way: at the front door,
  // per attempt (good responses ÷ all responses). A fluid model cannot follow one
  // request through its retries, so "succeeded in the end" is not knowable here.
  const slow = e2e ? ok * e2e.tail(p.sloP99 / 1000) : 0;
  const b = Math.floor(sim.time) % WINDOW;
  if (b !== r.bucket) {
    r.bucket = b;
    for (let k = 0; k < 4; k++) {
      r.sum[k] = Math.max(0, r.sum[k] - r.win[k][b]);
      r.win[k][b] = 0;
    }
  }
  [ok + err, failed, ok, slow].forEach((v, k) => {
    r.win[k][b] += v * dt;
    r.sum[k] += v * dt;
  });
  const allowed = 1 - p.sloAvail / 100; // the error budget: the share of requests allowed to fail
  r.avail = r.sum[0] > 0 ? clamp(1 - r.sum[1] / r.sum[0]) : 1;
  r.fast = r.sum[2] > 0 ? clamp(1 - r.sum[3] / r.sum[2]) : 1;
  r.budgetLeft = 1 - (1 - r.avail) / allowed;
  // burn rate 1 = failing exactly as fast as the SLO allows; SRE teams page at ~14×
  r.badNow = ease(r.badNow, f, dt, 1);
  r.burn = r.badNow / allowed;
  r.availOk = r.avail >= p.sloAvail / 100;
  r.latOk = r.fast >= P99;

  // ---- plain-language status
  const storm = p.retryPolicy === 'naive' && r.amp > (r.storm ? 1.3 : 1.6);
  if (storm !== r.storm) {
    r.storm = storm;
    if (storm) sim.emit('log', 'crit', `Retry storm: clients are sending ${r.amp.toFixed(1)}× the real traffic`);
    else sim.emit('log', 'good', 'Retry storm over: retries have died down');
  }
  const late = t.ok + t.err > 0 ? t.timeouts / (t.ok + t.err) : 0;
  const pc = (v) => (v < 0.1 ? (v * 100).toFixed(1) : Math.round(v * 100)) + '%';
  const note = storm
    ? `Retry storm: clients re-send every failed request up to ${n} time${n > 1 ? 's' : ''} with no delay, so the system is being offered ${r.amp.toFixed(1)}× the real traffic. The extra load keeps it overloaded, which fails more requests, which causes more retries — a loop that feeds itself and can outlast whatever started it. Break it with backoff and a retry budget, or by shedding load.`
    : r.capped
      ? `Retry budget reached: clients may retry only ${RETRY_BUDGET * 100}% of their traffic, so failures add at most that much load. The rest fail at once instead of piling on, which is what lets the system recover.`
      : late > 0.01
        ? `${pc(late)} of responses arrive after the ${p.timeout} s client timeout. The servers still do the work, but the client has already given up, so it is wasted effort and counts as an error.`
        : r.amp > 1.02
          ? `Clients are retrying failed requests: ${pc(r.amp - 1)} extra load. Harmless while failures are rare — but every retry is more work for a system that is already struggling.`
          : '';
  r.status = note || 'Healthy. Responses come back well inside the client timeout and nothing needs retrying.';
  if (note || N.client.status === r.note) N.client.status = note;
  r.note = note;
}

// History samples for the charts (called from Sim._record).
export function recordReliability(sim, push) {
  push('orig', sim.totals.orig);
  push('p50', sim.totals.p50 * 1000);
  push('p99', sim.totals.p99 * 1000);
  push('sloP99', sim.params.sloP99);
}
