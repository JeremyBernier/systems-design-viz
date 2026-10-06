import { GENERATORS, CATEGORIES, grade, parse, inUnits } from './questions.js';
import { LATENCY, HARDWARE, SOURCE } from './reference.js';

// The estimation quiz page: one question at a time, a number and a unit for an answer, graded by
// how many times too high or too low the guess was, then the working. Questions and their
// arithmetic are in questions.js.

const app = document.getElementById('app');
// the question area is redrawn on every action; the reference below it is drawn once, so it stays open
app.innerHTML = '<div id="top"></div><div id="ref"></div>';
const top = document.getElementById('top');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const VERDICT = { hit: '✓ Correct', near: '✕ Wrong, but in the right ballpark', miss: '✕ Wrong' };

// which generator belongs to which category, worked out once
const BY_CAT = GENERATORS.map((make) => {
  const { cat, level } = make();
  return { make, cat, level };
});
const LEVEL = { 1: 'Warm-up', 2: 'Scenario', 3: 'Several steps' };
const store = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem('quiz-' + k)) ?? d;
    } catch {
      return d; // private window, or storage blocked: the quiz works without it
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('quiz-' + k, JSON.stringify(v));
    } catch {
      // not saved
    }
  },
};

const state = {
  cats: new Set(store.get('types', CATEGORIES).filter((c) => CATEGORIES.includes(c))),
  queue: [],
  lap: 0, // how many times the whole set has been gone through
  q: null,
  result: null, // { guess, unit, ...grade() } once answered
  hint: false,
  error: '',
  draft: '',
  unit: 0,
  stats: { done: 0, hit: 0, near: 0, streak: 0 },
  best: store.get('best', 0),
};
if (!state.cats.size) state.cats = new Set(CATEGORIES);

function next() {
  if (!state.queue.length) {
    // Every question type once before any repeats. The first time through goes easiest first:
    // single conversions, then short scenarios, then multi-step ones. After that they are mixed.
    const pool = BY_CAT.filter((g) => state.cats.has(g.cat)).map((g) => ({ g, r: Math.random() }));
    pool.sort((a, b) => (state.lap ? 0 : a.g.level - b.g.level) || a.r - b.r);
    state.queue = pool.map((x) => x.g);
    state.lap++;
  }
  state.q = state.queue.shift().make();
  state.result = null;
  state.hint = false;
  state.error = '';
  state.draft = '';
  // start on the smallest unit so that the unit is part of the estimate, not a giveaway
  state.unit = 0;
  render();
  document.getElementById('guess')?.focus();
}

function check() {
  const { q } = state;
  const value = parse(state.draft);
  if (!(value > 0)) {
    state.error = 'Enter a number, such as 4, 250, 4k or 1.5 million.';
    render();
    document.getElementById('guess')?.focus();
    return;
  }
  const guess = value * q.units[state.unit][1];
  const g = grade(guess, q.answer, q.tol);
  state.result = { guess, ...g };
  state.error = '';
  const s = state.stats;
  s.done++;
  if (g.grade === 'hit') s.hit++;
  if (g.grade === 'near') s.near++;
  s.streak = g.grade === 'hit' ? s.streak + 1 : 0;
  if (s.streak > state.best) store.set('best', (state.best = s.streak));
  render();
  document.getElementById('next')?.focus();
}

const show = (q, v) => (q.show ? q.show(v) : inUnits(v, q.units, 3));

function card() {
  const { q, result } = state;
  const single = q.units.length === 1;
  const unit = single
    ? `<span class="unit">${esc(q.units[0][0])}</span>`
    : `<select id="unit" aria-label="Unit"${result ? ' disabled' : ''}>${q.units.map((u, i) => `<option value="${i}"${i === state.unit ? ' selected' : ''}>${esc(u[0])}</option>`).join('')}</select>`;
  let after = '';
  if (result) {
    const times = result.factor >= 100 ? Math.round(result.factor).toLocaleString('en-US') : parseFloat(result.factor.toFixed(1));
    const detail = result.factor < 1.05 ? 'Spot on.' : `Your answer was ${times}× too ${result.high ? 'high' : 'low'}${result.grade === 'hit' ? ', which is close enough for an estimate' : ''}.`;
    after = `
      <div class="verdict" data-grade="${result.grade}" role="status">
        <b>${VERDICT[result.grade]}</b>
        <dl><dt>Correct answer</dt><dd>${esc(show(q, q.answer))}</dd><dt>Your answer</dt><dd>${esc(show(q, result.guess))}</dd></dl>
        <span>${detail}</span>
      </div>
      <div class="work"><h2>Working</h2><ol>${q.steps.map((s) => `<li>${s}</li>`).join('')}</ol><p>${q.takeaway}</p></div>
      <div class="row"><button id="next" class="primary">Next question</button></div>`;
  } else {
    after = `
      ${state.error ? `<p class="note" role="alert">${state.error}</p>` : ''}
      <div class="row"><button id="check" class="primary">Check</button><button id="hint">${state.hint ? 'Hide hint' : 'Show a hint'}</button><button id="skip" class="quiet">Skip</button></div>
      ${state.hint ? `<p class="hint">${q.hint}</p>` : ''}
      <p class="note">An estimate within ${q.tol && q.tol < 2 ? Math.round((q.tol - 1) * 100) + '%' : `${q.tol || 2}×`} of the answer counts as correct.</p>`;
  }
  return `<section class="card" aria-live="polite">
    <div class="cat">${esc(q.cat)} · ${LEVEL[q.level]}</div>
    <p class="q">${q.q}</p>
    <div class="answer"><input id="guess" type="text" inputmode="decimal" autocomplete="off" placeholder="Your estimate" aria-label="Your estimate" value="${esc(state.draft)}"${result ? ' disabled' : ''}${state.error ? ' aria-invalid="true"' : ''} />${unit}</div>
    ${after}
  </section>`;
}

function render() {
  const s = state.stats;
  top.innerHTML = `
    <a href="./">← Back to the simulator</a>
    <h1>Numbers quiz</h1>
    <p class="lede">The conversions you actually do in a system design interview, starting with the single-step ones and building up. Work each one out in your head or on paper, then type a number. An answer within a factor of two counts as correct: nobody needs the third digit. After each one you are told whether you were right, the correct answer, and how to get it.</p>
    <div class="score" aria-label="Score">
      <div><b>${s.done}</b>answered</div><div><b>${s.hit}</b>correct</div><div><b>${s.done - s.hit}</b>wrong</div><div><b>${s.streak}</b>streak · best ${state.best}</div>
    </div>
    <div class="cats" role="group" aria-label="Question types">${CATEGORIES.map((c) => `<button data-cat="${esc(c)}" aria-pressed="${state.cats.has(c)}">${esc(c)}</button>`).join('')}</div>
    ${card()}`;
}

document.getElementById('ref').innerHTML = `
    <details><summary>Numbers worth knowing by heart</summary>
      <ul>
        <li><b>A day ≈ 10⁵ seconds</b> (86,400). Per second × 100,000 ≈ per day; 1 million a day ≈ 12 a second.</li>
        <li><b>A year = 365 days</b>, or 8,760 hours. For a year of data, multiply a day's by about 400.</li>
        <li><b>8 bits in a byte.</b> 1 Gbps carries 125 MB a second.</li>
        <li><b>Thousands:</b> kB → MB → GB → TB → PB, each 1,000 times the last. A million × 1 kB = 1 GB; a billion × 1 kB = 1 TB.</li>
        <li><b>2¹⁰ ≈ 10³</b>, so 2³² ≈ 4 billion and 2⁶⁴ ≈ 1.8 × 10¹⁹.</li>
        <li><b>Peak ≈ 2 to 5 × average.</b> Size for the peak, and keep servers at 50–70% busy.</li>
      </ul>
    </details>
    <details><summary>How long things take</summary>
      <table>${LATENCY.map(([what, , shown, why]) => `<tr><th>${what}</th><td><b>${shown}</b></td><td>${why}</td></tr>`).join('')}</table>
    </details>
    <details><summary>How big one machine can be</summary>
      <table>${HARDWARE.map(([name, has, why]) => `<tr><th>${name}</th><td><b>${has}</b></td><td>${why}</td></tr>`).join('')}</table>
      <p class="note">Latencies are the widely quoted "latency numbers every programmer should know", rounded to a power of ten; they vary with hardware. Machine sizes and datacenter latencies follow the free section of <a href="${SOURCE}" target="_blank" rel="noopener">Hello Interview: Numbers to Know</a>.</p>
    </details>`;

app.addEventListener('click', (e) => {
  const id = e.target.closest('button')?.id;
  const cat = e.target.closest('[data-cat]')?.dataset.cat;
  if (cat) {
    // toggling a type changes which questions come next; the current one stays
    if (state.cats.has(cat) && state.cats.size > 1) state.cats.delete(cat);
    else state.cats.add(cat);
    store.set('types', [...state.cats]);
    state.queue = [];
    state.lap = 0; // start the new selection from its easiest questions
    render();
  } else if (id === 'check') check();
  else if (id === 'next' || id === 'skip') next();
  else if (id === 'hint') {
    state.hint = !state.hint;
    render();
    document.getElementById('guess')?.focus();
  }
});
app.addEventListener('input', (e) => {
  if (e.target.id === 'guess') state.draft = e.target.value;
});
app.addEventListener('change', (e) => {
  if (e.target.id === 'unit') state.unit = +e.target.value;
});
app.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'guess') check();
});

next();
