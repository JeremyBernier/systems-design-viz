import { Sim } from './sim.js';
import { Scene } from './scene.js';
import { UI } from './ui.js';

const sim = new Sim();
let paused = false;

const select = (id) => {
  scene.focus(id);
  ui.select(id);
};

const scene = new Scene(document.getElementById('stage'), sim, { onSelect: select });
const ui = new UI(sim, {
  onSelect: select,
  onPause: () => (paused = !paused),
  onReset: () => {
    Object.assign(sim.params, { traffic: 600, writePct: 10, webCount: 2, workerCount: 2, cacheEnabled: true, autoRestart: true, queryRate: 10, compaction: true });
    sim.reset();
    select(null);
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
// Deep links: ?traffic=4000&web=4&focus=db&t=20
const q = new URLSearchParams(location.search);
if (q.has('traffic')) sim.params.traffic = Math.min(20000, Math.max(20, +q.get('traffic') || 600));
if (q.has('queries')) sim.params.queryRate = Math.min(200, Math.max(0, +q.get('queries') || 0));
if (q.has('compaction')) sim.params.compaction = q.get('compaction') !== '0';
if (q.has('web')) sim.params.webCount = Math.min(6, Math.max(1, +q.get('web') || 2));
for (let i = 0, n = Math.min(120, +q.get('t') || 0) * 30; i < n; i++) sim.step(STEP); // ?t=20 skips ahead 20s
booted = true;
ui.syncControls();
if (sim.nodes[q.get('focus')]) select(q.get('focus'));

scene.updateLabels();
ui.update();
last = performance.now();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { sim, scene });
