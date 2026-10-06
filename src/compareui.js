import './compare.css';
import { TECH, logoSVG } from './tech.js';
import { NODE_INFO } from './sim.js';
import { nodeCost, fmtUSD } from './cost.js';
import { TRADE, OPS_WORDS, TARGET_UTIL, compare, hasChoice, fmtLoad } from './tradeoffs.js';

// Comparing technologies: the trade-off summary in a component's panel, and a dialog that puts
// every option for that component side by side — what each costs as load grows, what one unit
// can take, how it fails, how much work it is to run, and what you gain and give up.

const $ = (id) => document.getElementById(id);
// Categorical series colours in fixed order (the same hues the traffic key uses); an option keeps
// its colour whatever the load. Past eight, the rest share a dashed grey rather than a made-up hue.
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const OTHER = '#898781';
const colour = (i) => SERIES[i] || OTHER;

const list = (items) => `<ul>${items.map((s) => `<li>${s}</li>`).join('')}</ul>`;
const ops = (n) => `<span class="ops" title="Effort to run: ${n} of 5">${[1, 2, 3, 4, 5].map((i) => `<i${i <= n ? ' class="on"' : ''}></i>`).join('')}<span>${OPS_WORDS[n]}</span></span>`;

// The panel's short version: what this choice buys and costs, with a way in to the full comparison.
export function tradeHTML(node) {
  const key = node.tech && Object.keys(TECH[node.type] || {}).find((k) => TECH[node.type][k] === node.tech);
  const t = key && (TRADE[node.type] || {})[key];
  if (!t) return '';
  const n = Object.keys(TRADE[node.type]).length;
  return `<h2>Trade-offs of ${node.tech.name}</h2>
    <div class="trade"><div class="gain"><b>You gain</b>${list(t.gain)}</div><div class="lose"><b>You give up</b>${list(t.lose)}</div></div>
    <p class="trade-ops">Effort to run: ${ops(t.ops)}</p>
    ${hasChoice(node.type) ? `<button id="d-compare" class="wide">⚖ Compare all ${n} options</button>` : ''}`;
}

function chart(c) {
  const W = 960;
  const H = 300;
  const direct = c.rows.length <= 4; // few enough series to name each at the end of its line
  const m = { l: 58, r: direct ? 150 : 18, t: 22, b: 32 };
  const w = W - m.l - m.r;
  const h = H - m.t - m.b;
  // one runaway option must not flatten the rest: cap the axis at a few times the typical cost
  const ends = c.rows.map((r) => Math.max(...r.ys)).sort((a, b) => a - b);
  const typical = ends[Math.floor((ends.length - 1) / 2)] || 1;
  const top = Math.max(1, Math.min(ends[ends.length - 1], typical * 4));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * Math.pow(10, Math.floor(Math.log10(top / 4)))).find((s) => top / s <= 5);
  const yMax = Math.ceil(top / step) * step;
  const x = (v) => m.l + (v / c.max) * w;
  const y = (v) => m.t + h - (Math.min(v, yMax * 1.05) / yMax) * h;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly cost of each option against load"><defs><clipPath id="cmp-clip"><rect x="${m.l}" y="${m.t - 4}" width="${w}" height="${h + 4}"/></clipPath></defs>`;
  for (let v = 0; v <= yMax + 1e-9; v += step) s += `<line x1="${m.l}" x2="${m.l + w}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${fmtUSD(v)}</text>`;
  for (let i = 0; i <= 4; i++) s += `<text x="${x((c.max * i) / 4)}" y="${H - 10}" text-anchor="${i === 4 ? 'end' : i ? 'middle' : 'start'}">${fmtLoad((c.max * i) / 4)}${i === 4 ? ' ' + c.unit : ''}</text>`;
  // today's load
  s += `<line x1="${x(c.now)}" x2="${x(c.now)}" y1="${m.t - 4}" y2="${m.t + h}" stroke="var(--text-2)" stroke-dasharray="3 4"/><text class="lab" x="${x(c.now) + 6}" y="${m.t + 6}">today · ${fmtLoad(c.now)} ${c.unit}</text>`;
  s += `<g clip-path="url(#cmp-clip)">`;
  c.rows.forEach((r, i) => {
    const d = r.ys.map((v, k) => `${k ? 'L' : 'M'}${x(c.xs[k]).toFixed(1)},${y(v).toFixed(1)}`).join('');
    s += `<path d="${d}" fill="none" stroke="${colour(i)}" stroke-width="2" stroke-linejoin="round"${SERIES[i] ? '' : ' stroke-dasharray="5 4"'}/>`;
  });
  s += `</g>`;
  if (direct) {
    // name each line at its end, nudged apart so no two labels collide
    const labs = c.rows.map((r, i) => ({ name: r.tech.name, i, y: y(r.ys[r.ys.length - 1]) })).sort((a, b) => a.y - b.y);
    labs.forEach((l, k) => k && (l.y = Math.max(l.y, labs[k - 1].y + 14)));
    for (const l of labs) s += `<circle cx="${m.l + w}" cy="${Math.min(l.y, m.t + h)}" r="3" fill="${colour(l.i)}"/><text class="lab" x="${m.l + w + 8}" y="${Math.min(l.y, m.t + h) + 4}">${l.name}</text>`;
  }
  s += `<g id="cmp-hover" visibility="hidden"><line id="cmp-cross" y1="${m.t - 4}" y2="${m.t + h}" stroke="var(--muted)"/>${c.rows.map((r, i) => `<circle r="4" fill="${colour(i)}" stroke="var(--surface)" stroke-width="2"/>`).join('')}</g>`;
  s += `<rect id="cmp-hit" x="${m.l}" y="${m.t - 4}" width="${w}" height="${h + 4}" fill="transparent"/></svg>`;
  return { svg: s, x, y, m, w, W };
}

// "Cheapest: Lambda up to ~100 req/s, then EC2." Past three changes the chart says it better.
function summary(c) {
  const by = (k) => c.rows.find((r) => r.key === k).tech.name;
  const segs = c.cheapest;
  if (segs.length === 1) return `<b>${by(segs[0].key)}</b> is the cheapest at every load on this chart.`;
  if (segs.length > 3) return `The cheapest option changes ${segs.length - 1} times as load grows: machines are bought one at a time, so their cost rises in steps and keeps crossing the others.`;
  return (
    'Cheapest: ' +
    segs.map((g, i) => `<b>${by(g.key)}</b> ${i === 0 ? `up to about ${fmtLoad(g.to)} ${c.unit}` : i === segs.length - 1 ? 'beyond that' : `to about ${fmtLoad(g.to)}`}`).join(', then ') +
    '. The answer flips where the lines cross.'
  );
}

export function initCompareUI(ui, sim) {
  const dlg = document.createElement('dialog');
  dlg.id = 'compare';
  dlg.innerHTML = `<form method="dialog" class="pl-head"><div><h3 id="cmp-title"></h3><p class="hint" id="cmp-sub"></p></div><button aria-label="Close">✕</button></form><div class="cmp-body" id="cmp-body"></div>`;
  document.body.append(dlg);
  let id = null;

  const render = () => {
    const node = sim.nodes[id];
    if (!node) return dlg.close();
    const c = compare(sim, node);
    // what the tier really costs now, as built — the table prices each option sized for today's load instead
    const actual = Object.values(sim.nodes).filter((n) => n.type === node.type && n.active).reduce((s, n) => s + nodeCost(sim, n).monthly, 0);
    $('cmp-title').textContent = `Compare options: ${NODE_INFO[node.type].title}`;
    $('cmp-sub').textContent = `${c.rows.length} options, priced for this system as it is running now. Nothing here is best at everything: each buys something by giving something else up.`;
    const ch = chart(c);
    const maxNow = Math.max(...c.rows.map((r) => r.monthly), 1);
    const unitWord = node.type === 'web' ? 'server' : node.type === 'worker' ? 'worker' : node.type === 'db' ? 'node' : 'unit';
    $('cmp-body').innerHTML = `
      <section>
        <h2>Monthly cost as load grows</h2>
        <p class="cmp-sum">${summary(c)}</p>
        <div class="cmp-legend">${c.rows.map((r, i) => `<span><i class="${SERIES[i] ? '' : 'other'}" style="border-color:${colour(i)}"></i>${r.tech.name}${r.current ? ' <em>(in use)</em>' : ''}</span>`).join('')}</div>
        <div class="cmp-chart">${ch.svg}<div class="cmp-tip" id="cmp-tip" hidden></div></div>
        <p class="hint">Each option is sized for the load on the horizontal axis: enough machines to run at ${TARGET_UTIL * 100}% busy, bought in whole units (which is why those lines climb in steps), or billed by use where the service charges that way. Prices are the list prices in the cost breakdown, with your pricing model applied. Hover the chart for exact figures.</p>
      </section>
      <section>
        <h2>Side by side at today's load · ${fmtLoad(c.now)} ${c.unit}</h2>
        <div class="cmp-scroll"><table class="cmp-table">
          <thead><tr><th>Technology</th><th>Cost per month</th><th>One ${unitWord} handles</th><th>Growing it</th><th>When overloaded or broken</th><th>Effort to run</th><th>You gain</th><th>You give up</th></tr></thead>
          <tbody>${c.rows
            .map(
              (r) => `<tr${r.current ? ' class="on"' : ''}>
              <th><div class="cmp-name">${logoSVG(r.tech.logo, 22)}<span>${r.tech.name}<small>${r.tech.vendor}</small></span></div>${r.current ? '<em>In use</em>' : `<button data-use="${r.key}" title="Switch the simulation to ${r.tech.name}">Use this</button>`}</th>
              <td class="cmp-cost"><b>${fmtUSD(r.monthly)}</b><small>${r.units ? `${r.units} ${unitWord}${r.units > 1 ? 's' : ''}` : 'billed by use'}</small><u style="width:${(r.monthly / maxNow) * 100}%"></u></td>
              <td class="dim">${r.capText}</td>
              <td class="dim">${r.scale}</td>
              <td class="dim">${r.fail}</td>
              <td>${ops(r.ops)}</td>
              <td class="gain">${list(r.gain)}</td>
              <td class="lose">${list(r.lose)}</td>
            </tr>`
            )
            .join('')}</tbody>
        </table></div>
        <p class="hint">Costs assume each option is sized for today's load. As built, this part of your system costs ${fmtUSD(actual)} a month.</p>
      </section>`;

    // hover: a crosshair and every option's cost at that load, cheapest first
    const svg = dlg.querySelector('svg');
    const hover = svg.querySelector('#cmp-hover');
    const dots = [...hover.querySelectorAll('circle')];
    const tip = $('cmp-tip');
    const move = (e) => {
      const box = svg.getBoundingClientRect();
      const px = ((e.clientX - box.left) / box.width) * ch.W;
      const k = Math.max(0, Math.min(c.xs.length - 1, Math.round(((px - ch.m.l) / ch.w) * (c.xs.length - 1))));
      const cx = ch.x(c.xs[k]);
      hover.setAttribute('visibility', 'visible');
      hover.querySelector('#cmp-cross').setAttribute('x1', cx);
      hover.querySelector('#cmp-cross').setAttribute('x2', cx);
      dots.forEach((d, i) => {
        d.setAttribute('cx', cx);
        d.setAttribute('cy', ch.y(c.rows[i].ys[k]));
      });
      tip.hidden = false;
      tip.innerHTML =
        `<b>At ${fmtLoad(c.xs[k])} ${c.unit}</b>` +
        c.rows
          .map((r, i) => ({ r, i }))
          .sort((a, b) => a.r.ys[k] - b.r.ys[k])
          .map(({ r, i }) => `<div><i style="border-color:${colour(i)}"></i>${r.tech.name}<span>${fmtUSD(r.ys[k])}</span></div>`)
          .join('');
      const left = (cx / ch.W) * box.width;
      tip.style.left = (left > box.width / 2 ? left - tip.offsetWidth - 14 : left + 14) + 'px';
    };
    svg.querySelector('#cmp-hit').addEventListener('pointermove', move);
    svg.querySelector('#cmp-hit').addEventListener('pointerleave', () => {
      hover.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    });
  };

  dlg.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation()); // keep Esc from also reaching the app
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) return dlg.close(); // the backdrop
    const use = e.target.closest('[data-use]');
    if (!use) return;
    sim.setTech(sim.nodes[id].type, use.dataset.use);
    ui.select(ui.selected);
    render();
  });
  $('detail').addEventListener('click', (e) => {
    if (!e.target.closest('#d-compare')) return;
    id = ui.selected;
    render();
    dlg.showModal();
  });
}
