import { NODE_INFO, HISTORY, fmtRate, fmtDur, fmtBits, fmtBytes, fmtGB, rawMetric } from './sim.js';
import { TECH, logoSVG } from './tech.js';
import { PRESETS } from './presets.js';
import { costs, nodeCost, fmtUSD } from './cost.js';
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
  ['Build it yourself', 'Remove the cache, place it again from Build, then use Connect to wire web servers to it. An unwired component does nothing.'],
  ['Swap the technology', 'Click any component and change its technology. DynamoDB throttles instead of crashing; Lambda cannot be knocked over but costs more at high traffic; Firehose ends the small-files problem. Watch latency, freshness and cost.'],
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
  constructor(sim, { onSelect, onPause, onReset, onStartPlace, onConnectMode, onPreset }) {
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
        if (k === 'web') +b.dataset.d > 0 ? sim.addWeb() : sim.removeWeb();
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
      $('write').value = p.writePct;
      $('v-write').textContent = p.writePct + '%';
      $('v-webCount').textContent = sim.webCount;
      $('v-workerCount').textContent = p.workerCount;
      $('autoRestart').checked = p.autoRestart;
      $('compaction').checked = p.compaction;
      $('queries').value = p.queryRate;
      $('v-queries').textContent = p.queryRate;
    };
    this.syncControls();

    $('detail').addEventListener('click', (e) => {
      const row = e.target.closest('.cost-row[data-id]');
      if (row) this.onSelect(row.dataset.id);
    });
    $('banner').addEventListener('click', () => sim.bottleneck && this.onSelect(sim.bottleneck.id));
    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.mode) this.setMode(null);
      else this.onSelect(null);
    });
    $('connect').addEventListener('click', () => this.setMode(this.mode === 'connect' ? null : 'connect'));
    this.setMode(null);

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

  // Build modes: placing a new component, or wiring two together.
  setMode(mode, placingId = null) {
    this.mode = mode;
    this.placingId = mode === 'place' ? placingId : null;
    $('connect').setAttribute('aria-pressed', mode === 'connect');
    $('connect').textContent = mode === 'connect' ? 'Done connecting' : 'Connect components';
    $('build-hint').textContent =
      mode === 'place'
        ? `Click the floor to place the ${NODE_INFO[this.sim.nodes[placingId].type].title}. It starts with no connections. Esc cancels.`
        : mode === 'connect'
          ? 'Click one component, then another. Sensible pairs are connected (or disconnected if already wired).'
          : 'Drag any component to move it. Click one to inspect, rewire or remove it.';
    for (const b of $('palette').children) b.setAttribute('aria-pressed', b.dataset.id === this.placingId);
    if (mode === 'place') this.onStartPlace(placingId);
    else this.onConnectMode(mode === 'connect');
  }

  toast(msg, kind = 'ok') {
    const t = $('toast');
    t.textContent = msg;
    t.dataset.k = kind;
    t.hidden = false;
    clearTimeout(this._toast);
    this._toast = setTimeout(() => (t.hidden = true), 4200);
  }

  _renderPalette() {
    const items = this.sim.placeable();
    const sig = items.map((n) => n.id).join();
    if (sig === this._paletteSig) return;
    this._paletteSig = sig;
    const pal = $('palette');
    pal.innerHTML = items.length ? '' : '<span class="hint">Every component is in the diagram. Remove one to place it again.</span>';
    for (const n of items) {
      const b = document.createElement('button');
      b.dataset.id = n.id;
      b.textContent = '+ ' + NODE_INFO[n.type].title;
      b.addEventListener('click', () => this.setMode(this.placingId === n.id ? null : 'place', n.id));
      pal.append(b);
    }
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
  select(id) {
    this.selected = id;
    const el = $('detail');
    this.charts = [];
    if (!id) {
      this._costSig = null;
      el.innerHTML =
        `<h2>How to use</h2><p class="d-about">Each dot is a slice of live traffic. <b>Click any component</b> to zoom inside and see its CPU, memory, storage and network. Drag the floor to orbit, scroll to zoom. Use <b>Build</b> on the left to add components and wire them together.</p>` +
        `<h2>Estimated cost</h2><div id="costs"></div><p class="hint">Ballpark from public on-demand list prices (AWS / Google Cloud). No discounts or reserved pricing.</p>` +
        `<h2>Experiments to try</h2><ol class="tips">${TIPS.map(([t, d]) => `<li><b>${t}.</b> ${d}</li>`).join('')}</ol>`;
      return;
    }
    const node = this.sim.nodes[id];
    const info = NODE_INFO[node.type];
    el.innerHTML = `
      <button id="d-back">← Overview</button>
      <div class="d-head" style="margin-top:10px">
        <div class="d-title">${node.tech ? logoSVG(node.tech.logo, 34) : ''}<div><h3>${node.label}</h3><div class="d-kind">${node.tech && node.tech.name !== node.label ? node.tech.name + ' · ' : ''}${node.kind || info.kind}</div></div></div>
        <span class="badge" id="d-badge"></span>
      </div>
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
            }`
          : `<h2>What it is</h2><p class="d-about">${info.about}</p>`
      }
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
        this.sim.setTech(node.type, e.target.value);
        this.select(id);
      });
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
      const rm = document.createElement('button');
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => {
        this.sim.setActive(id, false);
        this.onSelect(null);
        this.syncControls();
      });
      act.append(rm);
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
        return [['Requests in', `${fmtRate(n.inRate)} of ${fmtRate(n.cap || 0)} req/s`], ['Healthy backends', `${this.sim.webs.filter((w) => w.active && !w.down).length} of ${this.sim.webCount}`], ['Rejected (503)', r(n.dropRate)]];
      case 'web':
        return [['Arriving', r(n.inRate)], ['Served', `${fmtRate(n.outRate)} of ${fmtRate(n.cap || 0)} req/s max`], ['Threads busy', `${Math.round(n.threads * 256)} of 256`], ['Waiting in memory', `${fmtRate(n.queue)} requests`], ['Response time', fmtDur(n.latency)], ['Rejected (503)', r(n.dropRate)], ['Crash risk', pct(n.stress)], ['Crashes so far', n.crashes]];
      case 'cache':
        return [['Lookups', `${fmtRate(n.inRate)} of 30.0k ops/s`], ['Hit ratio', pct(n.hitRatio * n.warm)], ['Hits (served from RAM)', r(n.outRate, 'ops/s')], ['Misses → database', r(n.missRate, 'ops/s')], ['Warmth', pct(n.warm)]];
      case 'db':
        return [['Reads', r(n.readRate, 'qps')], [`Writes (${n.writeCost}× the cost of a read)`, r(n.writeRate, 'qps')], ['Query load', `${fmtRate(n.load || 0)} of ${fmtRate(n.capUnits || 0)} units/s`], ['Query latency', fmtDur(n.latency)], ['Connections open', n.maxConns ? `${Math.round(n.conns * n.maxConns)} of ${n.maxConns}` : 'none (stateless API)'], ['Data stored', fmtGB(n.storedGB || 0)], ['Failed queries', r(n.dropRate, 'qps')], ['Crash risk', pct(n.stress)]];
      case 'kafka':
        return [['Produced', `${fmtRate(n.inRate)} of ${fmtRate(n.cap || 0)} msg/s`], ['Consumed (2 groups)', r(n.outRate, 'msg/s')], ['Lag: lake writer', `${fmtRate(n.lag)} of ${fmtRate(n.retention || 0)} retained`], [`Lag: ${this.sim.nodes.clickhouse.label}`, `${fmtRate(n.lagCH)} of ${fmtRate(n.retention || 0)} retained`], ['Lag per partition', n.partitions.map((v) => fmtRate(v)).join(' · ')], ['Expired unread', r(n.expiredRate, 'msg/s')]];
      case 'consumer':
        return [['Reading from Kafka', `${fmtRate(n.outRate)} of ${fmtRate(n.cap || 0)} msg/s`], ['Raw events in', fmtBytes(n.outRate * 2e3)], ['Behind by', `${fmtRate(this.sim.nodes.kafka.lag)} msgs`], ['Parquet out → data lake', fmtBytes(this.sim.nodes.lake.ingestBytes)], ['Small files written', `${this.sim.techOf('consumer').files} per second`]];
      case 'queue':
        return [['Enqueued', r(n.inRate, 'jobs/s')], ['Dequeued', r(n.outRate, 'jobs/s')], ['Jobs in queue', `${Math.round(n.queue).toLocaleString()} of ${(n.qmax || 0).toLocaleString()}`], ['Wait for a new job', fmtDur(n.latency || 0)], ['Rejected', r(n.dropRate, 'jobs/s')]];
      case 'lake':
        return [['Data stored', fmtGB(n.storedGB)], ['Parquet files', n.files.toLocaleString()], ['Small files awaiting compaction', Math.round(n.smallFiles).toLocaleString()], ['Ingest (compressed)', fmtBytes(n.ingestBytes)], ['Compression vs raw JSON', '6×'], ['S3 PUT requests', `${n.putRate.toFixed(1)} /s`], ['S3 GET requests', `${fmtRate(n.getRate)} /s`], ['Iceberg snapshots', Math.round(n.snapshots).toLocaleString()], ['Compaction', p.compaction ? 'on' : 'off']];
      case 'clickhouse':
        return [['Inserting', `${fmtRate(n.insertRate)} of ${fmtRate(n.insertCap || 0)} rows/s max`], ['Ingestion lag', `${fmtRate(this.sim.nodes.kafka.lagCH)} rows`], ['Queries', `${n.outRate.toFixed(1)} of ${Math.round(n.qCap || 0)} /s`], ['Query latency', fmtDur(n.latency)], ['Queries waiting', `${Math.round(n.queue)} of ${n.qmax || 0}`], ['Active parts', n.partsModel ? `${Math.round(n.parts)} of 300` : 'n/a'], ['Data stored', fmtGB(n.storedGB || 0)], ['Rejected queries', `${n.dropRate.toFixed(1)} /s`], ['Crash risk', pct(n.stress)]];
      case 'trino':
        return [['Queries', `${n.outRate.toFixed(1)} of ${(n.cap || 0).toFixed(1)} /s`], ['CPU per query', `${n.cost.toFixed(1)} core-seconds`], ['Query latency', n.latency ? fmtDur(n.latency) : '—'], ['Queries waiting', `${Math.round(n.queue)} of 40`], ['Files opened per query', Math.round(24 + this.sim.nodes.lake.smallFiles * 0.2)], ['Rejected queries', `${n.dropRate.toFixed(1)} /s`], ['Crash risk', pct(n.stress)]];
      case 'bi':
        return [['Queries sent', `${n.outRate.toFixed(1)} /s`], [`Real-time (${this.sim.nodes.clickhouse.label})`, fmtDur(n.chLatency)], ['Ad-hoc (Trino)', fmtDur(n.trLatency)], [`${this.sim.nodes.clickhouse.label} data is behind by`, fmtDur(n.freshCH)], ['Lake data is behind by', fmtDur(n.freshLake)], ['Failing queries', `${n.failRate.toFixed(1)} /s`]];
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
    $('t-lat').textContent = t.ok + t.err < 1 ? '—' : fmtDur(t.latency);
    const vals = { in: t.in, ok: t.ok, err: t.err };
    this.legendVals.forEach((b) => (b.textContent = fmtRate(vals[b.dataset.k])));

    const bn = sim.bottleneck;
    const banner = $('banner');
    banner.hidden = !bn || bn.id === this.selected;
    if (bn) banner.innerHTML = `<b>Bottleneck: ${bn.label}</b> <span>— ${bn.status} Click to inspect.</span>`;

    const cost = costs(sim);
    $('t-cost').textContent = fmtUSD(cost.total);
    $('t-cpm').textContent = cost.perMillion ? `per month · ${fmtUSD(cost.perMillion)} per 1M requests` : 'per month';
    this._renderPalette();
    $('v-webCount').textContent = sim.webCount;

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
