import { NODE_INFO, HISTORY, fmtRate, fmtDur, fmtBits, fmtBytes, fmtGB, rawMetric } from './sim.js';
import { loadLevel } from './scene.js';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const pct = (v) => Math.round(v * 100) + '%';

const LEVEL_WORD = { good: 'Healthy', warning: 'Busy', serious: 'Hot', critical: 'Overloaded', down: 'Down' };
const STATUS_VAR = { good: '--good', warning: '--warning', serious: '--serious', critical: '--critical', down: '--down' };

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
};

const TIPS = [
  ['Find the first bottleneck', 'Drag traffic up slowly. Around 2,400 req/s two web servers run out of CPU. Watch a ring turn red.'],
  ['Scale out', 'Add web servers. The bottleneck moves — now the database is the limit.'],
  ['Cascade failure', 'Run near capacity, then click a web server and kill it. The survivors inherit its load and fall like dominoes.'],
  ['Cache stampede', 'At ~4,000 req/s with 4+ servers, kill the cache. All reads hit the database at once.'],
  ['Hidden backlog', 'The job queue and Kafka absorb overload silently. Watch queue depth and consumer lag grow while requests still succeed.'],
  ['Fill the disk', 'Raise the write percentage and watch database storage climb until writes are refused.'],
  ['Small files problem', 'Turn off Iceberg compaction and watch the lake file count climb. A few minutes later Trino queries crawl.'],
  ['Starve ingestion', 'Push dashboard queries past ~100/s. ClickHouse spends its CPU on queries, inserts fall behind and dashboards go stale.'],
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
  constructor(sim, { onSelect, onPause, onReset }) {
    this.sim = sim;
    this.onSelect = onSelect;
    this.selected = null;
    this.charts = [];

    // --- header chart: three series on one req/s axis
    const series = [
      { key: 'in', label: 'Incoming', color: '#3987e5', dash: [4, 3] },
      { key: 'ok', label: 'Served', color: '#199e70' },
      { key: 'err', label: 'Errors', color: '#e66767' },
    ];
    this.mainChart = new Chart($('main-chart'), { series, fmt: (v) => fmtRate(v) + ' req/s' });
    $('main-legend').innerHTML =
      '<span>Last 60 s · req/s</span>' + series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}<b data-k="${s.key}"></b></span>`).join('');
    this.legendVals = [...$('main-legend').querySelectorAll('b')];

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
        p[k] = Math.min(6, Math.max(1, p[k] + +b.dataset.d));
        if (this.selected && !sim.nodes[this.selected].active) this.onSelect(null);
        this.syncControls();
      });
    $('queries').addEventListener('input', (e) => {
      p.queryRate = +e.target.value;
      this.syncControls();
    });
    for (const k of ['cacheEnabled', 'autoRestart', 'compaction']) $(k).addEventListener('change', (e) => (p[k] = e.target.checked));
    $('spike').addEventListener('click', () => sim.triggerSpike());
    $('pause').addEventListener('click', () => ($('pause').textContent = onPause() ? 'Resume' : 'Pause'));
    $('reset').addEventListener('click', () => {
      onReset();
      $('log').innerHTML = '';
      this.syncControls();
    });
    this.syncControls = () => {
      traffic.value = fromTraffic(p.traffic);
      $('v-traffic').textContent = p.traffic.toLocaleString();
      $('write').value = p.writePct;
      $('v-write').textContent = p.writePct + '%';
      $('v-webCount').textContent = p.webCount;
      $('v-workerCount').textContent = p.workerCount;
      $('cacheEnabled').checked = p.cacheEnabled;
      $('autoRestart').checked = p.autoRestart;
      $('compaction').checked = p.compaction;
      $('queries').value = p.queryRate;
      $('v-queries').textContent = p.queryRate;
    };
    this.syncControls();

    $('banner').addEventListener('click', () => sim.bottleneck && this.onSelect(sim.bottleneck.id));
    addEventListener('keydown', (e) => e.key === 'Escape' && this.onSelect(null));

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

  // Build the right-hand panel for a node (or the intro when nothing is selected).
  select(id) {
    this.selected = id;
    const el = $('detail');
    this.charts = [];
    if (!id) {
      el.innerHTML =
        `<h2>How to use</h2><p class="d-about">Each dot is a slice of live traffic. <b>Click any component</b> to zoom inside and see its CPU, memory, storage and network. Drag to orbit, scroll to zoom.</p>` +
        `<h2>Experiments to try</h2><ol class="tips">${TIPS.map(([t, d]) => `<li><b>${t}.</b> ${d}</li>`).join('')}</ol>`;
      return;
    }
    const node = this.sim.nodes[id];
    const info = NODE_INFO[node.type];
    el.innerHTML = `
      <button id="d-back">← Overview</button>
      <div class="d-head" style="margin-top:10px">
        <div><h3>${node.label}</h3><div class="d-kind">${info.kind}</div></div>
        <span class="badge" id="d-badge"></span>
      </div>
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
        </div>`
      ).join('')}
      <h2>Live metrics</h2>
      <dl class="stats" id="d-stats"></dl>
      <div class="btns" id="d-actions"></div>
      <h2>What it does</h2>
      <p class="d-about">${info.about}</p>`;
    $('d-back').addEventListener('click', () => this.onSelect(null));
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
      if (node.type === 'db') {
        const add = document.createElement('button');
        add.textContent = 'Add storage';
        add.addEventListener('click', () => this.sim.freeDisk());
        act.append(add);
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
        return [['Requests in', `${fmtRate(n.inRate)} of 50.0k req/s`], ['Healthy backends', `${this.sim.webs.filter((w) => w.active && !w.down).length} of ${p.webCount}`], ['Rejected (503)', r(n.dropRate)]];
      case 'web':
        return [['Arriving', r(n.inRate)], ['Served', `${fmtRate(n.outRate)} of ${fmtRate(n.cap || 0)} req/s max`], ['Threads busy', `${Math.round(n.threads * 256)} of 256`], ['Waiting in memory', `${fmtRate(n.queue)} requests`], ['Response time', fmtDur(n.latency)], ['Rejected (503)', r(n.dropRate)], ['Crash risk', pct(n.stress)], ['Crashes so far', n.crashes]];
      case 'cache':
        return [['Lookups', `${fmtRate(n.inRate)} of 30.0k ops/s`], ['Hit ratio', pct(n.hitRatio * n.warm)], ['Hits (served from RAM)', r(n.outRate, 'ops/s')], ['Misses → database', r(n.missRate, 'ops/s')], ['Warmth', pct(n.warm)]];
      case 'db':
        return [['Reads', r(n.readRate, 'qps')], ['Writes (4× cost)', r(n.writeRate, 'qps')], ['Query load', `${fmtRate(n.load || 0)} of 4.00k units/s`], ['Query latency', fmtDur(n.latency)], ['Connections open', `${Math.round(n.conns * 500)} of 500`], ['Failed queries', r(n.dropRate, 'qps')], ['Crash risk', pct(n.stress)]];
      case 'kafka':
        return [['Produced', `${fmtRate(n.inRate)} of 25.0k msg/s`], ['Consumed (2 groups)', r(n.outRate, 'msg/s')], ['Lag: lake writer', `${fmtRate(n.lag)} of 150k retained`], ['Lag: ClickHouse', `${fmtRate(n.lagCH)} of 150k retained`], ['Lag per partition', n.partitions.map((v) => fmtRate(v)).join(' · ')], ['Expired unread', r(n.expiredRate, 'msg/s')]];
      case 'consumer':
        return [['Consuming', `${fmtRate(n.outRate)} of 3.00k msg/s`], ['Behind by', `${fmtRate(this.sim.nodes.kafka.lag)} msgs`], ['Parquet written', fmtBytes(this.sim.nodes.lake.ingestBytes)], ['Iceberg commits', '1 per second']];
      case 'queue':
        return [['Enqueued', r(n.inRate, 'jobs/s')], ['Dequeued', r(n.outRate, 'jobs/s')], ['Depth', `${fmtRate(n.queue)} of 20.0k`], ['Wait for a new job', fmtDur(n.latency || 0)], ['Rejected', r(n.dropRate, 'jobs/s')]];
      case 'lake':
        return [['Data stored', fmtGB(n.storedGB)], ['Parquet files', n.files.toLocaleString()], ['Small files awaiting compaction', Math.round(n.smallFiles).toLocaleString()], ['Ingest (compressed)', fmtBytes(n.ingestBytes)], ['Compression vs raw JSON', '6×'], ['S3 PUT requests', `${n.putRate.toFixed(1)} /s`], ['S3 GET requests', `${fmtRate(n.getRate)} /s`], ['Iceberg snapshots', Math.round(n.snapshots).toLocaleString()], ['Compaction', p.compaction ? 'on' : 'off']];
      case 'clickhouse':
        return [['Inserting', `${fmtRate(n.insertRate)} of ${fmtRate(n.insertCap || 0)} rows/s max`], ['Ingestion lag', `${fmtRate(this.sim.nodes.kafka.lagCH)} rows`], ['Queries', `${n.outRate.toFixed(1)} of ${Math.round(n.qCap || 0)} /s`], ['Query latency', fmtDur(n.latency)], ['Queries waiting', `${Math.round(n.queue)} of 150`], ['Active parts', `${Math.round(n.parts)} of 300`], ['Rejected queries', `${n.dropRate.toFixed(1)} /s`], ['Crash risk', pct(n.stress)]];
      case 'trino':
        return [['Queries', `${n.outRate.toFixed(1)} of ${(n.cap || 0).toFixed(1)} /s`], ['CPU per query', `${n.cost.toFixed(1)} core-seconds`], ['Query latency', n.latency ? fmtDur(n.latency) : '—'], ['Queries waiting', `${Math.round(n.queue)} of 40`], ['Files opened per query', Math.round(24 + this.sim.nodes.lake.smallFiles * 0.2)], ['Rejected queries', `${n.dropRate.toFixed(1)} /s`], ['Crash risk', pct(n.stress)]];
      case 'bi':
        return [['Queries sent', `${n.outRate.toFixed(1)} /s`], ['Real-time (ClickHouse)', fmtDur(n.chLatency)], ['Ad-hoc (Trino)', fmtDur(n.trLatency)], ['ClickHouse data is behind by', fmtDur(n.freshCH)], ['Lake data is behind by', fmtDur(n.freshLake)], ['Failing queries', `${n.failRate.toFixed(1)} /s`]];
      case 'worker':
        return [['Processing', `${fmtRate(n.outRate)} of ${p.workerCount * 120} jobs/s`], ['Workers', `${p.workerCount} × 120 jobs/s`]];
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
    $('t-lat').textContent = t.ok + t.err < 1 ? '—' : fmtDur(t.latency);
    const vals = { in: t.in, ok: t.ok, err: t.err };
    this.legendVals.forEach((b) => (b.textContent = fmtRate(vals[b.dataset.k])));

    const bn = sim.bottleneck;
    const banner = $('banner');
    banner.hidden = !bn || bn.id === this.selected;
    if (bn) banner.innerHTML = `<b>Bottleneck: ${bn.label}</b> <span>— ${bn.status} Click to inspect.</span>`;

    if (!this.selected) return;
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
    const data = [];
    if (n.type === 'db' || n.type === 'kafka' || n.type === 'clickhouse') data.push(['Disk throughput', fmtBytes(n.diskIO)]);
    $('d-stats').innerHTML = [...this._stats(n), ...data].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const kill = $('d-kill');
    if (kill) {
      kill.textContent = n.down ? 'Restart' : '💥 Kill this node';
      kill.className = n.down ? '' : 'danger';
    }
  }

  drawCharts() {
    this.mainChart.draw(this.sim.history);
    for (const c of this.charts) c.draw(this.sim.history);
  }
}
