// Static assets and media: the CDN edge, its origin (object storage), and the
// fallback path through the load balancer and web servers when there is no CDN.
// No rendering. Called from Sim.step; all state lives on the cdn / blob nodes and sim.assets.
//
// Dynamic API requests (the existing client → load balancer path) are untouched.
// They are assumed to be on their own hostname, so they do not pass through the CDN.

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const ease = (cur, target, dt, tau = 0.3) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

// Shape of the asset traffic. Presets override all but the TTL (see presets.js).
export const ASSET_DEFAULTS = {
  assetsPerReq: 2, // static / media objects fetched per API request (after browser caching)
  assetKB: 20, // average object size on the wire, kB
  assetObjects: 5e6, // distinct objects in the bucket to begin with
  uploadPct: 5, // % of writes that upload an object (the rest are likes, comments, settings…)
  uploadKB: 500, // bytes stored per upload, kB (all sizes / renditions)
  cdnTTL: 86400, // seconds an object stays cached at the edge; 24 h is CloudFront's default TTL
};

// Running totals for the header, the detail panels and cost.js. Rates are eased, bytes are per second.
export const newAssetStats = () => ({ want: 0, ok: 0, err: 0, edgeBytes: 0, fillBytes: 0, originBytes: 0, upBytes: 0 });

const CACHEABLE = 0.99; // a little traffic is always uncacheable, private or revalidated
const WARM_SECS = 20; // time for a cold edge to refill at normal load (compressed, like the cache's 10 s)
const EULER = 0.58;

// How many of the bucket's objects stay cached at the edge. Popularity is roughly Zipf:
// the i-th most popular of N objects draws 1/(i·H) of requests, H ≈ ln N + 0.58. An object
// stays cached while it is requested at least once per TTL, which holds for the top rate·TTL/H.
export function hotSet(rate, ttl, objects) {
  const N = Math.max(objects, 2);
  return clamp((rate * ttl) / (Math.log(N) + EULER), 0, N);
}

// Steady-state edge hit ratio: the share of requests that go to the hot set, H(k) / H(N).
// So it rises with TTL and with traffic, and falls as the catalogue's long tail grows.
// (One shared cache is assumed; real CDNs split traffic over many locations, which lowers it.)
export function edgeHitRatio(rate, ttl, objects) {
  const k = hotSet(rate, ttl, objects);
  if (k < 1) return 0;
  return CACHEABLE * clamp((Math.log(k) + EULER) / (Math.log(Math.max(objects, 2)) + EULER));
}

export function fmtTTL(s) {
  if (s < 90) return parseFloat(s.toFixed(1)) + ' s';
  if (s < 5400) return Math.round(s / 60) + ' min';
  if (s < 172800) return parseFloat((s / 3600).toFixed(1)) + ' h';
  return parseFloat((s / 86400).toFixed(1)) + ' days';
}

// One step of the asset model. `incoming` is the API request rate; `nic` is NIC_BPS.
// Fills in the cdn and blob nodes, sim.assets and their flows, and leaves `_assetBps`
// on the load balancer and web servers for addAssetLoad() to pick up.
export function assetTraffic(sim, incoming, dt, nic) {
  const p = sim.params;
  const N = sim.nodes;
  const E = sim.edges;
  const f = sim.flows;
  const A = sim.assets;
  const off = (n) => n.down || !n.active;
  const { client, lb, cdn, blob } = N;
  const size = p.assetKB * 1e3; // bytes per object
  const bits = size * 8;
  const want = incoming * p.assetsPerReq; // objects / s the clients ask for
  const blobUp = !off(blob);
  const viaCdn = !off(cdn) && E.has('client>cdn');

  // ---- uploads: a share of the writes each web server served last step puts an object in the bucket
  const upBits = p.uploadKB * 8e3;
  let puts = 0;
  for (const w of sim.webs) {
    w._up = blobUp && !off(w) && E.has(`${w.id}>blob`) ? w.outRate * (p.writePct / 100) * (p.uploadPct / 100) : 0;
    puts += w._up;
  }
  const upBytes = (puts * upBits) / 8;

  // ---- edge: hits are served from the CDN, misses are fetched from the origin and then cached
  let hits = 0;
  let fills = 0;
  let edgeErr = 0;
  const origin = blobUp && E.has('cdn>blob');
  if (viaCdn) {
    cdn.hitRatio = edgeHitRatio(want, p.cdnTTL, blob.objects);
    hits = want * cdn.hitRatio * cdn.warm;
    fills = origin ? want - hits : 0;
    edgeErr = want - hits - fills;
    // refills as misses are fetched; with no origin, cached objects simply expire
    cdn.warm = origin ? clamp(cdn.warm + (dt * clamp(fills / 100)) / WARM_SECS) : clamp(cdn.warm - dt / p.cdnTTL);
  } else {
    cdn.warm = 0; // an edge that is not serving comes back empty
    cdn.hitRatio = 0;
  }

  // ---- no CDN: every asset is requested from the origin, through the load balancer and web servers.
  // Requests cost them little CPU, but the bytes go through their network cards, which is the limit.
  const direct = viaCdn ? 0 : want;
  const alive = sim.webs.filter((w) => !off(w) && E.has(`lb>${w.id}`));
  const lbOk = !off(lb) && E.has('client>lb') && alive.length > 0;
  const share = lbOk ? direct / alive.length : 0;
  let served = 0;
  let asked = 0; // objects / s that reach a server able to fetch them
  for (const w of sim.webs) {
    if (off(w)) w._apiBps = 0;
    const room = Math.max(0, nic.web - (w._apiBps || 0) - w._up * upBits);
    const mine = alive.includes(w) ? share : 0;
    const wired = blobUp && E.has(`${w.id}>blob`); // a server with no route to the bucket answers 404
    w._got = wired ? Math.min(mine, bits > 0 ? room / bits : mine) : 0;
    w._nicUtil = ((w._apiBps || 0) + w._up * upBits + (wired ? mine * bits : 0)) / nic.web;
    served += w._got;
    asked += wired ? mine : 0;
  }
  // the load balancer's own card carries everything the web tier sends back
  const lbRoom = Math.max(0, nic.lb - (lb._apiBps || 0) - upBytes * 8);
  const squeeze = served * bits > lbRoom ? lbRoom / (served * bits) : 1;
  served *= squeeze;
  for (const w of sim.webs) {
    w._got *= squeeze;
    w._assetBps = off(w) ? 0 : w._got * bits + w._up * upBits;
    f[`${w.id}>blob`] = w._got + w._up;
    f[`${w.id}>blob<`] = w._got;
  }
  lb._assetBps = lbOk ? served * bits + upBytes * 8 : 0;
  lb._nicUtil = lbOk ? ((lb._apiBps || 0) + upBytes * 8 + asked * bits) / nic.lb : 0;

  // ---- CDN node
  const edgeOut = hits + fills; // objects / s delivered to users from the edge
  cdn.inRate = viaCdn ? want : 0;
  cdn.outRate = ease(cdn.outRate, edgeOut, dt, 0.15);
  cdn.missRate = fills;
  cdn.dropRate = ease(cdn.dropRate, edgeErr, dt, 0.15);
  cdn.hit = cdn.hitRatio * cdn.warm;
  cdn.edgeBytes = ease(cdn.edgeBytes, edgeOut * size, dt);
  cdn.storedGB = (hotSet(want, p.cdnTTL, blob.objects) * cdn.warm * size) / 1e9; // what the edge is holding
  cdn.bps = (edgeOut + fills) * bits; // out to users + in from the origin
  cdn.util = cdn.bps / nic.cdn;
  cdn.cpu = cdn.mem = cdn.disk = 0;
  cdn.latency = viaCdn && want > 0 ? 0.02 + 0.18 * (1 - hits / want) : 0; // edge hit ≈ 20 ms, origin fetch ≈ 200 ms
  cdn.stress = 0;
  const hitPct = Math.round(cdn.hit * 100);
  cdn.status = off(cdn)
    ? 'Down. Every image, script and video is now requested from your origin, through the load balancer and web servers.'
    : !viaCdn
      ? 'Clients are not pointed at it, so they fetch every asset from your origin instead.'
      : !origin
        ? `Origin unreachable. The edge keeps serving what it has cached (${hitPct}% of requests) until the TTL expires; every miss fails with 502.`
        : cdn.warm < 0.6
          ? `Cold edge: only ${hitPct}% of requests hit. The rest are fetched from object storage, so origin traffic and the transfer bill spike until it warms up.`
          : `Warm. ${hitPct}% of asset requests are served from the edge near the user and never touch your infrastructure.`;

  // ---- object storage node
  const gets = fills + served;
  if (blobUp) {
    blob.storedGB += (upBytes * dt) / 1e9;
    if (size > 0) blob.objects += (upBytes * dt) / size;
  }
  blob.getRate = gets;
  blob.putRate = puts;
  blob.inRate = gets + puts;
  blob.outRate = ease(blob.outRate, gets, dt, 0.15);
  blob.dropRate = 0;
  blob.bps = blobUp ? gets * bits + upBytes * 8 : 0;
  blob.diskIO = blobUp ? gets * size + upBytes : 0;
  blob.util = blob.bps / nic.blob;
  blob.cpu = blob.mem = blob.disk = 0;
  blob.latency = 0.03;
  blob.stress = 0;
  blob.status = !blobUp
    ? 'Outage. Nothing is lost, but uploads fail and the CDN can only serve what is already cached at the edge.'
    : direct > 0
      ? 'No CDN in front: every asset request is read from here by a web server and streamed to the user.'
      : cdn.warm < 0.6 && fills > 1
        ? 'The CDN is cold, so almost every asset request is a miss that lands here.'
        : `Healthy. Only CDN misses (${Math.round((want > 0 ? fills / want : 0) * 100)}% of asset requests) and uploads reach it.`;

  // ---- totals, client bandwidth and flows
  const ok = edgeOut + served;
  A.want = ease(A.want, want, dt, 0.2);
  A.ok = ease(A.ok, ok, dt);
  A.err = ease(A.err, Math.max(0, want - ok), dt);
  A.edgeBytes = cdn.edgeBytes;
  A.fillBytes = ease(A.fillBytes, fills * size, dt);
  A.originBytes = ease(A.originBytes, served * size, dt); // left your cloud through the web tier
  A.upBytes = ease(A.upBytes, upBytes, dt);
  client.bps += ok * bits + upBytes * 8;
  f['client>cdn'] = cdn.inRate;
  f['client>cdn<'] = edgeOut;
  f['client>cdn!'] = edgeErr;
  f['cdn>blob'] = f['cdn>blob<'] = fills;
}

// Hook for the load balancer and each web server, called once its own bps is known:
// adds the asset bytes that are passing through it, and flags a saturated network card.
export function addAssetLoad(node) {
  node._apiBps = node.bps;
  node.bps += node._assetBps || 0;
  if (!(node._nicUtil > node.util)) return; // the network, not the CPU, is its tightest resource
  node.util = node._nicUtil;
  if (node.util < 1) return;
  node.status =
    node.type === 'web'
      ? 'Network card saturated: with no CDN it is streaming every image and video itself. CPU is idle, but asset requests beyond the link speed fail.'
      : 'Network link saturated: with no CDN, every byte of every asset passes through here on its way to the user.';
}
