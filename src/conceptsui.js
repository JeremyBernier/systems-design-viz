import './dbguide.css';
import { THEMES } from './concepts.js';

// "Core concepts": a guide to the ideas behind every system design — concurrency, failure, load and
// consistency. Opened from the Learn row at the bottom left. Reading only: it changes nothing.

const $ = (id) => document.getElementById(id);
const list = (items) => `<ul>${items.map((s) => `<li>${s}</li>`).join('')}</ul>`;

export function initConceptsUI() {
  const dlg = document.createElement('dialog');
  dlg.id = 'concepts';
  dlg.className = 'dlg';
  dlg.innerHTML = `
    <form method="dialog" class="pl-head"><div><h3><span class="learn-tag">Learn</span>Core concepts</h3><p class="hint">The ideas that come up in every system design, whatever the technology. Each one says what it is, what it buys and costs, and where to see it in this simulator.</p></div><button aria-label="Close">✕</button></form>
    <div class="seg dg-tabs" role="group" aria-label="Theme">${THEMES.map((t) => `<button data-tab="${t.id}">${t.name}</button>`).join('')}</div>
    <div class="dg-body" id="cc-body"></div>`;
  document.body.append(dlg);
  let tab = THEMES[0].id;

  // a trade-off between two options, row by row
  const versus = (v) => `<div class="dg-scroll"><table class="dg-table cc-versus"><thead><tr><th></th><th>${v.a}</th><th>${v.b}</th></tr></thead><tbody>${v.rows.map(([k, a, b]) => `<tr><th>${k}</th><td>${a}</td><td>${b}</td></tr>`).join('')}</tbody></table></div>`;
  const topic = (t) => `<section class="dg-concept" id="cc-${t.id}">
      <h2>${t.title}</h2><p class="dg-one">${t.one}</p>
      ${t.what.map((p) => `<p class="d-about">${p}</p>`).join('')}
      ${t.versus ? versus(t.versus) : ''}${t.choose ? `<div class="cc-choose"><b>Which to choose</b>${list(t.choose)}</div>` : ''}
      <div class="dg-pc">${t.pros.length ? `<div class="dg-pro"><b>What it gets you</b>${list(t.pros)}</div>` : ''}<div class="dg-con"><b>${t.pros.length ? 'What it costs you' : 'Why it hurts'}</b>${list(t.cons)}</div></div>
      <p class="dg-try${t.sim ? '' : ' none'}"><b>In the simulator:</b> ${t.sim || 'Not modelled here.'}</p>
    </section>`;
  const render = () => {
    const theme = THEMES.find((t) => t.id === tab);
    for (const b of dlg.querySelectorAll('[data-tab]')) b.setAttribute('aria-pressed', b.dataset.tab === tab);
    $('cc-body').innerHTML =
      `<p class="dg-one">${theme.intro}</p><nav class="dg-nav" aria-label="Topics">${theme.topics.map((t) => `<button data-jump="cc-${t.id}">${t.title}</button>`).join('')}</nav>` + theme.topics.map(topic).join('');
  };

  dlg.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation()); // Esc closes the guide only
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) return dlg.close(); // the backdrop
    const jump = e.target.closest('[data-jump]');
    if (jump) return document.getElementById(jump.dataset.jump).scrollIntoView({ block: 'start' });
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    tab = t.dataset.tab;
    render();
    $('cc-body').scrollTop = 0;
  });

  // its button joins the Learn row (index.html), first in line
  const open = document.createElement('button');
  open.id = 'concepts-open';
  open.textContent = '🧠 Core concepts';
  open.title = 'Concurrency, idempotency, retries, backpressure, consistency: the ideas behind every design';
  const bar = $('learnbar');
  bar.insertBefore(open, bar.querySelector('button'));
  open.addEventListener('click', () => {
    render();
    dlg.showModal();
    $('cc-body').scrollTop = 0;
  });
}
