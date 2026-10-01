import { Sim, NODE_INFO } from './sim.js';
import { PRESETS } from './presets.js';
import { Scene } from './scene.js';
import { UI } from './ui.js';

const sim = new Sim();
let paused = false;

const select = (id) => {
  scene.focus(id);
  ui.select(id);
};

const applyPreset = (preset) => {
  sim.applyPreset(preset);
  scene.resetLayout();
  select(null);
};

const scene = new Scene(document.getElementById('stage'), sim, {
  onSelect: select,
  onPlace: (id, pt) => {
    sim.setActive(id, true, false);
    scene.placeAt(id, pt);
    ui.setMode(null);
    ui.toast(`${sim.nodes[id].label} placed. It is not connected to anything yet — use “Connect components”.`);
    select(id);
  },
  onConnect: (a, b) => {
    const A = sim.nodes[a];
    const B = sim.nodes[b];
    const edge = sim.canConnect(a, b);
    if (edge) {
      const on = sim.toggleEdge(edge);
      const [from, to] = edge.split('>').map((x) => sim.nodes[x].label);
      ui.toast(`${on ? 'Connected' : 'Disconnected'} ${from} → ${to}`);
    } else {
      const can = [...new Set(sim.possibleEdges(a).map((e) => NODE_INFO[e.other.type].title))];
      ui.toast(`${A.label} and ${B.label} do not talk to each other directly. ${A.label} can connect to: ${can.join(', ') || 'nothing'}.`, 'bad');
    }
  },
});
const ui = new UI(sim, {
  onSelect: select,
  onPause: () => (paused = !paused),
  onPreset: applyPreset,
  onStartPlace: (id) => scene.startPlacing(id),
  onConnectMode: (on) => {
    scene.placing = null;
    scene.setConnecting(on);
  },
  onReset: () => {
    Object.assign(sim.params, { autoRestart: true, compaction: true });
    applyPreset(PRESETS.reference);
  },
});

let booted = false;
sim.on('crash', (node) => booted && scene.explode(node.id));

// Fixed-step simulation, variable-rate rendering.
const STEP = 1 / 30;
let last = performance.now();
let acc = 0;
let uiAcc = 0;

function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  let simDt = 0;
  if (!paused) {
    acc += dt;
    while (acc >= STEP) {
      sim.step(STEP);
      acc -= STEP;
    }
    simDt = dt;
  }
  scene.update(dt, simDt);
  uiAcc += dt;
  if (uiAcc > 0.2) {
    uiAcc = 0;
    scene.updateLabels();
    ui.update();
  }
  ui.drawCharts();
  requestAnimationFrame(frame);
}
// Deep links: ?preset=uber&traffic=4000&web=4&db=dynamodb&focus=db&t=20
const q = new URLSearchParams(location.search);
if (PRESETS[q.get('preset')]) {
  applyPreset(PRESETS[q.get('preset')]);
  ui.setPreset(q.get('preset'));
}
if (q.has('traffic')) sim.params.traffic = Math.min(20000, Math.max(20, +q.get('traffic') || 600));
if (q.has('queries')) sim.params.queryRate = Math.min(200, Math.max(0, +q.get('queries') || 0));
if (q.has('compaction')) sim.params.compaction = q.get('compaction') !== '0';
// ?db=dynamodb&web=lambda… picks a technology per component type (olap = the OLAP database)
for (const [k, v] of q) if (k !== 'web' || isNaN(+v)) sim.setTech(k === 'olap' ? 'clickhouse' : k, v, true);
for (let n = Math.min(6, +q.get('web') || 0); sim.webCount < n; ) sim.addWeb();
for (let i = 0, n = Math.min(120, +q.get('t') || 0) * 30; i < n; i++) sim.step(STEP); // ?t=20 skips ahead 20s
booted = true;
ui.syncControls();
if (sim.nodes[q.get('focus')]) select(q.get('focus'));

scene.updateLabels();
ui.update();
last = performance.now();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { sim, scene, ui });
