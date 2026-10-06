import { Sim, NODE_INFO } from './sim.js';
import { PRESETS } from './presets.js';
import { Scene } from './scene.js';
import { UI } from './ui.js';
import { serialise, load as loadState } from './share.js';
import { AUTO_PARAMS, autoQuery } from './autoscale.js';
import { DEFAULTS as REL_DEFAULTS } from './latency.js';

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
  onView: (view) => scene.setView(view),
  onConnectMode: (on) => {
    scene.placing = null;
    scene.setConnecting(on);
  },
  onReset: () => {
    Object.assign(sim.params, { autoRestart: true, compaction: true });
    Object.assign(sim.params, AUTO_PARAMS, REL_DEFAULTS); // steady traffic, autoscaling off, no retries, stock SLO
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
    syncLink();
  }
  ui.drawCharts();
  requestAnimationFrame(frame);
}
// Deep links: ?preset=uber&traffic=4000&web=4&db=dynamodb&focus=db&t=20
const q = new URLSearchParams(location.search);
// The rest of the state (every param, components, connections) rides along too: see share.js.
const link = loadState(sim, q, applyPreset);
autoQuery(sim.params, q); // readable aliases: ?pattern=daily&autoscale=1&asmin=2&asmax=6&astarget=60&wauto=1
if (link.preset) ui.setPreset(link.preset);
for (let i = 0, n = link.t * 30; i < n; i++) sim.step(STEP); // ?t=20 skips ahead 20s
booted = true;
ui.syncControls();
if (sim.nodes[link.focus] && sim.nodes[link.focus].active) select(link.focus);

// Save and share: keep the address bar holding a link that rebuilds this exact system.
// Polled from the UI tick rather than hooked into each control, so nothing can be missed.
const linkQuery = () => serialise(sim, { preset: document.getElementById('preset').value, focus: ui.selected, t: q.get('t') });
const linkURL = (s) => location.pathname + (s ? '?' + s : '') + location.hash;
let linkShown = linkQuery();
let linkTimer = 0;
function syncLink() {
  const s = linkQuery();
  if (s === linkShown) return;
  linkShown = s;
  clearTimeout(linkTimer);
  linkTimer = setTimeout(() => history.replaceState(null, '', linkURL(s)), 400);
}
document.getElementById('copy-link').addEventListener('click', async () => {
  const s = (linkShown = linkQuery());
  clearTimeout(linkTimer);
  history.replaceState(null, '', linkURL(s));
  try {
    await navigator.clipboard.writeText(location.origin + linkURL(s));
    ui.toast('Link copied. Opening it rebuilds this exact system.');
  } catch {
    ui.toast('Could not reach the clipboard. Copy the address bar instead — it always holds the current link.', 'bad');
  }
});

scene.updateLabels();
ui.update();
last = performance.now();
requestAnimationFrame(frame);

if (import.meta.env.DEV) Object.assign(window, { sim, scene, ui });
