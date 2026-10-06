import './build.css';
import { NODE_INFO } from './sim.js';
import { TECH, logoSVG } from './tech.js';

// Adding a component: press Build (or B), pick one from the dialog, and it rides on the pointer as
// a see-through preview until you click to build it there. Esc cancels at either step.

const $ = (id) => document.getElementById(id);
// How the picker groups components. Anything not listed lands under "Other".
const SECTIONS = [
  ['Traffic and delivery', ['lb', 'cdn']],
  ['Compute', ['web', 'worker', 'fn', 'scheduler']],
  ['Cache and storage', ['cache', 'blob', 'lake']],
  ['Messaging and streaming', ['queue', 'kafka', 'consumer', 'connector']],
  ['Analytics', ['trino', 'bi']],
];
// Every database you can add, by the trade each family makes. [component type, heading, engines]
const DATABASES = [
  ['db', 'OLTP · relational', 'Tables, joins and transactions; one primary takes every write', ['postgres', 'mysql', 'rds', 'aurora', 'cloudsql']],
  ['db', 'OLTP · distributed SQL', 'SQL and transactions spread over many machines', ['spanner']],
  ['db', 'OLTP · wide-column and key-value', 'Scale out by key; no joins', ['cassandra', 'bigtable', 'dynamodb']],
  ['clickhouse', 'OLAP · analytics', 'Columnar: built to scan and aggregate, not to update rows', ['clickhouse', 'redshift', 'snowflake', 'bigquery']],
];
// One line per card on what sets it apart: the trade it makes against the alternatives.
const WHY = {
  lb: 'One is a single point of failure; a second one covers for it.',
  cdn: 'Serves images and video from the edge so those bytes never reach your servers. Billed per GB delivered.',
  web: 'More of them raise request capacity, until the database becomes the limit instead.',
  worker: 'More of them drain the job queue faster. Idle ones still cost money.',
  fn: 'Code run per event with nothing to manage. Trades servers for cold starts and a concurrency limit.',
  scheduler: 'Starts jobs at a set time. Reads ahead, so jobs still fire through a short outage of its own.',
  cache: 'Spares the database by answering repeat reads from memory. Comes back cold after a restart.',
  blob: 'Cheap, unlimited storage for files. Slow per request, and billed for every GB read out.',
  lake: 'The cheapest place to keep all history, as files. Queries take seconds, not milliseconds.',
  queue: 'Absorbs bursts so requests return quickly. It hides overload; it does not fix it.',
  kafka: 'A replayable log that many consumers read independently. Heavier to run than a queue.',
  consumer: 'Turns the event stream into files in the lake. Fresher data means more, smaller files.',
  connector: 'Loads Kafka into a warehouse that cannot read it itself. One more thing to run and watch.',
  trino: 'SQL straight over the lake\'s files, with nothing to load first. Seconds per query.',
  bi: 'Dashboards for people. Only as fresh and as fast as the database behind them.',
};
const ENGINE_WHY = {
  postgres: 'The default choice: the richest SQL, and free. One primary takes every write, and you run it.',
  mysql: 'Like PostgreSQL with cheaper connections and simpler replication, and fewer advanced SQL features.',
  rds: 'PostgreSQL with backups, patching and failover done for you, at about twice the price.',
  aurora: 'Replicas share one storage layer, so they barely lag and failover is fast. The priciest relational option.',
  cloudsql: 'Google\'s managed PostgreSQL: the same trade as RDS, on Google Cloud.',
  spanner: 'Scales writes across machines and keeps SQL and transactions. Slower commits and a high entry price.',
  cassandra: 'Writes cost no more than reads and there is no primary to lose. No joins, and heavy to operate.',
  bigtable: 'Managed and built for huge write volumes. One index (the row key) and no cross-row transactions.',
  dynamodb: 'Nothing to run, and it throttles instead of crashing. Reached by key only; you pay for provisioned throughput.',
  clickhouse: 'The fastest on fresh data, and cheap on one machine. You run it, and large joins are weak.',
  redshift: 'A classic SQL warehouse with full joins. A cluster you size and pay for around the clock.',
  snowflake: 'Compute is separate from storage, so queries never slow loading. Data is about 45 s behind and credits add up.',
  bigquery: 'Nothing to size, and it scans huge tables. About a second minimum per query, billed by data scanned.',
};
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
  dlg.innerHTML = `<form method="dialog" class="pl-head"><div><h3>Add a component</h3><p class="hint">Pick one, then click in the diagram where it should go. The first of a kind arrives with no connections: wire it up with “Connect components”. Another of a kind you already have joins the first and shares its load.</p></div><button aria-label="Close">✕</button></form><div class="bd-body" id="bd-body"></div>`;
  document.body.append(dlg);

  // The next unused node of a kind, how many are already in the diagram, and the most there can be.
  const slot = (type) => {
    const all = Object.values(sim.nodes).filter((n) => n.type === type);
    return { all, free: sim.placeable().find((n) => n.type === type), used: all.filter((n) => n.active).length, max: all.length };
  };
  // Why a card cannot be picked; a card that can be picked says what sets it apart instead.
  const blocked = (type, s) => (type === 'connector' && !s.used ? 'Not needed here: this warehouse reads Kafka by itself.' : `All ${s.max} are already in the diagram.`);
  // one card per kind of component
  const card = (type) => {
    const s = slot(type);
    const info = NODE_INFO[type];
    const tech = s.all[0].tech;
    return `<button class="bd-card" ${s.free ? `data-id="${s.free.id}"` : 'disabled'}>${tech ? logoSVG(tech.logo, 30) : '<span></span>'}<b>${sim.roleName(type)}</b><small>${first(info.about)}</small><em>${s.free ? WHY[type] || '' : blocked(type, s)}</em></button>`;
  };
  // one card per database engine: the engine is chosen here, not after placing
  const engine = (type, key) => {
    const s = slot(type);
    const t = TECH[type][key];
    return `<button class="bd-card" ${s.free ? `data-id="${s.free.id}" data-tech="${key}"` : 'disabled'}>${logoSVG(t.logo, 30)}<b>${t.name}</b><small>${t.vendor} · ${t.kind.replace(/^OL[TA]P · /, '')}</small><em>${s.free ? ENGINE_WHY[key] || '' : `All ${s.max} databases of this kind are already in the diagram.`}</em></button>`;
  };
  const render = () => {
    const types = [...new Set(Object.values(sim.nodes).map((n) => n.type))].filter((t) => t !== 'client');
    const grid = (cards) => `<div class="bd-grid">${cards.join('')}</div>`;
    const listed = new Set([...SECTIONS.flatMap(([, list]) => list), 'db', 'clickhouse']);
    const sections = [...SECTIONS, ['Other', types.filter((t) => !listed.has(t))]].map(([title, list]) => {
      const here = list.filter((t) => types.includes(t));
      return here.length ? `<h2>${title}</h2>${grid(here.map(card))}` : '';
    });
    const databases = `<h2>Database</h2>` + DATABASES.map(([type, name, what, keys]) => `<h4>${name} <span>${what}</span></h4>${grid(keys.filter((k) => TECH[type][k]).map((k) => engine(type, k)))}`).join('');
    sections.splice(2, 0, databases); // after Traffic and Compute
    $('bd-body').innerHTML = sections.join('');
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
    const node = sim.nodes[b.dataset.id];
    // a database card names its engine; any other extra tier member starts as the same technology as the first
    const tech = b.dataset.tech || (node.extraOf ? sim.params.tech[node.type] : null);
    if (tech) sim.setTech(node.type, tech, true, node.id);
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
