import { WORKLOAD, WORKLOAD_INFO } from './sim.js';
import { PRICING, SPOT } from './tech.js';
import { PLAN_DEFAULTS, PLAN_FIELDS, plan, planContext, applyPlan, fmtNum, fmtSize } from './planner.js';

// UI for modelling your own system: the "Workload assumptions" fold in the left panel,
// the pricing-model picker above the cost breakdown, and the "Plan from users" dialog.
// Kept out of ui.js so it stays one self-contained block.

const $ = (id) => document.getElementById(id);
const tidy = (v) => String(parseFloat(v.toPrecision(4)));
const LEVEL_WORD = { ok: 'Fits', warn: 'Tight', bad: 'Over capacity' };

// ---------------------------------------------------------------- pricing model
// Rendered inside the cost breakdown, which ui.js rebuilds whenever the overview is shown.
export function pricingHTML() {
  return (
    `<label class="engine">Pricing<select id="pricing">${Object.entries(PRICING).map(([k, m]) => `<option value="${k}">${m.name}</option>`).join('')}</select></label>` +
    `<label class="row check" title="${SPOT.note}"><input type="checkbox" id="spotWorkers" /><span>Spot instances for workers</span></label>` +
    `<p class="hint" id="cost-note"></p>`
  );
}
export function syncPricing(sim) {
  const p = sim.params;
  if (!$('pricing')) return;
  if (document.activeElement !== $('pricing')) $('pricing').value = PRICING[p.pricing] ? p.pricing : 'ondemand';
  $('spotWorkers').checked = p.spotWorkers;
  const note = `Ballpark from public list prices (AWS / Google Cloud). ${(PRICING[p.pricing] || PRICING.ondemand).note} Per-request, per-GB and storage charges are never discounted.${p.spotWorkers ? ' ' + SPOT.note : ''}`;
  if ($('cost-note').textContent !== note) $('cost-note').textContent = note;
}

export function initModelUI(ui, sim) {
  const p = sim.params;

  // ---------------------------------------------------------------- workload assumptions
  const rows = $('workload-rows');
  rows.innerHTML = Object.entries(WORKLOAD_INFO)
    .map(([k, f]) => `<label class="row num" title="${f.tip}"><span>${f.label}</span><span><input type="number" data-k="${k}" min="${f.min}" max="${f.max}" step="any" /> ${f.unit}</span></label>`)
    .join('');
  const fields = [...rows.querySelectorAll('input')];
  const syncWorkload = () => {
    for (const el of fields) if (document.activeElement !== el) el.value = tidy(p[el.dataset.k] / WORKLOAD_INFO[el.dataset.k].scale);
    $('workload-edited').hidden = Object.keys(WORKLOAD).every((k) => p[k] === WORKLOAD[k]);
  };
  // 'change', not 'input': clamp once the user has finished typing
  rows.addEventListener('change', (e) => {
    const f = WORKLOAD_INFO[e.target.dataset.k];
    const v = +e.target.value;
    if (e.target.value !== '' && isFinite(v)) p[e.target.dataset.k] = Math.min(f.max, Math.max(f.min, v)) * f.scale;
    e.target.blur();
    syncWorkload();
  });
  $('workload-reset').addEventListener('click', () => {
    Object.assign(p, WORKLOAD);
    syncWorkload();
  });
  // every existing path that refreshes the controls (presets, reset, deep links) refreshes these too
  const sync = ui.syncControls;
  ui.syncControls = () => {
    sync();
    syncWorkload();
  };
  syncWorkload();

  // ---------------------------------------------------------------- pricing (events only; markup is pricingHTML)
  $('detail').addEventListener('change', (e) => {
    if (e.target.id === 'pricing') p.pricing = e.target.value;
    else if (e.target.id === 'spotWorkers') p.spotWorkers = e.target.checked;
    else return;
    syncPricing(sim);
  });

  // ---------------------------------------------------------------- capacity planner dialog
  const input = { ...PLAN_DEFAULTS, writePct: p.writePct };
  let current = null;
  const dlg = document.createElement('dialog');
  dlg.id = 'planner';
  dlg.className = 'dlg';
  dlg.innerHTML = `
    <form method="dialog" class="pl-head"><div><h3>Plan from users</h3><p class="hint">Start from product numbers, the way a system design interview or a real sizing exercise does. Every answer shows its arithmetic.</p></div><button aria-label="Close">✕</button></form>
    <div class="pl-body">
      <div class="pl-in">
        <h2>Your product</h2>
        ${PLAN_FIELDS.map(([k, label, unit, min, max]) => `<label class="row num"><span>${label}</span><span><input type="number" data-k="${k}" min="${min}" max="${max}" step="any" /> ${unit}</span></label>`).join('')}
        <p class="hint" id="pl-ctx"></p>
      </div>
      <div class="pl-out" id="pl-out"></div>
    </div>
    <div class="pl-foot"><span class="hint">Sets traffic to the peak, the write mix, web server and worker counts, and bytes stored per write. Technologies are left as you chose them.</span><button id="pl-apply">Apply to simulation</button></div>`;
  document.body.append(dlg);
  const inputs = [...dlg.querySelectorAll('.pl-in input')];
  const scaleOf = Object.fromEntries(PLAN_FIELDS.map((f) => [f[0], f]));

  const render = () => {
    const ctx = planContext(sim);
    const pl = (current = plan(input, ctx));
    $('pl-ctx').textContent = `Also uses your workload assumptions — ${fmtSize(p.reqBytes)} per request, ${Math.round(p.cacheHitRatio * 100)}% cache hits, ${tidy(p.jobFrac * 100)}% of requests enqueue a job, ${fmtSize(p.eventBytes)} per event — and the technologies currently in the diagram. Change those in the main view and reopen.`;
    $('pl-out').innerHTML =
      `<h2>Back-of-envelope estimate</h2>` +
      pl.estimate.map((e) => `<div class="pl-line"><span>${e.label}</span><b>${e.value}</b><small>${e.calc}</small></div>`).join('') +
      `<h2>Recommended sizing for the selected technologies</h2>` +
      pl.sizing
        .map(
          (s) =>
            `<div class="pl-size" data-level="${s.level}"><div class="pl-line"><span>${s.label} · ${s.tech}</span><b>${s.value}</b></div><em>${LEVEL_WORD[s.level]}</em><ul>${s.calc.map((c) => `<li>${c}</li>`).join('')}</ul>${s.note ? `<p class="hint">${s.note}</p>` : ''}</div>`
        )
        .join('') +
      (pl.flags.length ? `<h2>What the simulator cannot represent</h2><ul class="pl-flags">${pl.flags.map((f) => `<li>${f}</li>`).join('')}</ul>` : '') +
      `<p class="hint">Applying sets: ${fmtNum(pl.apply.params.traffic)} req/s, ${pl.apply.params.writePct}% writes, ${pl.apply.webs} web servers, ${pl.apply.params.workerCount} workers, ${fmtSize(pl.apply.params.writeBytes)} stored per write.</p>`;
  };
  for (const el of inputs) el.value = tidy(input[el.dataset.k] / scaleOf[el.dataset.k][5]);
  dlg.addEventListener('input', (e) => {
    const f = scaleOf[e.target.dataset.k];
    const v = +e.target.value;
    if (!f || e.target.value === '' || !isFinite(v)) return;
    input[f[0]] = Math.min(f[4], Math.max(f[3], v)) * f[5];
    render();
  });
  // Esc closes the dialog natively; keep it from also reaching the app's own Esc handler
  dlg.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation());
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close()); // click on the backdrop
  $('plan-open').addEventListener('click', () => {
    render();
    dlg.showModal();
  });
  $('pl-apply').addEventListener('click', () => {
    render(); // plan against the system as it is right now
    const flags = applyPlan(sim, current);
    for (const f of flags) sim.emit('log', 'warn', 'Plan: ' + f);
    ui.syncControls();
    dlg.close();
    const a = current.apply;
    ui.toast(
      `Plan applied: ${fmtNum(a.params.traffic)} req/s peak, ${a.webs} web servers, ${a.params.workerCount} workers.` + (flags.length ? ` ${flags.length} thing${flags.length > 1 ? 's' : ''} could not be represented — see the event log.` : ''),
      flags.length ? 'bad' : 'ok'
    );
  });
}
