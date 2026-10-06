// Job scheduler: makes work happen at a time, instead of in response to a request.
//
// The design from the "job scheduler" interview problem is two-phase. Phase 1: a watcher service
// queries the database every few minutes for executions due in the next window and hands each to
// the queue as a *delayed* message. Phase 2: the queue releases each message at its due time and
// workers run it. The look-ahead is what buys precision (no polling the database every second)
// and resilience: if the watcher dies, the jobs it already handed over still fire on time.
// A cron box has no look-ahead: it reads what is due right now, so the moment it stops, jobs are missed.

export const SCHED_DEFAULTS = { schedRate: 200 }; // executions falling due per second
const READ_COST = 0.25; // database read units per execution: one range query returns a page of them
const CATCHUP = 3; // after an outage, overdue jobs are enqueued at up to this multiple of the normal rate
export const SLA_SECS = 2; // a job must start within this long of its scheduled time

const off = (n) => n.down || !n.active;

// → { reads: database read units/s it adds, jobs: jobs/s it releases to the queue }
export function scheduler(sim, dt, queueUp, ease) {
  const { scheduler: s, db, queue } = sim.nodes;
  const E = sim.edges;
  const t = s.tech;
  s.cap = t.cap;
  s.window = t.window;
  if (!s.active) {
    s.aheadJobs = s.missed = s.inRate = s.outRate = s.util = s.cpu = s.mem = s.bps = s.lateRate = 0;
    return { reads: 0, jobs: 0 };
  }
  const due = sim.params.schedRate;
  const canFetch = !s.down && E.has('scheduler>db') && !off(db);
  const canPush = E.has('scheduler>queue') && queueUp;
  // phase 1: read upcoming executions — today's, a bit extra to refill the look-ahead, and anything overdue
  const want = due * (s.aheadJobs < t.window * due ? 1.5 : 1) + (s.missed > 0 ? due * (CATCHUP - 1) : 0);
  let fetched = canFetch ? Math.min(t.cap, want) * dt : 0;
  const reads = (fetched / dt) * READ_COST;
  const lateOut = canPush ? Math.min(s.missed, fetched) : 0; // overdue ones go out at once
  s.missed -= lateOut;
  fetched -= lateOut;
  const dueNow = due * dt;
  s.aheadJobs = Math.min(s.aheadJobs + fetched, t.window * due + dueNow);
  // phase 2: the queue releases what was handed over ahead of time
  const onTime = canPush ? Math.min(dueNow, s.aheadJobs) : 0;
  s.aheadJobs -= onTime;
  s.missed += dueNow - onTime;

  s.inRate = fetched / dt + lateOut / dt;
  s.outRate = ease(s.outRate, (onTime + lateOut) / dt, dt, 0.2);
  s.lateRate = ease(s.lateRate, lateOut / dt, dt, 0.3);
  s.dropRate = 0;
  s.stress = 0;
  s.util = s.down ? 0 : due / t.cap;
  s.cpu = ease(s.cpu, s.down ? 0 : Math.min(1, 0.04 + 0.9 * (s.inRate / t.cap)), dt);
  s.mem = s.down ? 0 : 0.25;
  s.disk = 0.1;
  s.bps = s.down ? 0 : (s.inRate + s.outRate) * 1e3 * 8;
  s.aheadSecs = due > 0 ? s.aheadJobs / due : 0;
  // how late a job starts: stuck waiting to be enqueued, then waiting in the queue for a worker
  s.delay = (due > 0 ? s.missed / due : 0) + (isFinite(queue.latency) ? queue.latency : 60);
  s.latency = s.delay;
  s.status = s.down
    ? s.aheadJobs > dueNow
      ? `Down — but nothing is late yet: the next ${s.aheadSecs.toFixed(0)}s of jobs were already handed to the queue and will fire on time.`
      : `Down, and its look-ahead has run out: ${Math.round(s.missed).toLocaleString()} jobs are overdue and nothing is scheduling them.`
    : !canFetch
      ? 'Cannot reach the database, so it does not know what is due. Jobs already handed to the queue still run; the rest are missed.'
      : !canPush
        ? 'Cannot reach the queue. Due jobs are piling up as overdue.'
        : s.util > 1
          ? `Overloaded: ${Math.round(due).toLocaleString()} jobs fall due each second and it can schedule ${t.cap.toLocaleString()}. The overdue pile only grows.`
          : s.missed > due * 0.5
            ? `Catching up: ${Math.round(s.missed).toLocaleString()} overdue jobs are being enqueued at ${CATCHUP}× the normal rate. They run late, and the burst lands on the workers.`
            : s.delay > SLA_SECS
              ? `Scheduling on time, but jobs start ${s.delay.toFixed(1)}s late because they wait in the queue for a free worker. Add workers.`
              : t.window
                ? `On time. It reads ${s.aheadSecs.toFixed(0)}s ahead and hands jobs to the queue as delayed messages, so each fires within ${SLA_SECS}s of its time.`
                : 'On time — but with no look-ahead: every job depends on this one machine being up at that exact second.';
  return { reads, jobs: (onTime + lateOut) / dt };
}
