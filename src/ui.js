import { NODE_INFO, HISTORY, fmtRate, fmtDur, fmtBits, fmtBytes, fmtGB, rawMetric } from './sim.js';
import { TECH, logoSVG, chipOf } from './tech.js';
import { PRESETS } from './presets.js';
import { costs, nodeCost, fmtUSD } from './cost.js';
import { loadLevel, APP_VIEW } from './scene.js';
import { initModelUI, pricingHTML, syncPricing } from './modelui.js';
import { initDbGuide } from './dbguide.js';
import { initNumbers } from './numbers.js';
import { initCompareUI, tradeHTML } from './compareui.js';
import { initBuildUI } from './buildui.js';
import { initConceptsUI } from './conceptsui.js';
import { initKafkaUI } from './kafkaui.js';
import { initFlinkUI } from './flinkui.js';
import { initDesignsUI } from './designsui.js';
import { DATA_STEP, MAX_REPLICAS, SHARD_STEPS, MAX_CACHE_NODES, CACHE_NODE_CAP } from './datatier.js';
import { fmtTTL } from './cdn.js';
import { RETRY_POLICIES, SLO_TARGETS } from './latency.js';
import { PATTERNS, DAY, trafficInfo, autoInfo, costAverage } from './autoscale.js';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const pct = (v) => Math.round(v * 100) + '%';

const LEVEL_WORD = { good: 'Healthy', warning: 'Busy', serious: 'Hot', critical: 'Overloaded', down: 'Down' };
const STATUS_VAR = { good: '--good', warning: '--warning', serious: '--serious', critical: '--critical', down: '--down' };

// The processor under the CPU meter: its name and clock speed, and what a vCPU is on it.
function chipNote(node) {
  if (!node.tech || node.tech.serverless) return '';
  const chip = chipOf(node.tech);
  if (!chip) return '<div class="m-note">Processor: not published for this service, so no clock speed is shown.</div>';
  return `<div class="m-note">${chip.name} · ${chip.ghz} (${chip.what}). ${chip.smt ? 'A vCPU here is one hyperthread: two vCPUs share a physical core.' : 'A vCPU here is a whole physical core.'}</div>`;
}

const RESOURCES = [
  ['cpu', 'CPU'],
  ['mem', 'Memory'],
  ['disk', 'Storage'],
  ['net', 'Network'],
];
const NOTES = {
  'web.cpu': 'Running application code',
  'web.mem': 'Requests waiting for a thread are held in RAM',
  'db.cpu': 'Executing queries',
  'db.mem': 'Buffer pool + one chunk per open connection',
  'db.disk': 'Grows with every write and never shrinks on its own',
  'cache.mem': 'Cached query results',
  'kafka.disk': 'Unread events retained in the log',
  'queue.mem': 'Jobs waiting for a worker',
  'lb.net': 'Every request and response passes through here',
  'lake.disk': 'Object storage grows without limit; you pay per GB',
  'lake.net': 'Parquet uploads from the writer + scans by Trino',
  'clickhouse.cpu': 'Shared by queries, inserts and background merges',
  'clickhouse.disk': 'Columnar, ~8× compressed',
  'trino.net': 'Parquet data pulled from S3 for each query',
  'trino.cpu': 'Decoding Parquet and running joins / aggregations',
  'web.net': 'API responses, plus every image and video when there is no CDN',
  'cdn.disk': 'Objects cached at the edge right now',
  'cdn.net': 'Delivered to users from the edge + cache misses pulled from the origin',
  'blob.disk': 'Grows with every upload; you pay per GB-month',
  'blob.net': 'CDN cache misses and uploads (or every asset read when there is no CDN)',
  'fn.cpu': 'Share of the concurrency limit in use',
  'connector.cpu': 'Decoding events and building batches',
  'scheduler.cpu': 'Querying for due jobs and enqueuing them',
  'connector.mem': 'Rows buffered between flushes',
  'fn.net': 'Objects read from the bucket and results written back',
};

const TIPS = [
  ['Find the first bottleneck', 'Drag traffic up slowly. Around 2,400 req/s two web servers run out of CPU. Watch a ring turn red.'],
  ['Scale out', 'Add web servers. The bottleneck moves — now the database is the limit.'],
  ['Cascade failure', 'Run near capacity, then click a web server and kill it. The survivors inherit its load and fall like dominoes.'],
  ['Cache stampede', 'At ~4,000 req/s with 4+ servers, kill the cache. All reads hit the database at once.'],
  ['Flash crowd vs. boot time', 'At ~1,000 req/s, turn on web autoscaling and pick the flash crowd pattern. On EC2 the autoscaler reacts within seconds, but the new servers are still launching while the old ones drown and crash. Switch the web tier to Lambda and the same crowd is absorbed, at the price of cold starts.'],
  ['Pay for the peak, or follow it', 'Set ~4,000 req/s with the daily cycle and 6 web servers, and note the average cost in the breakdown. Then turn on autoscaling (min 2, max 6) and watch a day go by: the fleet follows the curve, a step behind, and the average drops.'],
  ['Hidden backlog', 'The job queue and Kafka absorb overload silently. Watch queue depth and consumer lag grow while requests still succeed.'],
  ['Fill the disk', 'Raise the write percentage and watch database storage climb until writes are refused.'],
  ['Build it yourself', 'Remove the cache, place it again from Build, then use Connect to wire web servers to it. An unwired component does nothing.'],
  ['Swap the technology', 'Click any component and change its technology. DynamoDB throttles instead of crashing; Lambda cannot be knocked over but costs more at high traffic; Firehose ends the small-files problem. Watch latency, freshness and cost.'],
  ['Small files problem', 'Turn off Iceberg compaction and watch the lake file count climb. A few minutes later Trino queries crawl.'],
  ['Starve ingestion', 'Push dashboard queries past ~100/s. ClickHouse spends its CPU on queries, inserts fall behind and dashboards go stale.'],
  ['Replicas are for reads', 'Remove the cache, set writes to 2% and run 6 web servers at 6,000 req/s: the database drowns in reads. Add 2 read replicas and it recovers. Now raise writes to 40%: every write still goes through the one primary, replicas stop helping and fall behind. Only shards raise the write ceiling — and 4 shards give about 3×, not 4×.'],
  ['Failover, and losing one node of many', 'Give the database a read replica and kill it: writes fail for about 30 s while the replica is promoted, but reads keep flowing. Compare with no replica. Then give the cache 3 nodes and kill it: one node dies and only a third of the keys go cold.'],
  ['Kill the scheduler', 'Pick the Job Scheduler system and kill the Scheduler. For ten seconds nothing is late: those jobs were already handed to the queue as delayed messages. Then the overdue count climbs, and on restart the backlog lands on the workers at 3× the normal rate. Switch its technology to Cron on one VM and kill it again: jobs are missed at once, and it cannot keep up with the load at all.'],
  ['Functions on the queue', 'Click Connect components, then the job queue and the functions component. Lambda now polls the queue next to the worker machines: a backlog that took minutes to drain is gone in seconds, with no machines to add — and a per-invocation line appears on the bill. Zoom into it to watch environments cold-start, stay warm, then get reclaimed.'],
  ['Remove the CDN', 'Pick the Instagram or YouTube system, click the CDN and remove it. Every photo and video now squeezes through the load balancer and the web servers: their network links fill up while the CPU sits idle, most asset requests fail, and "Data transfer out" takes the CDN\'s place on the bill.'],
  ['Cold edge', 'Kill the CDN and let it restart, or drag the CDN cache TTL down to a few seconds. Misses pour into object storage until the edge is warm again; switch the CDN to Cloudflare or Fastly and each of those bytes is also billed as origin egress.'],
  ['Retry storm', 'At ~800 req/s set client retries to Naive and hit Traffic spike. Offered load jumps to 4× the real traffic and stays there after the spike has passed, until the servers run out of memory. Repeat with Backoff + budget: the same spike is over in seconds.'],
  ['A failure that never heals', 'Switch the web servers to AWS Lambda (it sheds load instead of crashing), set ~2,500 req/s, a 0.5 s client timeout and Naive retries, then spike. Nothing is broken and the spike is long gone, yet every request fails — until you change the retry policy or cut traffic.'],
  ['Chase the tail', 'Raise traffic toward the web tier’s limit and watch p99 pull away from p50 before any request fails. Then tighten the p99 target and see the latency SLO break while the average still looks fine.'],
];

// ---------------------------------------------------------------- charts
// One small line-chart renderer with a hover crosshair, used for the header
// chart and the per-resource sparklines. Always a single y-axis.
class Chart {
  constructor(canvas, { series, max, fmt, step = 0.25 }) {
    Object.assign(this, { canvas, series, max, fmt, step });
    this.hover = null;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hover = { f: (e.clientX - r.left) / r.width, x: e.clientX, y: r.bottom };
    });
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      $('tooltip').hidden = true;
    });
  }

  draw(history) {
    const c = this.canvas;
    const dpr = Math.min(devicePixelRatio, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const data = this.series.map((s) => history[s.key] || []);
    const top = this.max || Math.max(10, ...data.map((d) => Math.max(...d, 0))) * 1.15;
    const X = (i) => (i / (HISTORY - 1)) * (w - 2) + 1;
    const Y = (v) => h - 2 - (Math.min(v, top) / top) * (h - 5);

    g.strokeStyle = css('--axis');
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, h - 0.5);
    g.lineTo(w, h - 0.5);
    g.stroke();

    this.series.forEach((s, k) => {
      const d = data[k];
      const off = HISTORY - d.length;
      g.strokeStyle = s.color;
      g.lineWidth = 2;
      g.lineJoin = 'round';
      g.setLineDash(s.dash || []);
      g.beginPath();
      d.forEach((v, i) => (i ? g.lineTo(X(i + off), Y(v)) : g.moveTo(X(i + off), Y(v))));
      g.stroke();
    });
    g.setLineDash([]);

    if (this.hover) {
      const idx = Math.round(this.hover.f * (HISTORY - 1));
      const len = data[0].length;
      const di = idx - (HISTORY - len);
      if (di >= 0 && di < len) {
        g.strokeStyle = css('--muted');
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(X(idx), 0);
        g.lineTo(X(idx), h);
        g.stroke();
        this.series.forEach((s, k) => {
          g.fillStyle = s.color;
          g.strokeStyle = css('--surface');
          g.lineWidth = 2;
          g.beginPath();
          g.arc(X(idx), Y(data[k][di]), 4, 0, 7);
          g.fill();
          g.stroke();
        });
        const tip = $('tooltip');
        const ago = ((len - 1 - di) * this.step).toFixed(0);
        tip.innerHTML =
          `<div>${ago === '0' ? 'now' : ago + 's ago'}</div>` +
          this.series.map((s, k) => `<div><i style="background:${s.color}"></i>${s.label}<b>${this.fmt(data[k][di])}</b></div>`).join('');
        tip.hidden = false;
        tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, this.hover.x + 12) + 'px';
        tip.style.top = this.hover.y + 8 + 'px';
      }
    }
  }
}

// ---------------------------------------------------------------- UI
export class UI {
  constructor(sim, { onSelect, onPause, onReset, onStartPlace, onConnectMode, onPreset, onView, onZoom }) {
    this.onZoom = onZoom;
    this.zoomed = false;
    this.onView = onView;
    this.view = 'app'; // zoomed-in view: the application's internals where there is one, else the hardware
    this.onStartPlace = onStartPlace;
    this.onConnectMode = onConnectMode;
    this.mode = null; // null | 'place' | 'connect'
    this.sim = sim;
    this.onSelect = onSelect;
    this.selected = null;
    this.charts = [];

    // --- header chart: three series on one req/s axis
    const series = [
      { key: 'in', label: 'Incoming', color: '#3987e5', dash: [4, 3] },
      { key: 'ok', label: 'Served', color: '#199e70' },
      { key: 'err', label: 'Errors', color: '#e66767' },
      { key: 'orig', label: 'Without retries', color: '#9085e9', dash: [2, 3] },
    ];
    this.mainChart = new Chart($('main-chart'), { series, fmt: (v) => fmtRate(v) + ' req/s' });
    $('main-legend').innerHTML =
      '<span>Last 60 s · req/s</span>' + series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}<b data-k="${s.key}"></b></span>`).join('');
    this.legendVals = [...$('main-legend').querySelectorAll('b')];
    this._bindDelivery();

    // --- controls. Traffic slider is logarithmic: 20 → 20,000 req/s
    const p = sim.params;
    const toTraffic = (x) => Math.round(20 * Math.pow(1000, x / 1000));
    const fromTraffic = (t) => Math.round((Math.log(t / 20) / Math.log(1000)) * 1000);
    const traffic = $('traffic');
    traffic.addEventListener('input', () => {
      p.traffic = toTraffic(+traffic.value);
      this.syncControls();
    });
    $('write').addEventListener('input', (e) => {
      p.writePct = +e.target.value;
      this.syncControls();
    });
    for (const b of document.querySelectorAll('[data-step]'))
      b.addEventListener('click', () => {
        const k = b.dataset.step;
        if (k === 'web') +b.dataset.d > 0 ? sim.addWeb() : sim.removeWeb();
        else if (DATA_STEP[k]) p[k] = DATA_STEP[k](p[k], +b.dataset.d); // replicas, shards, cache nodes
        else p[k] = Math.min(6, Math.max(1, p[k] + +b.dataset.d));
        if (this.selected && !sim.nodes[this.selected].active) this.onSelect(null);
        this.syncControls();
      });
    $('queries').addEventListener('input', (e) => {
      p.queryRate = +e.target.value;
      this.syncControls();
    });
    for (const k of ['autoRestart', 'compaction']) $(k).addEventListener('change', (e) => (p[k] = e.target.checked));
    const preset = $('preset');
    preset.innerHTML = Object.entries(PRESETS).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
    this.setPreset = (key) => {
      const pr = PRESETS[key];
      preset.value = key;
      $('preset-blurb').innerHTML = pr.blurb + (pr.missing ? `<br><br>${pr.missing}` : '');
    };
    preset.addEventListener('change', () => {
      onPreset(PRESETS[preset.value]);
      this.setPreset(preset.value);
      $('log').innerHTML = '';
      this.syncControls();
    });
    this.setPreset('reference');
    $('spike').addEventListener('click', () => sim.triggerSpike());
    // --- traffic pattern + autoscaling (autoscale.js)
    $('pattern').innerHTML = Object.entries(PATTERNS).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
    $('pattern').addEventListener('change', (e) => {
      p.pattern = e.target.value;
      this.syncControls();
    });
    for (const k of ['autoscale', 'workerAuto'])
      $(k).addEventListener('change', (e) => {
        p[k] = e.target.checked;
        this.syncControls();
      });
    for (const b of document.querySelectorAll('[data-as]'))
      b.addEventListener('click', () => {
        const d = +b.dataset.d;
        // min ≤ max ≤ the number of servers the diagram has room for
        if (b.dataset.as === 'asMin') p.asMin = Math.min(p.asMax, Math.max(1, p.asMin + d));
        else p.asMax = Math.min(sim.webs.length, Math.max(p.asMin, p.asMax + d));
        this.syncControls();
      });
    $('asTarget').addEventListener('input', (e) => {
      p.asTarget = +e.target.value;
      this.syncControls();
    });
    // --- end traffic pattern + autoscaling
    $('pause').addEventListener('click', () => ($('pause').textContent = onPause() ? 'Resume' : 'Pause'));
    $('reset').addEventListener('click', () => {
      onReset();
      this.setPreset('reference');
      $('log').innerHTML = '';
      this.syncControls();
    });
    this.syncControls = () => {
      traffic.value = fromTraffic(p.traffic);
      $('v-traffic').textContent = p.traffic.toLocaleString();
      this._syncAuto(); // traffic pattern + autoscaling controls
      $('write').value = p.writePct;
      $('v-write').textContent = p.writePct + '%';
      $('v-webCount').textContent = sim.webCount;
      $('v-workerCount').textContent = p.workerCount;
      $('autoRestart').checked = p.autoRestart;
      $('compaction').checked = p.compaction;
      $('queries').value = p.queryRate;
      $('v-queries').textContent = p.queryRate;
      this._syncDataTier();
    };
    this.syncControls();
    // --- model your own system: workload assumptions, pricing model, capacity planner (modelui.js)
    initModelUI(this, sim);
    initDbGuide(this, sim);
    initNumbers(sim); // the Numbers dialog in the Learn row (numbers.js); its quiz is quiz.html
    initConceptsUI(); // the Core concepts guide in the Learn row (conceptsui.js)
    initDesignsUI(); // worked system designs in the Learn row (designsui.js)
    initFlinkUI(); // the Flink deep dive in the Learn row (flinkui.js)
    initKafkaUI(); // the Kafka deep dive: Learn row, and the event stream's detail panel (kafkaui.js)
    initBuildUI(this, sim); // the Build button, component picker and placing hint (buildui.js)
    initCompareUI(this, sim); // trade-offs and the side-by-side technology comparison (compareui.js)

    $('detail').addEventListener('click', (e) => {
      const row = e.target.closest('.cost-row[data-id]');
      if (row) this.onSelect(row.dataset.id);
    });
    $('banner').addEventListener('click', () => sim.bottleneck && this.onSelect(sim.bottleneck.id));
    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.mode) this.setMode(null);
      else if (this.zoomed) this.onZoom(false); // first Esc zooms out, the next deselects
      else this.onSelect(null);
    });
    $('connect').addEventListener('click', () => this.setMode(this.mode === 'connect' ? null : 'connect'));
    this.setMode(null);
    this._initReliability();

    sim.on('log', (kind, msg) => {
      const li = document.createElement('li');
      li.dataset.k = kind;
      const m = Math.floor(sim.time / 60);
      const s = String(Math.floor(sim.time % 60)).padStart(2, '0');
      li.innerHTML = `<time>${m}:${s}</time>`;
      li.append(msg);
      $('log').prepend(li);
      while ($('log').children.length > 30) $('log').lastChild.remove();
    });

    this.select(null);
  }

  // ---- data tier (datatier.js): replica / shard / cache-node steppers
  // Engines that partition and replicate on their own get the steppers greyed out, with a line saying why.
  _syncDataTier() {
    const p = this.sim.params;
    const eng = this.sim.techOf('db');
    const sig = [eng.name, p.dbReplicas, p.dbShards, p.cacheNodes].join();
    if (sig === this._dataSig) return;
    this._dataSig = sig;
    $('v-dbReplicas').textContent = eng.repl ? p.dbReplicas : '—';
    $('v-dbShards').textContent = eng.shard ? p.dbShards : '—';
    $('v-cacheNodes').textContent = p.cacheNodes;
    const limits = { dbReplicas: [eng.repl ? 0 : Infinity, MAX_REPLICAS], dbShards: [eng.shard ? SHARD_STEPS[0] : Infinity, SHARD_STEPS[SHARD_STEPS.length - 1]], cacheNodes: [1, MAX_CACHE_NODES] };
    for (const b of document.querySelectorAll('[data-step]')) {
      const lim = limits[b.dataset.step];
      if (lim) b.disabled = lim[0] === Infinity || (+b.dataset.d < 0 ? p[b.dataset.step] <= lim[0] : p[b.dataset.step] >= lim[1]);
    }
    const hint = $('data-hint');
    hint.hidden = !!eng.repl;
    hint.textContent = `${eng.name} partitions and replicates data across its own nodes, so there are no replicas or shards for you to manage.`;
  }

  // Rows added to the live metrics of the database and the cache.
  _tierStats(n) {
    const sim = this.sim;
    if (n.type === 'cache') {
      const rows = [['Cache nodes', `${n.nodesUp} of ${n.nodes} up · ${fmtRate(CACHE_NODE_CAP)} ops/s and ${fmtGB((n.spec || { ramGB: 32 }).ramGB)} each`]];
      if (n.nodes > 1) rows.push(['Keys that go cold if a node dies', pct(1 / n.nodesUp)]);
      return rows;
    }
    const eng = n.tech;
    if (!eng.repl) return [['Replicas and shards', `built in — ${eng.name} spreads data over its own nodes`]];
    const S = n.shards;
    const R = n.replicas;
    const each = S > 1 ? ' per shard' : '';
    const rows = [
      ['Read replicas', R ? `${n.replicasUp} of ${R} up${each}` : 'none'],
      ['Replication lag', R ? (n.failover > 0 ? 'paused during failover' : `${fmtDur(n.replLag)} behind the primary`) : '—'],
      ['Shards', S > 1 ? `${S} · busiest takes ${pct(n.hotShare)} of the load` : '1 (not sharded)'],
    ];
    if (S > 1) rows.push(['Busiest shard load', `${fmtRate(Math.min(n.shardLoad, n.shardCap))} of ${fmtRate(n.shardCap)} units/s`]);
    rows.push([
      'Failover',
      n.failover > 0
        ? `promoting a replica · ${Math.ceil(n.failover)}s to go`
        : n.lostNodes
          ? 'done · old primary is being rebuilt as a replica'
          : R
            ? `ready · about ${eng.repl.failover}s to promote a replica`
            : `no replica to promote · a crash means a ${n.restartSecs}s restart`,
    ]);
    return rows;
  }

  // Reliability section: client timeout, retry policy, SLO targets and the latency chart.
  _initReliability() {
    const p = this.sim.params;
    const series = [
      { key: 'p50', label: 'p50', color: '#3987e5' },
      { key: 'p99', label: 'p99', color: '#c98500' },
      { key: 'sloP99', label: 'target', color: '#e66767', dash: [4, 3] },
    ];
    this.relChart = new Chart($('rel-chart'), { series, fmt: (v) => fmtDur(v / 1000) });
    $('rel-legend').innerHTML = '<span>Latency</span>' + series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');
    $('retryPolicy').innerHTML = Object.entries(RETRY_POLICIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    $('sloAvail').innerHTML = SLO_TARGETS.map((v) => `<option value="${v}">${v}%</option>`).join('');
    for (const k of ['timeout', 'maxRetries', 'sloP99', 'sloAvail'])
      $(k).addEventListener('input', (e) => {
        p[k] = +e.target.value;
        this.syncControls();
      });
    $('retryPolicy').addEventListener('change', (e) => {
      p.retryPolicy = e.target.value;
      this.syncControls();
    });
    // extend the shared sync rather than editing it
    const sync = this.syncControls;
    this.syncControls = () => {
      sync();
      for (const k of ['timeout', 'maxRetries', 'sloP99', 'sloAvail', 'retryPolicy']) $(k).value = p[k];
      $('v-timeout').textContent = p.timeout + ' s';
      $('v-maxRetries').textContent = p.retryPolicy === 'off' ? '—' : p.maxRetries;
      $('maxRetries').disabled = p.retryPolicy === 'off';
      $('v-sloP99').textContent = fmtDur(p.sloP99 / 1000);
    };
    this.syncControls();
  }

  // Header tiles and the Reliability summary. Called from update().
  _updateReliability() {
    const sim = this.sim;
    const t = sim.totals;
    const r = sim.rel;
    const p = sim.params;
    const live = t.ok + t.err >= 1 && t.p50 > 0;
    // round down: 99.996% must not read as 100%
    const pc = (v, d) => (v > 0.999999 ? '100' : (Math.floor(v * 10 ** (d + 2)) / 10 ** d).toFixed(d)) + '%';
    const burn = (r.burn < 100 ? r.burn.toFixed(1) : Math.round(r.burn).toLocaleString()) + '×';
    $('t-ins').textContent = r.amp > 1.02 ? `req/s · ${r.amp.toFixed(1)}× with retries` : 'req/s';
    $('t-lat').textContent = live ? fmtDur(t.p50) : '—';
    $('t-p99').textContent = live ? `p99 ${fmtDur(t.p99)} · avg ${fmtDur(t.latency)}` : 'p99 —';
    $('tile-lat').classList.toggle('bad', !r.latOk);
    $('t-slo-name').textContent = `SLO ${p.sloAvail}% · 60 s`;
    $('t-slo').textContent = pc(r.avail, 2);
    $('t-budget').textContent = (r.budgetLeft > 0 ? `budget ${Math.round(r.budgetLeft * 100)}% left` : 'error budget spent') + (r.burn >= 1 ? ` · burn ${burn}` : '');
    $('tile-slo').classList.toggle('bad', !r.availOk);
    $('rel-stats').innerHTML = [
      ['Real traffic', `${fmtRate(t.orig)} req/s`],
      ['Offered, with retries', `${fmtRate(t.in)} req/s (${r.amp.toFixed(2)}×)`],
      ['Timed out (work wasted)', `${fmtRate(t.timeouts)} req/s`],
      ['Succeeded, last 60 s', `${pc(r.avail, 2)} of ${p.sloAvail}%`],
      ['Error budget', r.budgetLeft > 0 ? `${Math.round(r.budgetLeft * 100)}% left` : 'spent'],
      ['Burn rate', `${burn} the sustainable pace`],
      [`Faster than ${fmtDur(p.sloP99 / 1000)}, last 60 s`, `${pc(r.fast, 1)} of 99%`],
    ]
      .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
      .join('');
    $('rel-status').textContent = !r.availOk
      ? `${r.status} The availability SLO is broken: more than ${parseFloat((100 - p.sloAvail).toFixed(2))}% of the last minute’s requests failed.`
      : !r.latOk
        ? `${r.status} The latency SLO is broken: more than 1% of responses took longer than ${fmtDur(p.sloP99 / 1000)}, however good the average looks.`
        : r.status;
  }

  // Extra rows for the detail panel's metrics list: percentiles wherever a latency exists.
  _relStats(n) {
    const t = this.sim.totals;
    const rows = [];
    if (n.pct && n.pct.p50 > 0) rows.push(['Latency p50 / p95 / p99', `${fmtDur(n.pct.p50)} / ${fmtDur(n.pct.p95)} / ${fmtDur(n.pct.p99)}`]);
    if (n.type === 'client') rows.push(['Real traffic / offered with retries', `${fmtRate(t.orig)} / ${fmtRate(t.in)} req/s`], ['Timed out', `${fmtRate(t.timeouts)} req/s`]);
    return rows;
  }

  // Build modes: placing a new component, or wiring two together.
  setMode(mode, placingId = null) {
    this.mode = mode;
    this.placingId = mode === 'place' ? placingId : null;
    $('connect').setAttribute('aria-pressed', mode === 'connect');
    $('connect').textContent = mode === 'connect' ? 'Done connecting' : 'Connect components';
    $('build-hint').textContent =
      mode === 'place'
        ? `Move the pointer to where the ${NODE_INFO[this.sim.nodes[placingId].type].title} should go and click to build it. It starts with no connections. Esc cancels.`
        : mode === 'connect'
          ? 'Click one component, then another. Sensible pairs are connected (or disconnected if already wired).'
          : 'Press Build (or B) to add a component. Drag any component to move it; click one to inspect, rewire or remove it.';
    if (this.onMode) this.onMode(); // buildui.js mirrors the mode on its button and pointer hint
    if (mode === 'place') this.onStartPlace(placingId);
    else this.onConnectMode(mode === 'connect');
  }

  // Ask before removing a component (from the trash can beside it, or the panel's Remove button).
  confirmRemove(id) {
    const node = this.sim.nodes[id];
    if (!node || !node.active || node.type === 'client') return;
    let dlg = $('confirm');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'confirm';
      dlg.innerHTML = '<h3></h3><p></p><div class="btns"><button data-no>Cancel</button><button data-yes class="danger">Remove</button></div>';
      document.body.append(dlg);
      dlg.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation()); // Esc cancels the question only
      dlg.addEventListener('click', (e) => {
        if (e.target === dlg || e.target.closest('[data-no]')) return dlg.close();
        if (!e.target.closest('[data-yes]')) return;
        dlg.close();
        const n = this.sim.nodes[dlg.dataset.id];
        if (!n || !n.active) return;
        const name = n.label;
        this.sim.setActive(n.id, false);
        this.onSelect(null);
        this.syncControls();
        this.toast(`${name} removed. Add it again from Build.`);
      });
    }
    const tier = node.type !== 'web' && this.sim.nodes[node.extraOf || node.type].tierN > 1;
    const lastWeb = node.type === 'web' && this.sim.webCount === 1;
    dlg.dataset.id = id;
    dlg.querySelector('h3').textContent = `Remove ${node.label}?`;
    dlg.querySelector('p').textContent = tier
      ? 'The others of its kind keep running and take over its share of the load.'
      : lastWeb
        ? 'It is the only one left: with nothing to run your code, every request will fail. You can add it again from Build.'
        : node.type === 'web'
          ? 'The remaining servers take over its traffic. You can add it again from Build.'
          : 'Its connections go with it, and anything that depended on it will start failing. You can add it again from Build.';
    dlg.showModal();
    dlg.querySelector('[data-no]').focus(); // the safe choice is the default
  }

  toast(msg, kind = 'ok') {
    const t = $('toast');
    t.textContent = msg;
    t.dataset.k = kind;
    t.hidden = false;
    clearTimeout(this._toast);
    this._toast = setTimeout(() => (t.hidden = true), 4200);
  }

  // "Content delivery" controls. Both sliders are logarithmic; their positions are refreshed
  // from the params on every update, so presets and resets need no extra wiring.
  _bindDelivery() {
    const p = this.sim.params;
    const SIZE = [5, 5000]; // kB
    const TTL = [1, 2592000]; // 1 s → 30 days
    const to = ([lo, hi], x) => +(lo * Math.pow(hi / lo, x / 100)).toPrecision(3);
    const from = ([lo, hi], v) => Math.round((Math.log(Math.max(v, lo) / lo) / Math.log(hi / lo)) * 100);
    $('assetKB').addEventListener('input', (e) => (p.assetKB = to(SIZE, +e.target.value)));
    $('cdnTTL').addEventListener('input', (e) => (p.cdnTTL = to(TTL, +e.target.value)));
    this._syncDelivery = () => {
      const { cdn, lb } = this.sim.nodes;
      const A = this.sim.assets;
      const set = (id, v) => +$(id).value !== v && ($(id).value = v);
      set('assetKB', from(SIZE, p.assetKB));
      set('cdnTTL', from(TTL, p.cdnTTL));
      $('v-assetKB').textContent = p.assetKB >= 1000 ? parseFloat((p.assetKB / 1000).toFixed(2)) + ' MB' : p.assetKB + ' kB';
      $('v-cdnTTL').textContent = fmtTTL(p.cdnTTL);
      const all = A.edgeBytes + A.originBytes + (lb._apiBps || 0) / 8; // every byte reaching users
      const failing = A.want > 0 ? A.err / A.want : 0;
      $('delivery-hint').textContent =
        `${fmtRate(A.want)} assets/s, ${p.assetsPerReq} per API request. ` +
        (cdn.active && !cdn.down
          ? `The CDN carries ${pct(all > 0 ? A.edgeBytes / all : 0)} of all bytes; ${pct(cdn.hit)} of asset requests are edge hits.`
          : 'No CDN: every asset goes through the load balancer and web servers.') +
        (failing > 0.005 ? ` ${pct(failing)} of asset requests are failing.` : '');
    };
  }

  // Traffic pattern and autoscaling controls: settings on change…
  _syncAuto() {
    const p = this.sim.params;
    $('pattern').value = p.pattern;
    $('autoscale').checked = p.autoscale;
    $('workerAuto').checked = p.workerAuto;
    $('as-opts').hidden = !p.autoscale;
    $('v-asMin').textContent = p.asMin;
    $('v-asMax').textContent = p.asMax;
    $('asTarget').value = p.asTarget;
    $('v-asTarget').textContent = p.asTarget + '%';
    this._renderAuto();
  }

  // …and what they are doing right now, ~5×/s.
  _renderAuto() {
    const sim = this.sim;
    const p = sim.params;
    const tr = trafficInfo(sim);
    $('v-pattern').textContent = p.pattern === 'steady' ? tr.text : `${tr.text} Now ≈ ${fmtRate(p.traffic * tr.mul)} req/s.`;
    const a = autoInfo(sim);
    $('as-status').textContent = a.web;
    $('wa-status').textContent = a.worker;
    // the autoscaler owns the count while it is on: the steppers just display it
    for (const b of document.querySelectorAll('[data-step="web"]')) b.disabled = a.locked;
    for (const b of document.querySelectorAll('[data-step="workerCount"]')) b.disabled = p.workerAuto;
    $('v-workerCount').textContent = p.workerCount;
  }

  // Cost averaged over the last traffic cycle, shown under the total when traffic or capacity moves.
  _avgCost() {
    const sim = this.sim;
    const p = sim.params;
    const a = (p.pattern !== 'steady' || p.autoscale || p.workerAuto) && costAverage(sim);
    if (!a) return '';
    const span = p.pattern === 'daily' && a.secs >= DAY ? 'the last day' : `the last ${a.secs}s`;
    const fleet = `${a.webAvg.toFixed(1)} web servers (peak ${a.webPeak})` + (a.workerPeak > a.workerAvg ? ` and ${a.workerAvg.toFixed(1)} workers (peak ${a.workerPeak})` : '');
    const note =
      a.saved >= 1
        ? `The fleet averaged ${fleet}. A fixed fleet sized for that peak would cost ${fmtUSD(a.saved)} / month more.`
        : sim.techOf('web').serverless
          ? 'The web tier is billed per request, so its cost follows the traffic curve by itself.'
          : `The fleet stayed at ${fleet}: you pay for the peak around the clock.`;
    return `<div class="cost-row cost-avg" title="Mean of the monthly rate, sampled once a second"><span>Average over ${span}</span><b>${fmtUSD(a.avg)} / month</b></div><p class="hint cost-avg">${note}</p>`;
  }

  // "Scheduled jobs per second": only shown while a scheduler is in the diagram. Log scale, 10 → 10,000.
  _syncSched() {
    const p = this.sim.params;
    const el = $('sched');
    if (!this._schedBound) {
      this._schedBound = true;
      el.addEventListener('input', () => (p.schedRate = Math.round(10 * Math.pow(1000, el.value / 100))));
    }
    $('sched-row').style.display = this.sim.nodes.scheduler.active ? '' : 'none';
    const pos = Math.round((Math.log(Math.max(10, p.schedRate) / 10) / Math.log(1000)) * 100);
    if (document.activeElement !== el && +el.value !== pos) el.value = pos;
    $('v-sched').textContent = Math.round(p.schedRate).toLocaleString();
  }

  _renderConnections() {
    const box = $('d-conns');
    if (!box) return;
    const edges = this.sim.possibleEdges(this.selected).filter((e) => e.other.active);
    const sig = edges.map((e) => e.id + this.sim.edges.has(e.id)).join();
    if (sig === this._connSig) return;
    this._connSig = sig;
    box.innerHTML = edges.length ? '' : '<li class="hint">Nothing in the diagram that it can connect to.</li>';
    for (const e of edges) {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.sim.edges.has(e.id);
      cb.addEventListener('change', () => this.sim.toggleEdge(e.id, cb.checked));
      label.append(cb, `${e.out ? 'sends to' : 'receives from'} ${e.other.label}`);
      li.append(label);
      box.append(li);
    }
  }

  // Build the right-hand panel for a node (or the intro when nothing is selected).
  select(id, zoomed = this.zoomed) {
    this.selected = id;
    this.zoomed = !!id && zoomed;
    const el = $('detail');
    this.charts = [];
    if (!id) {
      this._costSig = null;
      el.innerHTML =
        `<h2>How to use</h2><p class="d-about">Each dot is a slice of live traffic. <b>Click any component</b> to select it and see its live metrics here, then press <b>Zoom in</b> (or double-click it) to look inside: its internals, CPU, memory, storage and network. Drag the floor to orbit, scroll to zoom. Use <b>Build</b> on the left to add components and wire them together.</p>` +
        `<h2>Estimated cost</h2><div id="costs"></div>${pricingHTML()}` +
        `<h2>Experiments to try</h2><ol class="tips">${TIPS.map(([t, d]) => `<li><b>${t}.</b> ${d}</li>`).join('')}</ol>`;
      return;
    }
    const node = this.sim.nodes[id];
    const info = NODE_INFO[node.type];
    el.innerHTML = `
      <div class="btns d-nav"><button id="d-back" title="Deselect (Esc)">✕ Close</button><button id="d-zoom" class="primary">${this.zoomed ? '← Zoom out' : '🔍 Zoom in'}</button></div>
      ${this.zoomed ? '' : `<p class="hint">Zoom in to look inside ${node.label}${APP_VIEW[node.type] ? ': how it works internally, and its hardware' : ': its CPU, memory, storage and network'}. The magnifying glass beside it in the diagram does the same, as does double-clicking it.</p>`}
      <div class="d-head" style="margin-top:10px">
        <div class="d-title">${node.tech ? logoSVG(node.tech.logo, 34) : ''}<div><h3>${node.label}</h3><div class="d-kind">${node.tech && node.tech.name !== node.label ? node.tech.name + ' · ' : ''}${node.kind || info.kind}</div></div></div>
        <span class="badge" id="d-badge"></span>
      </div>
      ${this.zoomed && APP_VIEW[node.type] ? `<div class="seg" id="d-view" role="group" aria-label="Zoomed-in view"><button data-view="app">${APP_VIEW[node.type]} internals</button><button data-view="hw">Hardware</button></div>` : ''}
      ${
        TECH[node.type]
          ? `<label class="engine">Technology<select id="d-engine">${Object.entries(TECH[node.type])
              .map(([k, e]) => `<option value="${k}"${e === node.tech ? ' selected' : ''}>${e.name} — ${e.vendor}</option>`)
              .join('')}</select></label>${node.type === 'web' ? '<p class="hint">Applies to every web server.</p>' : ''}`
          : ''
      }
      ${
        node.tech
          ? `<h2>What is ${node.tech.name}?</h2><p class="d-about">${node.tech.about}</p>${
              node.tech.about !== info.about ? `<h2>Its role here: ${info.title}</h2><p class="d-about">${info.about}</p>` : ''
            }` + (node.type === 'db' || node.type === 'clickhouse' ? `<button id="d-guide" class="wide" data-type="${node.type}">📖 Compare databases and their tradeoffs</button>` : '') + (['kafka', 'consumer', 'connector'].includes(node.type) ? '<button id="d-kafka" class="wide">📨 Kafka deep dive: partitions, offsets, keys</button>' : '')
          : `<h2>What it is</h2><p class="d-about">${info.about}</p>`
      }
      ${tradeHTML(node)}
      <h2>Right now</h2>
      <div class="d-status" id="d-status"></div>
      <h2>Hardware</h2>
      ${RESOURCES.map(
        ([k, name]) => `
        <div class="meter" data-res="${k}">
          <div class="m-top"><span>${name}</span><span><b></b><em></em></span></div>
          <canvas></canvas>
          <div class="m-bar"><i></i></div>
          <div class="m-raw"></div>
          ${NOTES[node.type + '.' + k] ? `<div class="m-note">${NOTES[node.type + '.' + k]}</div>` : ''}
          ${k === 'cpu' ? chipNote(node) : ''}
        </div>`
      ).join('')}
      <h2>Live metrics</h2>
      <dl class="stats" id="d-stats"></dl>
      <p class="hint" id="d-cost"></p>
      <h2>Connections</h2>
      <ul class="conns" id="d-conns"></ul>
      <div class="btns" id="d-actions"></div>
`;
    this._connSig = null;
    if (TECH[node.type])
      $('d-engine').addEventListener('change', (e) => {
        this.sim.setTech(node.type, e.target.value, false, id); // an extra tier member changes alone
        this.select(id);
      });
    $('d-back').addEventListener('click', () => this.onSelect(null));
    $('d-zoom').addEventListener('click', () => this.onZoom(!this.zoomed));
    const seg = $('d-view');
    if (seg) {
      const mark = () => seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === this.view));
      seg.addEventListener('click', (e) => {
        if (!e.target.dataset.view) return;
        this.view = e.target.dataset.view;
        this.onView(this.view);
        mark();
      });
      mark();
    }
    this.meters = RESOURCES.map(([k, name]) => {
      const m = el.querySelector(`[data-res="${k}"]`);
      const chart = new Chart(m.querySelector('canvas'), {
        series: [{ key: `${id}.${k}`, label: name, color: '#3987e5' }],
        max: 100,
        fmt: (v) => Math.round(v) + '%',
      });
      this.charts.push(chart);
      return { k, root: m, val: m.querySelector('b'), word: m.querySelector('em'), bar: m.querySelector('.m-bar i'), raw: m.querySelector('.m-raw') };
    });
    if (node.type !== 'client') {
      const act = $('d-actions');
      const kill = document.createElement('button');
      kill.id = 'd-kill';
      kill.addEventListener('click', () => (node.down ? this.sim.restart(id) : this.sim.kill(id)));
      act.append(kill);
      const rm = document.createElement('button');
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => this.confirmRemove(id));
      act.append(rm);
      if (node.type === 'db') {
        const add = document.createElement('button');
        add.textContent = 'Add storage';
        add.addEventListener('click', () => this.sim.freeDisk());
        act.append(add);
      }
      // data tier: with auto-restart off, a lost cache node or the old primary needs bringing back by hand
      if (node.type === 'db' || node.type === 'cache') {
        const heal = document.createElement('button');
        heal.id = 'd-heal';
        heal.textContent = node.type === 'db' ? 'Rebuild lost replica' : 'Replace lost node';
        heal.addEventListener('click', () => this.sim.heal(id));
        act.append(heal);
      }
    }
    this.update();
  }

  _stats(n) {
    const p = this.sim.params;
    const r = (v, u = 'req/s') => `${fmtRate(v)} ${u}`;
    switch (n.type) {
      case 'client':
        return [['Sending', r(n.outRate)], ['Reads / writes', `${100 - p.writePct}% / ${p.writePct}%`], ['Success rate', pct(1 - this.sim.totals.errPct)], ['Avg response time', fmtDur(this.sim.totals.latency)]];
      case 'lb':
        return [['Requests in', `${fmtRate(n.inRate)} of ${fmtRate(n.cap || 0)} req/s`], ['Healthy backends', `${this.sim.webs.filter((w) => w.active && !w.down).length} of ${this.sim.webCount}`], ['Rejected (503)', r(n.dropRate)]];
      case 'web':
        return [['Arriving', r(n.inRate)], ['Served', `${fmtRate(n.outRate)} of ${fmtRate(n.cap || 0)} req/s max`], ['Threads busy', `${Math.round(n.threads * 256)} of 256`], ['Waiting in memory', `${fmtRate(n.queue)} requests`], ['Response time', fmtDur(n.latency)], ['Rejected (503)', r(n.dropRate)], ['Crash risk', pct(n.stress)], ['Crashes so far', n.crashes]];
      case 'cache':
        return [['Lookups', `${fmtRate(n.inRate)} of ${fmtRate(n.cap || CACHE_NODE_CAP)} ops/s`], ['Hit ratio', pct(n.hitRatio * n.warm)], ['Hits (served from RAM)', r(n.outRate, 'ops/s')], ['Misses → database', r(n.missRate, 'ops/s')], ['Warmth', pct(n.warm)]];
      case 'db':
        return [['Reads', r(n.readRate, 'qps')], [`Writes (${n.writeCost}× the cost of a read)`, r(n.writeRate, 'qps')], ['Query load', `${fmtRate(n.load || 0)} of ${fmtRate(n.capUnits || 0)} units/s`], ['Query latency', fmtDur(n.latency)], ['Connections open', n.maxConns ? `${Math.round(n.conns * n.maxConns)} of ${n.maxConns}` : 'none (stateless API)'], ['Data stored', fmtGB(n.storedGB || 0)], ['Failed queries', r(n.dropRate, 'qps')], ['Crash risk', pct(n.stress)]];
      case 'kafka':
        return [['Produced', `${fmtRate(n.inRate)} of ${fmtRate(n.cap || 0)} msg/s`], ['Consumed (2 groups)', r(n.outRate, 'msg/s')], ['Lag: lake writer', `${fmtRate(n.lag)} of ${fmtRate(n.retention || 0)} retained`], [`Lag: ${this.sim.nodes.clickhouse.label}`, `${fmtRate(n.lagCH)} of ${fmtRate(n.retention || 0)} retained`], ['Lag per partition', n.partitions.map((v) => fmtRate(v)).join(' · ')], ['Expired unread', r(n.expiredRate, 'msg/s')]];
      case 'consumer':
        return [['Reading from Kafka', `${fmtRate(n.outRate)} of ${fmtRate(n.cap || 0)} msg/s`], ['Raw events in', fmtBytes(n.outRate * p.eventBytes)], ['Behind by', `${fmtRate(this.sim.nodes.kafka.lag)} msgs`], ['Parquet out → data lake', fmtBytes(this.sim.nodes.lake.ingestBytes)], ['Small files written', `${this.sim.techOf('consumer').files} per second`]];
      case 'scheduler':
        return [['Jobs falling due', r(p.schedRate, 'jobs/s')], ['Released to the queue', r(n.outRate, 'jobs/s')], ['Capacity', `${fmtRate(n.cap || 0)} jobs/s`], ['Handed to the queue ahead of time', n.window ? `${n.aheadSecs.toFixed(1)}s of ${n.window}s look-ahead` : 'none — no look-ahead'], ['Overdue, not yet enqueued', Math.round(n.missed).toLocaleString()], ['Start delay (target ≤ 2 s)', fmtDur(n.delay)], ['Enqueued late', r(n.lateRate, 'jobs/s')]];
      case 'connector': {
        const wh = this.sim.nodes.clickhouse;
        return [['Loading', `${fmtRate(n.outRate)} of ${fmtRate(n.cap || 0)} rows/s`], ['Sink plugin', wh.tech.connector ? wh.tech.connector.plugin : '—'], ['Destination', wh.label], ['Unread in Kafka', `${fmtRate(this.sim.nodes.kafka.lagCH)} rows`], ['Batch flush interval', fmtDur(n.latency)]];
      }
      case 'fn':
        return [['Invocations', r(n.outRate, '/s')], ['From upload events', `${n.upRate.toFixed(1)} /s`], ['From the job queue', this.sim.edges.has('queue>fn') ? r(n.jobRate, 'jobs/s') : 'not connected'], ['Concurrent executions', `${n.concurrency.toFixed(1)} of ${n.limit.toLocaleString()}`], ['Warm environments', n.warm.toFixed(1)], ['Cold starts', pct(n.coldPct)], ['Average duration', fmtDur(n.latency)], ['Throttled', r(n.dropRate, '/s')]];
      case 'queue':
        return [['Enqueued', r(n.inRate, 'jobs/s')], ['Dequeued', r(n.outRate, 'jobs/s')], ['Jobs in queue', `${Math.round(n.queue).toLocaleString()} of ${(n.qmax || 0).toLocaleString()}`], ['Consumers', n.consumers ? `${n.consumers} processes on ${n.machines} worker machine${n.machines > 1 ? 's' : ''}` : 'none — nothing is draining it'], ['Delivered, not yet acknowledged', (n.inflight || 0).toFixed(1)], ['Wait for a new job', fmtDur(n.latency || 0)], ['Rejected', r(n.dropRate, 'jobs/s')]];
      case 'lake':
        return [['Data stored', fmtGB(n.storedGB)], ['Parquet files', n.files.toLocaleString()], ['Small files awaiting compaction', Math.round(n.smallFiles).toLocaleString()], ['Ingest (compressed)', fmtBytes(n.ingestBytes)], ['Compression vs raw JSON', '6×'], ['S3 PUT requests', `${n.putRate.toFixed(1)} /s`], ['S3 GET requests', `${fmtRate(n.getRate)} /s`], ['Iceberg snapshots', Math.round(n.snapshots).toLocaleString()], ['Compaction', p.compaction ? 'on' : 'off']];
      case 'clickhouse':
        return [['Reads Kafka through', n.tech.connector ? `Kafka Connect · ${n.tech.connector.plugin}` : n.tech.ingest || 'a built-in consumer'], ['Inserting', `${fmtRate(n.insertRate)} of ${fmtRate(n.insertCap || 0)} rows/s max`], ['Ingestion lag', `${fmtRate(this.sim.nodes.kafka.lagCH)} rows`], ['Queries', `${n.outRate.toFixed(1)} of ${Math.round(n.qCap || 0)} /s`], ['Query latency', fmtDur(n.latency)], ['Queries waiting', `${Math.round(n.queue)} of ${n.qmax || 0}`], ['Active parts', n.partsModel ? `${Math.round(n.parts)} of 300` : 'n/a'], ['Data stored', fmtGB(n.storedGB || 0)], ['Rejected queries', `${n.dropRate.toFixed(1)} /s`], ['Crash risk', pct(n.stress)]];
      case 'trino':
        return [['Queries', `${n.outRate.toFixed(1)} of ${(n.cap || 0).toFixed(1)} /s`], ['CPU per query', `${n.cost.toFixed(1)} core-seconds`], ['Query latency', n.latency ? fmtDur(n.latency) : '—'], ['Queries waiting', `${Math.round(n.queue)} of 40`], ['Files opened per query', Math.round(24 + this.sim.nodes.lake.smallFiles * 0.2)], ['Rejected queries', `${n.dropRate.toFixed(1)} /s`], ['Crash risk', pct(n.stress)]];
      case 'bi':
        return [['Queries sent', `${n.outRate.toFixed(1)} /s`], [`Real-time (${this.sim.nodes.clickhouse.tech.name})`, fmtDur(n.chLatency)], ['Ad-hoc (Trino)', fmtDur(n.trLatency)], [`${this.sim.nodes.clickhouse.label} data is behind by`, fmtDur(n.freshCH)], ['Lake data is behind by', fmtDur(n.freshLake)], ['Failing queries', `${n.failRate.toFixed(1)} /s`]];
      case 'cdn': {
        const A = this.sim.assets;
        const all = A.edgeBytes + A.originBytes + (this.sim.nodes.lb._apiBps || 0) / 8;
        return [['Asset requests', r(n.inRate, 'obj/s')], ['Edge hit ratio', `${pct(n.hit)} now · ${pct(n.hitRatio)} when warm`], ['Cache TTL', fmtTTL(p.cdnTTL)], ['Warmth', pct(n.warm)], ['Delivered from the edge', fmtBits(n.edgeBytes * 8)], ['Share of all bytes to users', pct(all > 0 ? A.edgeBytes / all : 0)], ['Misses → object storage', r(n.missRate, 'obj/s')], ['Time to first byte', fmtDur(n.latency)], ['Failed (502)', r(n.dropRate, 'obj/s')]];
      }
      case 'blob': {
        const A = this.sim.assets;
        const count = n.objects >= 1e9 ? (n.objects / 1e9).toFixed(2) + ' billion' : n.objects >= 1e6 ? (n.objects / 1e6).toFixed(1) + ' million' : Math.round(n.objects).toLocaleString();
        return [['Data stored', fmtGB(n.storedGB)], ['Objects', count], ['Average object', p.assetKB >= 1000 ? parseFloat((p.assetKB / 1000).toFixed(2)) + ' MB' : p.assetKB + ' kB'], ['GET requests', `${fmtRate(n.getRate)} /s`], ['PUT requests (uploads)', `${n.putRate.toFixed(1)} /s`], ['Read out', fmtBytes(n.getRate * p.assetKB * 1e3)], ['Uploaded', fmtBytes(A.upBytes)], ['Growth', `${fmtGB((A.upBytes * 86400) / 1e9)} per day`]];
      }
      case 'worker':
        return [['Processing', `${fmtRate(n.outRate)} of ${fmtRate(n.cap || 0)} jobs/s`], ['Workers', `${p.workerCount} × ${Math.round((n.cap || 0) / p.workerCount)} jobs/s`]];
    }
    return [];
  }

  // called ~5×/s
  update() {
    const sim = this.sim;
    const t = sim.totals;
    $('t-in').textContent = fmtRate(t.in);
    $('t-ok').textContent = fmtRate(t.ok);
    $('t-err').textContent = (t.errPct * 100).toFixed(t.errPct > 0 && t.errPct < 0.1 ? 1 : 0) + '%';
    $('t-errs').textContent = fmtRate(t.err) + ' req/s failing';
    $('tile-err').classList.toggle('bad', t.errPct > 0.01);
    $('t-bw').textContent = fmtBits(sim.nodes.lb.bps).replace(' ', '\u2009');
    this._updateReliability();
    const vals = { in: t.in, ok: t.ok, err: t.err, orig: t.orig };
    this.legendVals.forEach((b) => (b.textContent = fmtRate(vals[b.dataset.k])));

    const bn = sim.bottleneck;
    const banner = $('banner');
    banner.hidden = !bn || bn.id === this.selected;
    if (bn) banner.innerHTML = `<b>Bottleneck: ${bn.label}</b> <span>— ${bn.status} Click to inspect.</span>`;

    const cost = costs(sim);
    $('t-cost').textContent = fmtUSD(cost.total);
    $('t-cpm').textContent = cost.perMillion ? `per month · ${fmtUSD(cost.perMillion)} per 1M requests` : 'per month';
    this._syncDelivery();
    this._syncSched();
    this._renderAuto();
    $('v-webCount').textContent = sim.webCount;
    this._syncDataTier(); // the database engine can change from the detail panel

    if (!this.selected) {
      // cost breakdown: sorted bars, one hue
      const box = $('costs');
      const max = cost.items[0] ? cost.items[0].monthly : 1;
      box.innerHTML =
        `<div class="cost-total"><span>Total</span><b>${fmtUSD(cost.total)} / month</b></div>` +
        cost.items
          .filter((i) => i.monthly >= 0.5)
          .map((i) => `<div class="cost-row" ${i.id ? `data-id="${i.id}"` : ''} title="${i.basis}"><span>${i.label}</span><b>${fmtUSD(i.monthly)}</b><i style="width:${(i.monthly / max) * 100}%"></i></div>`)
          .join('');
      syncPricing(sim);
      box.firstChild.insertAdjacentHTML('afterend', this._avgCost()); // average over the traffic cycle (autoscale.js)
      return;
    }
    if (!sim.nodes[this.selected].active) return this.onSelect(null);
    this._renderConnections();
    const n = sim.nodes[this.selected];
    const level = loadLevel(n.util, n.down);
    const badge = $('d-badge');
    badge.dataset.level = level;
    badge.textContent = LEVEL_WORD[level];
    const st = $('d-status');
    st.dataset.level = level;
    st.textContent = n.status || 'Generating traffic.';
    for (const m of this.meters) {
      const v = n[m.k];
      const lv = loadLevel(v, false);
      m.root.dataset.level = lv;
      m.val.textContent = pct(v);
      m.word.textContent = lv === 'good' ? '' : LEVEL_WORD[lv];
      m.raw.textContent = rawMetric(n, m.k, sim.params);
      m.bar.style.width = Math.min(100, v * 100) + '%';
    }
    const c = nodeCost(sim, n);
    $('d-cost').textContent = c.basis;
    const data = [['Estimated cost', `${fmtUSD(c.monthly)} / month`]];
    data.unshift(...this._relStats(n));
    if (n.type === 'db' || n.type === 'kafka' || n.type === 'clickhouse') data.push(['Disk throughput', fmtBytes(n.diskIO)]);
    if (n.type === 'db' || n.type === 'cache') data.unshift(...this._tierStats(n));
    const heal = $('d-heal');
    if (heal) heal.hidden = !n.lostNodes || n.down;
    $('d-stats').innerHTML = [...this._stats(n), ...data].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const kill = $('d-kill');
    if (kill) {
      kill.textContent = n.down ? 'Restart' : '💥 Kill this node';
      kill.className = n.down ? '' : 'danger';
    }
  }

  drawCharts() {
    this.mainChart.draw(this.sim.history);
    this.relChart.draw(this.sim.history);
    for (const c of this.charts) c.draw(this.sim.history);
  }
}
