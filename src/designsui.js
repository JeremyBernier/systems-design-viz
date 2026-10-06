import './dbguide.css';
import { DESIGNS } from './designs.js';

// "System designs": worked design problems, from scoping to a system you can load and break.
// Opened from the Learn row. Reading changes nothing; the one button that does says so.

const $ = (id) => document.getElementById(id);
const paras = (ps) => (ps || []).map((p) => `<p class="d-about">${p}</p>`).join('');
const table = (t) => `<div class="dg-scroll"><table class="dg-table ds-table"><thead><tr>${t.head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${t.rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td>${c}</td>` : `<th>${c}</th>`)).join('')}</tr>`).join('')}</tbody></table></div>`;

export function initDesignsUI() {
  const dlg = document.createElement('dialog');
  dlg.id = 'designs';
  dlg.className = 'dlg';
  dlg.innerHTML = `
    <form method="dialog" class="pl-head"><div><h3><span class="learn-tag">Learn</span><span id="ds-title"></span></h3><p class="hint" id="ds-problem"></p></div><button aria-label="Close">✕</button></form>
    <div class="seg dg-tabs" role="group" aria-label="Stage" id="ds-tabs"></div>
    <div class="dg-body" id="ds-body"></div>`;
  document.body.append(dlg);
  let design = DESIGNS[0];
  let tab = design.sections[0].id;

  const block = (b) =>
    `<section class="dg-concept">${b.h ? `<h2>${b.h}</h2>` : ''}${paras(b.p)}${b.table ? table(b.table) : ''}${b.steps ? `<ol class="fl-steps">${b.steps.map((s) => `<li>${s}</li>`).join('')}</ol>` : ''}${
      b.list ? `<ul class="ds-list">${b.list.map((s) => `<li>${s}</li>`).join('')}</ul>` : ''
    }${b.note ? `<p class="dg-try">${b.note}</p>` : ''}${
      b.load ? `<p class="ds-load"><button id="ds-load" class="primary">Load this system into the simulator</button><span class="hint">Replaces the system on screen, like choosing it in the System menu.</span></p>` : ''
    }</section>`;
  const render = () => {
    const sec = design.sections.find((s) => s.id === tab);
    $('ds-title').textContent = `System design: ${design.title}`;
    $('ds-problem').textContent = design.problem;
    $('ds-tabs').innerHTML = design.sections.map((s) => `<button data-tab="${s.id}" aria-pressed="${s.id === tab}">${s.name}</button>`).join('');
    $('ds-body').innerHTML = `<p class="dg-one">${sec.intro}</p>` + sec.blocks.map(block).join('');
  };

  dlg.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation()); // Esc closes the guide only
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) return dlg.close(); // the backdrop
    if (e.target.closest('#ds-load')) {
      // the same path as picking it by hand, so everything that follows a preset change still happens
      const sel = $('preset');
      sel.value = design.preset;
      sel.dispatchEvent(new Event('change'));
      return dlg.close();
    }
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    tab = t.dataset.tab;
    render();
    $('ds-body').scrollTop = 0;
  });

  // its button joins the Learn row (index.html)
  const btn = document.createElement('button');
  btn.id = 'designs-open';
  btn.textContent = '🧭 System designs';
  btn.title = 'Worked design problems, from scoping to a system you can load: ad click aggregator';
  $('learnbar').append(btn);
  btn.addEventListener('click', () => {
    render();
    dlg.showModal();
    $('ds-body').scrollTop = 0;
  });
}
