import './build.css';
import { TECH, logoSVG } from './tech.js';
import { TRADE, KIND, TECH_WHY } from './tradeoffs.js';

// Adding a component: press Build (or B), pick one from the dialog, and it rides on the pointer as
// a see-through preview until you click to build it there. Esc cancels at either step.

const $ = (id) => document.getElementById(id);

// The row of buttons at the top left of the diagram, just right of the sidebar. Created on first use.
export function stageBar() {
  let bar = $('stagebar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'stagebar';
    document.body.append(bar);
  }
  return bar;
}
// The picker's sections, in the order a request meets them. Each lists the specific technologies of
// one kind of component: [component type, section name]. Databases have their own grouping below.
const SECTIONS = [
  ['lb', 'Load balancers'],
  ['cdn', 'Content delivery networks'],
  ['web', 'Application servers'],
  ['worker', 'Background workers'],
  ['fn', 'Serverless functions'],
  ['scheduler', 'Job schedulers'],
  ['db', 'Databases'],
  ['cache', 'Caches'],
  ['blob', 'Object storage'],
  ['lake', 'Data lake table formats'],
  ['queue', 'Message queues'],
  ['kafka', 'Event streams'],
  ['consumer', 'Stream processors'],
  ['connector', 'Warehouse connectors'],
  ['trino', 'Lake query engines'],
  ['bi', 'Dashboards'],
];
// One line per section on what this kind of component is for, and its catch.
const WHY = {
  lb: 'Spreads requests over your servers. One is a single point of failure; a second covers for it.',
  cdn: 'Serves images and video from the edge so those bytes never reach your servers.',
  web: 'Run your application code. More of them raise request capacity, until the database becomes the limit.',
  worker: 'Do slow work off the request path. More of them drain the job queue faster; idle ones still cost money.',
  fn: 'Code run per event with nothing to manage, trading servers for cold starts and a concurrency limit.',
  scheduler: 'Start jobs at a set time instead of in response to a request.',
  db: 'Where the data lives. Every engine buys something by giving something else up.',
  cache: 'Answer repeat reads from memory to spare the database. They come back cold after a restart.',
  blob: 'Cheap, unlimited storage for files. Slow per request, and billed for every GB read out.',
  lake: 'How files in object storage are organised into tables that query engines can read.',
  queue: 'Hold background jobs so requests return quickly. A queue hides overload; it does not fix it.',
  kafka: 'A replayable log of events that many consumers read independently. Heavier to run than a queue.',
  consumer: 'Turn the event stream into files in the lake. Fresher data means more, smaller files.',
  connector: 'Load Kafka into a warehouse that cannot read it itself.',
  trino: 'SQL straight over the lake\'s files, with nothing to load first. Seconds per query.',
  bi: 'Charts for people. Only as fresh and as fast as the database behind them.',
};
// Every database you can add, by the trade each family makes. [component type, heading, engines]
const DATABASES = [
  ['db', 'OLTP · relational', 'Tables, joins and transactions; one primary takes every write', ['postgres', 'mysql', 'rds', 'aurora', 'cloudsql']],
  ['db', 'OLTP · distributed SQL', 'SQL and transactions spread over many machines', ['spanner']],
  ['db', 'OLTP · wide-column and key-value', 'Scale out by key; no joins', ['cassandra', 'bigtable', 'dynamodb']],
  ['clickhouse', 'OLAP · analytics', 'Columnar: built to scan and aggregate, not to update rows', ['clickhouse', 'redshift', 'snowflake', 'bigquery']],
];
// Pros and cons under a card: a few of each, so the trade is visible before choosing.
const list = (cls, name, items) => (items && items.length ? `<span class="bd-pc ${cls}"><i>${name}</i>${items.map((s) => `<span>${s}</span>`).join('')}</span>` : '');
const proscons = (pros, cons) => list('pro', 'Pros', pros) + list('con', 'Cons', cons);

export function initBuildUI(ui, sim) {
  const open = document.createElement('button');
  open.id = 'build-open';
  stageBar().prepend(open);
  const hint = document.createElement('div');
  hint.id = 'place-hint';
  hint.hidden = true;
  document.body.append(hint);
  const dlg = document.createElement('dialog');
  dlg.id = 'build-dlg';
  dlg.innerHTML = `<form method="dialog" class="pl-head"><div><h3>Add a component</h3><p class="hint">Pick a technology, then click in the diagram where it should go. The first of a kind arrives with no connections: wire it up with “Connect components”. Another of a kind you already have joins the first and shares its load.</p></div><button aria-label="Close">✕</button></form><div class="bd-body" id="bd-body"></div>`;
  document.body.append(dlg);

  // The next unused node of a kind, how many are already in the diagram, and the most there can be.
  const slot = (type) => {
    const all = Object.values(sim.nodes).filter((n) => n.type === type);
    return { all, free: sim.placeable().find((n) => n.type === type), used: all.filter((n) => n.active).length, max: all.length };
  };
  // Why a card cannot be picked; a card that can be picked says what sets the technology apart instead.
  const blocked = (type, s) => (type === 'connector' && !s.used ? 'Not needed here: this warehouse reads Kafka by itself.' : `All ${s.max} of this kind are already in the diagram.`);
  // one card per specific technology: what you pick is what gets built
  const card = (type, key) => {
    const s = slot(type);
    const t = TECH[type][key];
    const trade = (TRADE[type] || {})[key];
    // application servers all run one technology here, so choosing another one moves the whole tier
    const moves = type === 'web' && s.used && sim.techOf('web') !== t ? ` Adding it switches every application server to ${t.name}.` : '';
    return `<button class="bd-card" ${s.free ? `data-id="${s.free.id}" data-tech="${key}"` : 'disabled'}>${logoSVG(t.logo, 30)}<b>${t.name}</b><small>${t.vendor} · ${t.kind.replace(/^OL[TA]P · /, '')}</small><em>${
      s.free ? ((TECH_WHY[type] || {})[key] || '') + moves : blocked(type, s)
    }</em>${trade ? proscons(trade.gain.slice(0, 3), trade.lose.slice(0, 3)) : ''}</button>`;
  };
  const render = () => {
    const grid = (type, keys) => `<div class="bd-grid">${keys.filter((k) => TECH[type][k]).map((k) => card(type, k)).join('')}</div>`;
    // what having this kind of component at all buys and costs, folded away under the section heading
    const kind = (type) => (KIND[type] ? `<details class="bd-kind"><summary>Why have one at all?</summary><div>${proscons(KIND[type].pros, KIND[type].cons)}</div></details>` : '');
    const section = ([type, name]) =>
      `<h2 id="bd-${type}">${name}</h2><p class="bd-what">${WHY[type] || ''}</p>` +
      (type === 'db' ? DATABASES.map(([t, fam, what, keys]) => `<h4>${fam} <span>${what}</span></h4>${grid(t, keys)}`).join('') : kind(type) + grid(type, Object.keys(TECH[type])));
    $('bd-body').innerHTML = `<nav class="bd-nav" aria-label="Sections">${SECTIONS.map(([type, name]) => `<button data-jump="bd-${type}">${name}</button>`).join('')}</nav>` + SECTIONS.filter(([type]) => TECH[type]).map(section).join('');
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
    open.innerHTML = placing ? `Placing ${placing.tech.name} — click to build<kbd>Esc</kbd> cancels` : '＋ Build<kbd>B</kbd>';
    hint.hidden = true; // reappears on the next pointer move over the diagram
    if (placing) hint.innerHTML = `${placing.tech.name} <span>· click to build · Esc to cancel</span>`;
  };
  ui.onMode = sync;
  sync();
  // the button sits just right of the left sidebar, however wide that is
  const dock = () => (stageBar().style.left = $('controls').getBoundingClientRect().right + 12 + 'px');
  new ResizeObserver(dock).observe($('controls'));
  addEventListener('resize', dock);
  dock();

  open.addEventListener('click', () => (ui.mode === 'place' ? ui.setMode(null) : show()));
  $('build-open-side').addEventListener('click', show);
  dlg.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation()); // Esc closes the dialog only
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) return dlg.close(); // the backdrop
    const jump = e.target.closest('[data-jump]');
    if (jump) return document.getElementById(jump.dataset.jump).scrollIntoView({ block: 'start' });
    const b = e.target.closest('.bd-card[data-id]');
    if (!b) return;
    dlg.close();
    const node = sim.nodes[b.dataset.id];
    // the card names the technology: the first of a kind sets it for that kind, an extra one takes it alone
    if (node.extraOf || sim.params.tech[node.type] !== b.dataset.tech) sim.setTech(node.type, b.dataset.tech, true, node.id);
    ui.setMode('place', node.id);
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
