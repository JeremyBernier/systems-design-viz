// Event-driven functions (AWS Lambda and its Google Cloud counterpart) as a component of their own.
// Nothing calls a function directly: events do. Here an upload landing in object storage invokes
// one (resize the photo, start a transcode), and it can also be wired to the job queue, where it
// polls for jobs alongside the worker machines.
//
// The unit of capacity is the execution environment: one copy of the code handling one event at a
// time. Concurrency = events/s × seconds each takes. The platform creates environments on demand
// (a cold start), keeps idle ones warm for a while, and refuses work beyond the concurrency limit.

export const UPLOAD_SECS = 0.4; // one uploaded object: fetch it, resize or probe it, write the result back
const BURST = 100; // environments added per second — Lambda scales by 1,000 every 10 s per function
const IDLE_SECS = 30; // an idle environment is kept warm this long (several minutes in real life, compressed)
const COLD_START = 0.35; // seconds to create an environment and load the code before the first event

const off = (n) => n.down || !n.active;
const clamp = (v) => Math.min(1, Math.max(0, v));

// How many queue jobs/s the functions could take this step, after uploads have had their share.
// jobSecs = seconds one job occupies one environment.
export function fnJobCapacity(sim, dt, jobSecs) {
  const { fn, blob, queue } = sim.nodes;
  const E = sim.edges;
  fn._ups = fn._upConc = 0;
  if (off(fn)) return 0;
  // environments that exist or can be created in time
  const avail = Math.min(fn.tech.limit * (fn.tierF || 1), fn.warm + BURST * dt);
  fn._ups = E.has('blob>fn') && !off(blob) ? blob.putRate : 0;
  fn._upConc = Math.min(avail, fn._ups * UPLOAD_SECS);
  return E.has('queue>fn') && !off(queue) ? (avail - fn._upConc) / jobSecs : 0;
}

// Advance the functions one step. fnJobs = queue jobs/s they actually took.
export function functions(sim, dt, fnJobs, jobSecs, ease) {
  const fn = sim.nodes.fn;
  const p = sim.params;
  const limit = (fn.limit = fn.tech.limit * (fn.tierF || 1)); // more than one of them: their limits add up (tier.js)
  fn.stress = 0; // nothing of yours to crash
  fn.disk = 0;
  if (off(fn)) {
    fn.inRate = fn.outRate = fn.dropRate = fn.util = fn.cpu = fn.mem = fn.bps = fn.concurrency = fn.warm = fn.coldPct = fn.upRate = fn.jobRate = 0;
    fn.status = 'Outage. Upload events queue up inside the storage service and are retried for a few hours; nothing here to restart.';
    return;
  }
  const ups = fn._ups;
  const upOk = fn._upConc / UPLOAD_SECS;
  const conc = fn._upConc + fnJobs * jobSecs;
  const inv = upOk + fnJobs;
  const created = Math.max(0, conc - fn.warm); // environments that had to be started this step
  fn.warm = conc > fn.warm ? conc : fn.warm - ((fn.warm - conc) * dt) / IDLE_SECS;
  fn.coldPct = ease(fn.coldPct, inv > 0 ? clamp(created / (inv * dt)) : 0, dt, 0.5);
  fn.concurrency = ease(fn.concurrency, conc, dt, 0.2);
  fn.upRate = ease(fn.upRate, upOk, dt, 0.2);
  fn.jobRate = ease(fn.jobRate, fnJobs, dt, 0.2);
  fn.inRate = ups + fnJobs;
  fn.outRate = fn.upRate + fn.jobRate;
  fn.dropRate = ease(fn.dropRate, Math.max(0, ups - upOk), dt, 0.2);
  fn.util = conc / limit;
  fn.cpu = fn.mem = clamp(fn.util);
  fn.latency = (inv > 0 ? (upOk * UPLOAD_SECS + fnJobs * jobSecs) / inv : UPLOAD_SECS) + fn.coldPct * COLD_START;
  // each upload is read from the bucket and a smaller rendition written back; a job is a few kB
  fn.bps = upOk * p.uploadKB * 1e3 * 8 * 1.1 + fnJobs * 4e3 * 8;
  const wired = sim.edges.has('blob>fn') || sim.edges.has('queue>fn');
  fn.status = !wired
    ? 'No trigger. A function only runs when something invokes it: connect it to object storage or the job queue.'
    : fn.dropRate > 0.5
      ? `Throttled. All ${limit.toLocaleString()} concurrent executions are in use, so new events are refused with 429 and retried later. Raising the limit is a support ticket, not a slider.`
      : fn.coldPct > 0.1
        ? `Scaling out: ${Math.round(fn.coldPct * 100)}% of events hit a cold start and wait ~${COLD_START * 1000} ms for a new environment.`
        : inv < 0.01
          ? 'Idle. No events, no environments, no bill.'
          : `Healthy. ${fn.concurrency.toFixed(1)} executions in flight; idle environments stay warm for the next event.`;
}

export { COLD_START };
