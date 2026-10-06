import { SPECS, NIC_BPS, WORKLOAD, fmtBits, fmtGB } from './sim.js';
import { CACHE_NODE_CAP } from './datatier.js';
import { LATENCY, HARDWARE, SOURCE } from './quiz/reference.js';

// "Numbers": the handful of figures that back-of-envelope estimates are built from. A dialog opened
// from the Learn row. Reading only. The quiz that drills them is a page of its own (quiz.html); the
// dialog links to it, and says that the link leaves this page.
//
// The latency and machine-size figures, and their sources, are in quiz/reference.js, which the quiz
// page shows too. Everything under "The machines in this simulator" is read from sim.js / tech.js /
// datatier.js when the dialog is drawn.

const $ = (id) => document.getElementById(id);
const sig = (v, n = 2) => Number(v.toPrecision(n)).toLocaleString('en-US');

export function initNumbers(sim) {
  const dlg = document.createElement('dialog');
  dlg.id = 'numbers';
  dlg.className = 'dlg';
  dlg.innerHTML = `
    <form method="dialog" class="pl-head"><div><h3><span class="learn-tag">Learn</span>Numbers to know</h3><p class="hint">Estimating a system means multiplying a few remembered figures. They only need to be right to the nearest power of ten.</p></div><button aria-label="Close">✕</button></form>
    <a class="nm-quizlink" href="quiz.html"><span><b>Quiz yourself on these</b><small>Opens the quiz page. You will leave the simulator; the page has a link back.</small></span><i aria-hidden="true">Go to the quiz page →</i></a>
    <div class="dg-body" id="nm-body"></div>`;
  document.body.append(dlg);

  const learn = () => {
    const lo = Math.log10(LATENCY[0][1]);
    const hi = Math.log10(LATENCY[LATENCY.length - 1][1]);
    const db = sim.techOf('db');
    const lb = sim.techOf('lb');
    const kafka = sim.techOf('kafka');
    const gbps = (t) => fmtBits(NIC_BPS[t]);
    const model = [
      ['Web server', `${SPECS.web.cores} vCPUs · ${fmtGB(SPECS.web.ramGB)} · ${gbps('web')}`, `${sig(WORKLOAD.webRps)} requests/s (≈ ${sig((SPECS.web.cores / WORKLOAD.webRps) * 1e3)} ms of CPU each)`],
      ['Worker', `${SPECS.worker.cores} vCPUs · ${fmtGB(SPECS.worker.ramGB)} · ${gbps('worker')}`, `${sig(WORKLOAD.jobRate)} jobs/s`],
      ['Cache node', `${SPECS.cache.cores} vCPUs · ${fmtGB(SPECS.cache.ramGB)} · ${gbps('cache')}`, `${sig(CACHE_NODE_CAP)} lookups/s`],
      [`Database (${db.name})`, `${(db.spec || SPECS.db).cores || '—'} vCPUs · ${fmtGB((db.spec || SPECS.db).ramGB)} · ${gbps('db')}`, `${sig(db.cap)} reads/s; a write costs ${db.writeCost === 1 ? 'the same' : db.writeCost + ' reads'}`],
      [`Load balancer (${lb.name})`, gbps('lb'), `${sig(lb.cap)} requests/s`],
      [`Event stream (${kafka.name})`, `${SPECS.kafka.cores} vCPUs · ${gbps('kafka')}`, `${sig(kafka.cap)} events/s`],
    ];
    return `
      <section><h2>How long things take</h2>
        <p class="d-about">Each step down this list is ten to a thousand times slower than the one above. The bars are on a logarithmic scale; on a linear one, everything but the last row would be invisible.</p>
        <div class="nm-lat">${LATENCY.map(([what, s, shown, why]) => `<div class="nm-row"><span>${what}</span><b>${shown}</b><i style="width:${Math.max(2, ((Math.log10(s) - lo) / (hi - lo)) * 100)}%"></i><small>${why}</small></div>`).join('')}</div>
      </section>
      <section><h2>How big one machine can be</h2>
        <p class="d-about">Hardware has grown faster than most intuitions about it. Before deciding that something needs many machines, check that it would not fit on one.</p>
        <div class="dg-scroll"><table class="dg-table"><tbody>${HARDWARE.map(([a, b, c]) => `<tr><th>${a}</th><td><b>${b}</b></td><td>${c}</td></tr>`).join('')}</tbody></table></div>
      </section>
      <section><h2>The machines in this simulator</h2>
        <p class="d-about">Mid-sized instances, which is why they are easy to overload. The network figure is the sustained baseline AWS publishes for that instance size; each can burst to 10 Gbps for a short while. Throughput is this model's assumption for the technology currently selected: measure your own with a load test.</p>
        <div class="dg-scroll"><table class="dg-table"><thead><tr><th>Component</th><th>Machine</th><th>Handles, before it saturates</th></tr></thead><tbody>${model.map(([a, b, c]) => `<tr><th>${a}</th><td>${b}</td><td>${c}</td></tr>`).join('')}</tbody></table></div>
      </section>
      <section><h2>Shortcuts for estimating</h2>
        <ul class="tips">
          <li><b>A day is about 10⁵ seconds</b> (86,400). So 1 million a day ≈ 12 a second, and 1 billion a day ≈ 12,000 a second.</li>
          <li><b>A month is about 2.6 million seconds</b>, which is why $0.10 an hour is about $73 a month.</li>
          <li><b>Bits and bytes differ by 8.</b> 1 Gbps = 125 MB/s.</li>
          <li><b>Each "nine" of availability is ten times stricter.</b> Per 30-day month: 99% allows 7.2 hours of downtime, 99.9% 43 minutes, 99.99% 4.3 minutes.</li>
          <li><b>Sizes to carry around:</b> a database row ≈ 1 kB, a compressed photo ≈ 200 kB, a few seconds of video ≈ 1.5 MB. These are the figures the preset systems here use.</li>
          <li><b>Peak is a multiple of average.</b> Size for the peak, then leave headroom: servers at 50–70% busy, plus one spare.</li>
        </ul>
      </section>
      <p class="hint">Latencies are the widely quoted "latency numbers every programmer should know", rounded to a power of ten; they vary with hardware. Machine sizes and datacenter latencies follow the free section of <a href="${SOURCE}" target="_blank" rel="noopener">Hello Interview: Numbers to Know</a>, and match AWS's published instance specifications.</p>`;
  };

  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close()); // click on the backdrop
  // Esc closes the dialog natively; keep it from also reaching the app's own Esc handler
  dlg.addEventListener('keydown', (e) => e.key === 'Escape' && e.stopPropagation());
  $('numbers-open').addEventListener('click', () => {
    $('nm-body').innerHTML = learn();
    dlg.showModal();
    $('nm-body').scrollTop = 0;
  });
}
