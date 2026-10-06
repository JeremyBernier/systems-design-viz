import './build.css';
import { NODE_INFO, MAX_WEB } from './sim.js';
import { logoSVG } from './tech.js';

// Adding a component: press Build (or B), pick one from the dialog, and it rides on the pointer as
// a see-through preview until you click to build it there. Esc cancels at either step.

const $ = (id) => document.getElementById(id);
// How the picker groups components. Anything not listed lands under "Other".
const SECTIONS = [
  ['Traffic and delivery', ['lb', 'cdn']],
  ['Compute', ['web', 'worker', 'fn', 'scheduler']],
  ['Database', ['db', 'clickhouse']],
  ['Cache and storage', ['cache', 'blob', 'lake']],
  ['Messaging and streaming', ['queue', 'kafka', 'consumer', 'connector']],
  ['Analytics', ['trino', 'bi']],
];
const first = (s) => s.split(/(?<=\.)\s/)[0]; // the first sentence of a description

export function initBuildUI(ui, sim) {
  const open = document.createElement('button');
  open.id = 'build-open';
  document.body.append(open);
  const hint = document.createElement('div');
  hint.id = 'place-hint';
  hint.hidden = true;
  document.body.append(hint);
  const dlg = document.createElement('dialog');
  dlg.id = 'build-dlg';
  dlg.innerHTML = `<form method="dialog" class="pl-head"><div><h3>Add a component</h3><p class="hint">Pick one, then click in the diagram where it should go. It arrives with no connections: wire it up with “Connect components”.</p></div><button aria-label="Close">✕</button></form><div class="bd-body" id="bd-body"></div>`;
  document.body.append(dlg);

  // one card per kind of component: the next unused one of that kind, or why there is none
  const card = (type) => {
    const all = Object.values(sim.nodes).filter((n) => n.type === type);
    const free = sim.placeable().find((n) => n.type === type);
    const info = NODE_INFO[type];
    const tech = all[0].tech;
    const used = all.filter((n) => n.active).length;
    const note = free ? (type === 'web' ? `${used} of ${MAX_WEB} in the diagram` : tech ? `as ${tech.name} — change it after placing` : '') : type === 'web' ? `All ${MAX_WEB} are in the diagram` : type === 'connector' ? 'Only needed for a warehouse that cannot read Kafka itself' : 'Already in the diagram';
    return `<button class="bd-card" ${free ? `data-id="${free.id}"` : 'disabled'}>${tech ? logoSVG(tech.logo, 30) : '<span></span>'}<b>${info.title}</b><small>${first(info.about)}</small><em>${note}</em></button>`;
  };
  const render = () => {
    const types = [...new Set(Object.values(sim.nodes).map((n) => n.type))].filter((t) => t !== 'client');
    const can = new Set(sim.placeable().map((n) => n.type));
    const listed = new Set(SECTIONS.flatMap(([, list]) => list));
    const sections = [...SECTIONS, ['Other', types.filter((t) => !listed.has(t))]];
    $('bd-body').innerHTML = sections
      .map(([title, list]) => {
        // within a section, what can be added comes before what is already there
        const here = list.filter((t) => types.includes(t)).sort((a, b) => can.has(b) - can.has(a));
        return here.length ? `<h2>${title}</h2><div class="bd-grid">${here.map(card).join('')}</div>` : '';
      })
      .join('');
  };
  const show = () => {
    if (dlg.open) return;
    ui.setMode(null);
    render();
    dlg.showModal();
  };

  // the button doubles as the "you are placing something" indicator
  const sync = () => {
    const placing = ui.mode === 'place' && sim.nodes[ui.placingId];
    open.setAttribute('aria-pressed', !!placing);
    open.innerHTML = placing ? `Placing ${NODE_INFO[placing.type].title} — click to build<kbd>Esc</kbd> cancels` : '＋ Build<kbd>B</kbd>';
    hint.hidden = true; // reappears on the next pointer move over the diagram
    if (placing) hint.innerHTML = `${NODE_INFO[placing.type].title} <span>· click to build · Esc to cancel</span>`;
  };
  ui.onMode = sync;
  sync();
  // the button sits just right of the left sidebar, however wide that is
  const dock = () => (open.style.left = $('controls').getBoundingClientRect().right + 12 + 'px');
  new ResizeObserver(dock).observe($('controls'));
  addEventListener('resize', dock);
  dock();

  open.addEventListener('click', () => (ui.mode === 'place' ? ui.setMode(null) : show()));
  $('build-open-side').addEventListener('click', show);
  dlg.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation()); // Esc closes the dialog only
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) return dlg.close(); // the backdrop
    const b = e.target.closest('.bd-card[data-id]');
    if (!b) return;
    dlg.close();
    ui.setMode('place', b.dataset.id);
  });
  addEventListener('keydown', (e) => {
    if (e.key !== 'b' && e.key !== 'B') return;
    if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox') return;
    e.preventDefault();
    show();
  });
  // the hint follows the pointer while it is over the diagram
  addEventListener('pointermove', (e) => {
    const over = ui.mode === 'place' && e.target.closest && e.target.closest('#stage');
    hint.hidden = !over;
    if (over) hint.style.transform = `translate(${e.clientX + 18}px,${e.clientY + 20}px)`;
  });
}
