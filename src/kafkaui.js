import './dbguide.css';
import './kafka.css';
import { CONCEPTS, KEY_RULES, KEY_EXAMPLES, HOT_KEYS, OTHER_SYSTEMS, KEY_CHOICES, PARTITION_CHOICES, keyModel, QUIZ } from './kafka.js';

// The Kafka deep dive: core concepts, choosing a partition key (with a model to try keys on), and
// questions to check yourself. Opened from the Learn row, or from the detail panel of the event
// stream and the components that read it. Reading only: it changes nothing in the simulation.

const $ = (id) => document.getElementById(id);
const list = (items) => `<ul>${items.map((s) => `<li>${s}</li>`).join('')}</ul>`;
const pct = (v) => Math.round(v * 100) + '%';
const TABS = [
  ['concepts', 'Core concepts'],
  ['keys', 'Choosing a partition key'],
  ['quiz', 'Check yourself'],
];

export function initKafkaUI() {
  const dlg = document.createElement('dialog');
  dlg.id = 'kafka';
  dlg.className = 'dlg';
  dlg.innerHTML = `
    <form method="dialog" class="pl-head"><div><h3><span class="learn-tag">Learn</span>Kafka deep dive</h3><p class="hint">A log that many readers share. Most of what is hard about Kafka follows from one fact: records are ordered within a partition, and nowhere else.</p></div><button aria-label="Close">✕</button></form>
    <div class="seg dg-tabs" role="group" aria-label="Section">${TABS.map(([k, t]) => `<button data-tab="${k}">${t}</button>`).join('')}</div>
    <div class="dg-body" id="kf-body"></div>`;
  document.body.append(dlg);
  let tab = 'concepts';
  const play = { key: 'trip', parts: 6 };
  let picked = {}; // question index → chosen option
  let order = QUIZ.map((q) => shuffled([q[1], ...q[2]]));

  const topic = (t) => `<section class="dg-concept" id="kf-${t.id}">
      <h2>${t.title}</h2><p class="dg-one">${t.one}</p>
      ${t.what.map((p) => `<p class="d-about">${p}</p>`).join('')}
      <div class="dg-pc"><div class="dg-pro"><b>What it gets you</b>${list(t.pros)}</div><div class="dg-con"><b>What it costs you</b>${list(t.cons)}</div></div>
      <p class="dg-try${t.sim && !t.partial ? '' : ' none'}"><b>In the simulator:</b> ${t.sim || 'Not modelled here.'}</p>
    </section>`;

  const playground = () => {
    const m = keyModel(play.key, play.parts);
    const choice = KEY_CHOICES.find((c) => c.id === play.key);
    const even = 1 / play.parts;
    const scale = Math.max(...m.share, even) * 1.05;
    const balanced = m.hottest < 1.15;
    const empty = m.share.filter((s) => s === 0).length;
    const verdict =
      play.key === 'none'
        ? 'Perfectly even, and no ordering at all: a trip\'s four events are scattered, so a consumer can see "completed" before "started". Fine for counting events; wrong for anything that follows a trip.'
        : !balanced && m.tripOrder > 0.99
          ? `Ordering is kept, but there are only ${m.keys} distinct keys and they are far from equal, so the busiest partition carries ${m.hottest.toFixed(1)}× its share. Its consumer falls behind while others idle.`
          : !balanced
            ? `Only ${m.keys} distinct keys, so ${empty ? `${empty} of the ${play.parts} partitions stay empty` : 'the load is uneven'}, and a trip's events are split between partitions, losing their order. The worst of both.`
            : m.driverOrder > 0.99
              ? 'Even load, and everything about one driver, including each of their trips, stays in order. A good key if consumers keep per-driver state.'
              : 'Even load, and each trip\'s events stay in order. A driver\'s successive trips may be in different partitions, which matters only if a consumer needs order across trips.';
    return `<div class="kf-play">
      <p class="d-about">A model stream of ${m.records.toLocaleString()} ride-hailing events: each trip emits <i>requested, accepted, started, completed</i>, belongs to one driver, and each driver works in one city. A few cities are much busier than the rest. Pick a key and see where the records land.</p>
      <div class="kf-pick"><span>Partition key</span>${KEY_CHOICES.map((c) => `<button data-key="${c.id}" aria-pressed="${c.id === play.key}">${c.label}</button>`).join('')}</div>
      <div class="kf-pick"><span>Partitions</span>${PARTITION_CHOICES.map((n) => `<button data-parts="${n}" aria-pressed="${n === play.parts}">${n}</button>`).join('')}</div>
      <div class="kf-bars" role="img" aria-label="Share of records in each partition">${m.share
        .map((s, i) => `<div class="kf-bar"><span>P${i}</span><div><i style="width:${(s / scale) * 100}%" data-hot="${s > even * 1.15}"></i><u style="left:${(even / scale) * 100}%"></u></div><span>${pct(s)}</span></div>`)
        .join('')}</div>
      <p class="hint">The white mark is an even share (${pct(even)}).${choice.key ? ` ${m.keys.toLocaleString()} distinct keys.` : ''}</p>
      <div class="kf-facts">
        <div data-ok="${balanced}"><b>${m.hottest.toFixed(2)}×</b>busiest partition, against an even share</div>
        <div data-ok="${m.tripOrder > 0.99}"><b>${pct(m.tripOrder)}</b>of trips have all their events in one partition</div>
        <div data-ok="${m.driverOrder > 0.99}"><b>${pct(m.driverOrder)}</b>of drivers have all their events in one partition</div>
      </div>
      <p class="kf-verdict">${verdict}</p>
    </div>`;
  };

  const views = {
    concepts: () => `<nav class="dg-nav" aria-label="Topics">${CONCEPTS.map((t) => `<button data-jump="kf-${t.id}">${t.title}</button>`).join('')}</nav>` + CONCEPTS.map(topic).join('') + `<p class="hint">${OTHER_SYSTEMS}</p>`,
    keys: () => `
      <section><h2>What the key decides</h2>
        <p class="dg-one">The partition key decides two things at once: which records are kept in order, and how evenly the load is spread. A good key gets both.</p>
        <p class="d-about">The producer sends a record to partition <code>hash(key) mod partitions</code>. Records with the same key therefore share a partition and keep their order. Records with different keys may or may not share one, and you should assume nothing about their order.</p>
      </section>
      <section><h2>Try it</h2>${playground()}</section>
      <section><h2>How to choose</h2><ol class="kf-rules">${KEY_RULES.map(([t, d]) => `<li><b>${t}.</b> ${d}</li>`).join('')}</ol></section>
      <section><h2>Examples</h2>
        <div class="dg-scroll"><table class="dg-table dg-glance"><thead><tr><th>System</th><th>Must stay in order</th><th>Good key</th><th>Tempting, and what goes wrong</th></tr></thead>
        <tbody>${KEY_EXAMPLES.map(([sys, ord, good, why, bad, wrong]) => `<tr><th style="white-space:normal">${sys}</th><td>${ord}</td><td><b>${good}</b><br>${why}</td><td><b class="kf-bad">${bad}</b><br>${wrong}</td></tr>`).join('')}</tbody></table></div>
      </section>
      <section><h2>When one key is too big</h2>
        <p class="d-about">Sometimes the right key for ordering has an outlier: one tenant, one celebrity, one device that never stops talking. In rough order of preference:</p>
        <ol class="kf-rules">${HOT_KEYS.map(([t, d]) => `<li><b>${t}.</b> ${d}</li>`).join('')}</ol>
      </section>
      <p class="hint">${OTHER_SYSTEMS}</p>`,
    quiz: () => {
      const done = Object.keys(picked).length;
      const right = QUIZ.filter((q, i) => picked[i] === q[1]).length;
      return (
        `<p class="hint">${done < QUIZ.length ? `${QUIZ.length} questions on documented Kafka behaviour. ${done} answered, ${right} correct.` : `Finished: ${right} of ${QUIZ.length} correct.`} <button data-act="reset">Start again</button></p>` +
        QUIZ.map(([q, ans, , why], i) => {
          const mine = picked[i];
          return `<div class="kf-quiz"><p class="nm-q"><b>${i + 1}.</b> ${q}</p><div class="nm-choices">${order[i]
            .map((c, j) => `<button data-q="${i}" data-c="${j}"${mine ? ' disabled' : ''}${mine && c === ans ? ' data-mark="right"' : mine === c ? ' data-mark="wrong"' : ''}>${c}${mine && c === ans ? ' ✓' : mine === c ? ' ✕' : ''}</button>`)
            .join('')}</div>${mine ? `<div class="nm-why" data-ok="${mine === ans}"><b>${mine === ans ? 'Correct.' : 'Not quite.'}</b> ${why}</div>` : ''}</div>`;
        }).join('')
      );
    },
  };

  const render = (keepScroll = false) => {
    const body = $('kf-body');
    const top = body.scrollTop;
    for (const b of dlg.querySelectorAll('[data-tab]')) b.setAttribute('aria-pressed', b.dataset.tab === tab);
    body.innerHTML = views[tab]();
    body.scrollTop = keepScroll ? top : 0;
  };
  const open = (to = 'concepts') => {
    tab = to;
    render();
    dlg.showModal();
  };

  dlg.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation()); // Esc closes the guide only
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) return dlg.close(); // the backdrop
    const at = (sel) => e.target.closest(sel);
    let b;
    if ((b = at('[data-jump]'))) return document.getElementById(b.dataset.jump).scrollIntoView({ block: 'start' });
    if ((b = at('[data-tab]'))) {
      tab = b.dataset.tab;
      return render();
    }
    if ((b = at('[data-key]'))) play.key = b.dataset.key;
    else if ((b = at('[data-parts]'))) play.parts = +b.dataset.parts;
    else if ((b = at('[data-q]'))) picked[b.dataset.q] = order[b.dataset.q][b.dataset.c];
    else if (at('[data-act="reset"]')) {
      picked = {};
      order = QUIZ.map((q) => shuffled([q[1], ...q[2]]));
    } else return;
    render(true);
  });

  // its button joins the Learn row (index.html)
  const btn = document.createElement('button');
  btn.id = 'kafka-open';
  btn.textContent = '📨 Kafka';
  btn.title = 'Topics, partitions, offsets, consumer groups, delivery guarantees, and choosing a partition key';
  $('learnbar').append(btn);
  btn.addEventListener('click', () => open());
  // …and the detail panel of the event stream and its readers has one too (ui.js draws it)
  $('detail').addEventListener('click', (e) => e.target.closest('#d-kafka') && open());
}

function shuffled(xs) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
