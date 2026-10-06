import './dbguide.css';
import { SECTIONS } from './flink.js';

// The Flink deep dive: how a job runs, state backends, checkpoints and Kafka offsets, and
// watermarks against state TTL. Opened from the Learn row. Reading only: it changes nothing.

const $ = (id) => document.getElementById(id);
const list = (items) => `<ul>${items.map((s) => `<li>${s}</li>`).join('')}</ul>`;
const paras = (ps) => (ps || []).map((p) => `<p class="d-about">${p}</p>`).join('');

export function initFlinkUI() {
  const dlg = document.createElement('dialog');
  dlg.id = 'flink';
  dlg.className = 'dlg';
  dlg.innerHTML = `
    <form method="dialog" class="pl-head"><div><h3><span class="learn-tag">Learn</span>Flink deep dive</h3><p class="hint">A stream processor that keeps state and survives failures without losing or double-counting it. This is how it does that, and where the guarantees stop.</p></div><button aria-label="Close">✕</button></form>
    <div class="seg dg-tabs" role="group" aria-label="Section">${SECTIONS.map((s) => `<button data-tab="${s.id}">${s.name}</button>`).join('')}</div>
    <div class="dg-body" id="fl-body"></div>`;
  document.body.append(dlg);
  let tab = SECTIONS[0].id;

  // a trade-off between two options, row by row
  const versus = (v) => `<div class="dg-scroll"><table class="dg-table cc-versus"><thead><tr><th></th><th>${v.a}</th><th>${v.b}</th></tr></thead><tbody>${v.rows.map(([k, a, b]) => `<tr><th>${k}</th><td>${a}</td><td>${b}</td></tr>`).join('')}</tbody></table></div>`;
  const topic = (t) => `<section class="dg-concept" id="fl-${t.id}">
      <h2>${t.title}</h2><p class="dg-one">${t.one}</p>
      ${paras(t.what)}${t.steps ? `<ol class="fl-steps">${t.steps.map((s) => `<li>${s}</li>`).join('')}</ol>` : ''}${paras(t.after)}
      ${t.versus ? versus(t.versus) : ''}${t.choose ? `<div class="cc-choose"><b>Which to choose</b>${list(t.choose)}</div>` : ''}
      <div class="dg-pc"><div class="dg-pro"><b>What it gets you</b>${list(t.pros)}</div><div class="dg-con"><b>What it costs you</b>${list(t.cons)}</div></div>
      <p class="dg-try${t.sim ? '' : ' none'}"><b>In the simulator:</b> ${t.sim || 'Not modelled here.'}</p>
    </section>`;
  const render = () => {
    const sec = SECTIONS.find((s) => s.id === tab);
    for (const b of dlg.querySelectorAll('[data-tab]')) b.setAttribute('aria-pressed', b.dataset.tab === tab);
    $('fl-body').innerHTML = `<p class="dg-one">${sec.intro}</p><nav class="dg-nav" aria-label="Topics">${sec.topics.map((t) => `<button data-jump="fl-${t.id}">${t.title}</button>`).join('')}</nav>` + sec.topics.map(topic).join('');
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
    $('fl-body').scrollTop = 0;
  });

  // its button joins the Learn row (index.html)
  const btn = document.createElement('button');
  btn.id = 'flink-open';
  btn.textContent = '🐿️ Flink';
  btn.title = 'State backends, checkpoints and Kafka offsets, watermarks and state TTL';
  $('learnbar').append(btn);
  btn.addEventListener('click', () => {
    render();
    dlg.showModal();
    $('fl-body').scrollTop = 0;
  });
}
