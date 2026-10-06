import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MAX_WEB, NODE_INFO, fmtRate, fmtBits, fmtGB, rawMetric } from './sim.js';
import { logoSVG, logoCanvas } from './tech.js';

// Categorical flow colours (one per kind of traffic) and reserved status colours.
export const FLOW = {
  request: 0x3987e5,
  read: 0x199e70,
  write: 0xd95926,
  event: 0x9085e9,
  job: 0xc98500,
  query: 0xd55181,
  response: 0xb7d3f6,
  error: 0xe66767,
  asset: 0x9bc53d, // static assets and media
};
export const STATUS = { good: 0x0ca30c, warning: 0xfab219, serious: 0xec835a, critical: 0xd03b3b, down: 0x55554f };

export function loadLevel(util, down) {
  if (down) return 'down';
  if (util >= 1) return 'critical';
  if (util >= 0.85) return 'serious';
  if (util >= 0.6) return 'warning';
  return 'good';
}

const HEIGHT = { client: 2.2, lb: 1.2, web: 2.3, cache: 1.2, db: 2.1, kafka: 1.5, consumer: 1.6, queue: 1.1, worker: 1.4, lake: 1.6, clickhouse: 2.1, trino: 1.9, bi: 2.0 };
HEIGHT.cdn = 1.3;
HEIGHT.blob = 1.4;
HEIGHT.fn = 1.1;
HEIGHT.connector = 1.1;
HEIGHT.scheduler = 1.5;
// What each queue technology calls the same moving parts (used by the zoomed-in broker view).
const QUEUE_TERMS = {
  rabbitmq: { entry: 'Exchange', queue: 'Queue', ready: 'ready', flight: 'Unacked', done: 'acks' },
  redisq: { entry: null, queue: 'Redis list', ready: 'enqueued', flight: 'Busy', done: 'done' },
  sqs: { entry: null, queue: 'Queue', ready: 'visible', flight: 'In flight', done: 'deletes' },
  pubsub: { entry: 'Topic', queue: 'Subscription', ready: 'undelivered', flight: 'Outstanding', done: 'acks' },
};
const Q_SLOTS = 32; // message blocks the queue lane can show
// Components with an application view: what the software is doing, as an alternative to the hardware rig.
export const APP_VIEW = { queue: 'Queue', db: 'Database', fn: 'Function' };
const FN_TILES = 40; // execution environments the function view can show
// What each database engine calls its moving parts (used by the zoomed-in database view).
const BTREE = { table: 'Tables (heap)', index: 'B-tree indexes', log: 'WAL', pool: 'Shared buffers' };
const LSM = { table: 'Tables (SSTables)', index: 'Partition indexes', log: 'Commit log', pool: 'Memtables + cache' };
const DB_TERMS = {
  postgres: BTREE,
  rds: BTREE,
  cloudsql: BTREE,
  aurora: { ...BTREE, log: 'Redo log (shared storage)', pool: 'Buffer cache' },
  mysql: { table: 'Tables (clustered)', index: 'B+tree indexes', log: 'Redo log', pool: 'Buffer pool' },
  spanner: { table: 'Table splits', index: 'Indexes', log: 'Paxos log', pool: 'Block cache' },
  cassandra: LSM,
  bigtable: { ...LSM, table: 'Tablets (SSTables)', index: 'Row-key index' },
  dynamodb: { table: 'Table partitions', index: 'Key + secondary indexes', log: 'Replication log', pool: 'Storage-node cache' },
};
const OVERVIEW = { pos: new THREE.Vector3(6.5, 36, 27), target: new THREE.Vector3(6.5, 0, 4) };
const SIDE_PANELS = 620; // px of the window covered by the two side panels

const LANES = [
  { key: '', rev: false },
  { key: '<', rev: true, color: new THREE.Color(FLOW.response) },
  { key: '!', rev: true, color: new THREE.Color(FLOW.error) },
];

const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();

export class Scene {
  constructor(container, sim, { onSelect, onZoom, onPlace, onConnect }) {
    this.onZoom = onZoom;
    this.selectedId = null; // highlighted in the overview; zooming in (focusId) is a separate step
    this.onPlace = onPlace;
    this.onConnect = onConnect;
    this.placing = null; // id of the component being placed
    this.connecting = false;
    this.connectFrom = null;
    this.cursor = null; // pointer position on the floor
    this.sim = sim;
    this.container = container;
    this.onSelect = onSelect;
    this.focusId = null;
    this.hoverId = null;
    this.shake = 0;
    this.shocks = [];

    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color(0x0d0d0d);
    scene.fog = new THREE.Fog(0x0d0d0d, 70, 150);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camera.position.copy(OVERVIEW.pos);
    const controls = (this.controls = new OrbitControls(this.camera, renderer.domElement));
    controls.target.copy(OVERVIEW.target);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.minDistance = 3;
    controls.maxDistance = 110;
    controls.addEventListener('start', () => (this.tween = null));

    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1a19, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(8, 20, 12);
    scene.add(sun);

    const grid = new THREE.GridHelper(120, 60, 0x2c2c2a, 0x1c1c1b);
    grid.position.y = -0.01;
    scene.add(grid);

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'labels';
    // magnifying glass that sits beside the selected component's card: one click zooms inside
    this.zoomBtn = document.createElement('button');
    this.zoomBtn.className = 'zoom-btn';
    this.zoomBtn.title = 'Zoom in';
    this.zoomBtn.setAttribute('aria-label', 'Zoom in to the selected component');
    this.zoomBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21M10.5 7.5v6M7.5 10.5h6"/></svg>';
    this.zoomBtn.hidden = true;
    this.zoomBtn.addEventListener('click', () => this.selectedId && this.onZoom(this.selectedId));
    this.labelLayer.appendChild(this.zoomBtn);
    container.appendChild(this.labelLayer);

    this._buildNodes();
    this._layoutWebs();
    for (const id in this.nodes) this.nodes[id].group.position.copy(this.nodes[id].target);
    this._buildLinks();
    this._buildParticles();
    // selection marker: a bright ring around the chosen component
    this.selRing = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.07, 8, 72), new THREE.MeshBasicMaterial({ color: FLOW.request, toneMapped: false, transparent: true }));
    this.selRing.rotation.x = Math.PI / 2;
    this.selRing.visible = false;
    this.scene.add(this.selRing);
    this._buildRig();
    this.view = 'app'; // 'app' = application view where one exists, 'hw' = hardware rig
    this.appRigs = {};
    this._buildQueueRig();
    this._buildDbRig();
    this._buildFnRig();
    this._bindPointer();

    // build-mode helpers: a ghost pad while placing, a rubber band while connecting
    this.ghost = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.06, 8, 64), new THREE.MeshBasicMaterial({ color: 0x3987e5, toneMapped: false }));
    this.ghost.rotation.x = Math.PI / 2;
    this.ghost.position.y = 0.1;
    this.ghost.visible = false;
    scene.add(this.ghost);
    this.band = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.band.frustumCulled = false;
    this.band.visible = false;
    scene.add(this.band);

    this.flash = new THREE.PointLight(0xffa040, 0, 30);
    scene.add(this.flash);

    this.resize();
    addEventListener('resize', () => this.resize());
  }

  // ------------------------------------------------------------ nodes
  _buildNodes() {
    this.nodes = {};
    this.hitMeshes = [];
    const fixed = {
      client: [-12, 0],
      lb: [-7, 0],
      cache: [4, -8.5],
      db: [10, -5],
      queue: [4, 2],
      worker: [10, 2.5],
      kafka: [4, 11],
      consumer: [10, 9.5],
      lake: [16, 9.5],
      trino: [22, 9.5],
      clickhouse: [10, 16.5],
      bi: [16, 16.5],
      cdn: [-10, -7.5],
      blob: [-5.5, -13.5],
      fn: [10, -12.5],
      connector: [4, 17],
      scheduler: [16, -1.5],
    };
    for (const id in this.sim.nodes) {
      const type = this.sim.nodes[id].type;
      const group = new THREE.Group();
      const body = new THREE.Group();
      group.add(body);
      const v = { id, type, group, body, mats: [], glow: [], fade: 1, color: new THREE.Color(STATUS.good), target: new THREE.Vector3() };
      const shell = (color = 0x2a2f38) => {
        const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.35, transparent: true });
        v.mats.push(m);
        return m;
      };
      const glow = () => {
        const m = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: STATUS.good, emissiveIntensity: 1.4, transparent: true });
        v.mats.push(m);
        v.glow.push(m);
        return m;
      };
      const add = (geo, mat, x = 0, y = 0, z = 0) => {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, y, z);
        body.add(mesh);
        return mesh;
      };

      // pad + status ring, shared by every node
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.08, 48), new THREE.MeshStandardMaterial({ color: 0x1a1a19, roughness: 0.9 }));
      pad.position.y = 0.04;
      group.add(pad);
      v.ringMat = new THREE.MeshBasicMaterial({ color: STATUS.good, toneMapped: false });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.035, 8, 64), v.ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.09;
      group.add(ring);

      if (type === 'client') {
        const wire = new THREE.MeshBasicMaterial({ color: FLOW.request, wireframe: true, transparent: true });
        v.mats.push(wire);
        v.spin = add(new THREE.IcosahedronGeometry(0.95, 1), wire, 0, 1.2, 0);
        add(new THREE.SphereGeometry(0.6, 24, 16), shell(0x1c2a3f), 0, 1.2, 0);
      } else if (type === 'lb') {
        add(new THREE.CylinderGeometry(1.05, 1.05, 0.6, 6), shell(), 0, 0.45, 0);
        add(new THREE.CylinderGeometry(0.75, 0.75, 0.1, 6), glow(), 0, 0.8, 0);
      } else if (type === 'web' || type === 'consumer' || type === 'trino') {
        const h = type === 'web' ? 1.9 : type === 'trino' ? 1.5 : 1.2;
        add(new THREE.BoxGeometry(1.25, h, 1.25), shell(), 0, 0.1 + h / 2, 0);
        const slats = type === 'web' ? 4 : type === 'trino' ? 3 : 2;
        for (let i = 0; i < slats; i++) add(new THREE.BoxGeometry(0.95, 0.07, 0.04), glow(), 0, 0.5 + i * 0.4, 0.64);
      } else if (type === 'cache') {
        add(new THREE.BoxGeometry(1.8, 0.7, 1.3), shell(), 0, 0.45, 0);
        add(new THREE.BoxGeometry(1.5, 0.06, 1.0), glow(), 0, 0.83, 0);
      } else if (type === 'db') {
        for (let i = 0; i < 3; i++) {
          add(new THREE.CylinderGeometry(0.95, 0.95, 0.48, 40), shell(), 0, 0.36 + i * 0.6, 0);
          add(new THREE.CylinderGeometry(0.97, 0.97, 0.05, 40), glow(), 0, 0.36 + i * 0.6, 0);
        }
      } else if (type === 'lake') {
        // a bucket; the glowing surface is the table's data
        add(new THREE.CylinderGeometry(1.15, 0.85, 1.2, 32), shell(), 0, 0.7, 0);
        add(new THREE.CylinderGeometry(1.02, 1.02, 0.05, 32), glow(), 0, 1.31, 0);
      } else if (type === 'clickhouse') {
        // columns, for a columnar store
        [1.0, 1.5, 1.2, 1.7, 0.8].forEach((h, i) => {
          add(new THREE.BoxGeometry(0.3, h, 1.1), shell(), (i - 2) * 0.42, 0.1 + h / 2, 0);
          add(new THREE.BoxGeometry(0.3, 0.05, 1.1), glow(), (i - 2) * 0.42, 0.13 + h, 0);
        });
      } else if (type === 'bi') {
        // a monitor showing a bar chart
        add(new THREE.BoxGeometry(0.9, 0.06, 0.5), shell(), 0, 0.12, 0);
        add(new THREE.BoxGeometry(0.12, 0.6, 0.12), shell(), 0, 0.42, 0);
        add(new THREE.BoxGeometry(1.9, 1.15, 0.08), shell(), 0, 1.25, 0);
        [0.35, 0.6, 0.45, 0.8].forEach((h, i) => add(new THREE.BoxGeometry(0.25, h, 0.03), glow(), (i - 1.5) * 0.38, 0.8 + h / 2, 0.06));
      } else if (type === 'cdn') {
        // a hub ringed by edge locations
        add(new THREE.CylinderGeometry(0.55, 0.55, 0.9, 24), shell(), 0, 0.55, 0);
        add(new THREE.CylinderGeometry(0.57, 0.57, 0.05, 24), glow(), 0, 1.02, 0);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 - Math.PI / 2; // none in front, where the logo lies
          add(new THREE.BoxGeometry(0.4, 0.5, 0.4), shell(), Math.cos(a) * 1.15, 0.35, Math.sin(a) * 1.15);
          add(new THREE.BoxGeometry(0.3, 0.05, 0.3), glow(), Math.cos(a) * 1.15, 0.62, Math.sin(a) * 1.15);
        }
      } else if (type === 'blob') {
        // a six-sided bucket of objects (the data lake's bucket is round)
        add(new THREE.CylinderGeometry(1.1, 0.8, 1.0, 6), shell(), 0, 0.6, 0);
        add(new THREE.CylinderGeometry(0.95, 0.95, 0.05, 6), glow(), 0, 1.12, 0);
      } else if (type === 'scheduler') {
        // a clock face lying flat, with a hand that sweeps as jobs fall due
        add(new THREE.CylinderGeometry(1.0, 1.1, 0.7, 12), shell(), 0, 0.45, 0);
        add(new THREE.CylinderGeometry(0.85, 0.85, 0.04, 32), glow(), 0, 0.83, 0);
        v.spin = new THREE.Group();
        v.spin.position.y = 0.9;
        const hand = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.06, 0.1), shell());
        hand.position.x = 0.36;
        v.spin.add(hand);
        body.add(v.spin);
      } else if (type === 'connector') {
        // a small adapter: two worker boxes bridged by a pipe
        add(new THREE.BoxGeometry(0.7, 0.6, 0.9), shell(), -0.55, 0.4, 0);
        add(new THREE.BoxGeometry(0.7, 0.6, 0.9), shell(), 0.55, 0.4, 0);
        add(new THREE.BoxGeometry(1.5, 0.12, 0.2), glow(), 0, 0.76, 0);
      } else if (type === 'fn') {
        // a tray of small identical execution environments
        add(new THREE.BoxGeometry(2.2, 0.2, 1.6), shell(), 0, 0.2, 0);
        for (let i = 0; i < 12; i++) {
          const x = ((i % 4) - 1.5) * 0.5;
          const z = (Math.floor(i / 4) - 1) * 0.46;
          add(new THREE.BoxGeometry(0.34, 0.34, 0.34), shell(), x, 0.47, z);
          add(new THREE.BoxGeometry(0.26, 0.04, 0.26), glow(), x, 0.66, z);
        }
      } else if (type === 'kafka') {
        // three partition logs; the bright bar is unread backlog (lag)
        v.bars = [];
        for (let i = 0; i < 3; i++) {
          const z = (i - 1) * 0.62;
          add(new THREE.BoxGeometry(2.6, 0.4, 0.42), shell(), 0, 0.7, z);
          const bar = add(new THREE.BoxGeometry(2.4, 0.08, 0.3), glow(), 0, 0.93, z);
          v.bars.push(bar);
        }
      } else if (type === 'queue') {
        // a row of slots that fill up as the backlog grows
        add(new THREE.BoxGeometry(3.0, 0.2, 0.7), shell(), 0, 0.2, 0);
        v.slots = [];
        for (let i = 0; i < 8; i++) {
          const m = new THREE.MeshStandardMaterial({ color: 0x24262b, emissive: FLOW.job, emissiveIntensity: 0, transparent: true });
          v.mats.push(m);
          v.slots.push(add(new THREE.BoxGeometry(0.28, 0.45, 0.5), m, 1.2 - i * 0.34, 0.55, 0));
        }
      } else if (type === 'worker') {
        v.units = [];
        for (let i = 0; i < 6; i++) {
          const u = new THREE.Group();
          u.position.set(((i % 3) - 1) * 0.85, 0, (Math.floor(i / 3) - 0.5) * 0.9);
          const box = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.9, 0.65), shell());
          box.position.y = 0.55;
          const led = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.06, 0.04), glow());
          led.position.set(0, 0.8, 0.34);
          u.add(box, led);
          body.add(u);
          v.units.push(u);
        }
      }

      const hit = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, HEIGHT[type] + 0.3, 12), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.y = (HEIGHT[type] + 0.3) / 2;
      hit.userData.id = id;
      group.add(hit);
      v.hit = hit;
      this.hitMeshes.push(hit);

      if (fixed[id]) v.target.set(fixed[id][0], 0, fixed[id][1]);
      else v.target.set(-1.5, 0, 0);
      v.home = v.target.clone();
      group.position.copy(v.target);

      const el = document.createElement('div');
      el.className = 'node-label';
      el.innerHTML = '<div class="nl-name"></div><div class="nl-role"></div><div class="nl-stat"></div><div class="nl-bar"><i></i></div><div class="nl-data"></div>';
      this.labelLayer.appendChild(el);
      v.el = el;
      v.elName = el.children[0];
      v.elRole = el.children[1];
      v.elStat = el.children[2];
      v.elBar = el.children[3].firstChild;
      v.elData = el.children[4];

      // technology logo, lying on the pad in front of the machine
      v.decal = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.0), new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false }));
      v.decal.rotation.x = -Math.PI / 2;
      v.decal.position.set(0, 0.095, 1.3);
      v.decal.visible = false;
      group.add(v.decal);

      this.scene.add(group);
      this.nodes[id] = v;
    }
  }

  // Web servers the user has not placed by hand line up in a column.
  _layoutWebs() {
    const auto = this.sim.webs.filter((w) => w.active && !this.nodes[w.id].manual);
    auto.forEach((w, i) => this.nodes[w.id].target.set(-1.5, 0, (i - (auto.length - 1) / 2) * 4.4));
  }

  resetLayout() {
    for (const id in this.nodes) {
      const v = this.nodes[id];
      v.manual = false;
      v.target.copy(v.home);
    }
    this._layoutWebs();
    for (const id in this.nodes) this.nodes[id].group.position.copy(this.nodes[id].target);
  }

  // Put a component at a spot the user chose.
  placeAt(id, pt) {
    const v = this.nodes[id];
    v.manual = true;
    v.target.set(pt.x, 0, pt.z);
    v.group.position.copy(v.target);
  }

  startPlacing(id) {
    this.placing = id;
    this.setConnecting(false);
  }

  setConnecting(on) {
    this.connecting = on;
    this.connectFrom = null;
    if (on) this.placing = null;
  }

  // ------------------------------------------------------------ links
  _buildLinks() {
    this.links = [];
    const add = (from, to, color) => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.25 });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      this.scene.add(line);
      this.links.push({ id: `${from}>${to}`, a: from, b: to, from: this.nodes[from], to: this.nodes[to], color: new THREE.Color(color), line, acc: {} });
    };
    add('client', 'lb', FLOW.request);
    for (let i = 0; i < MAX_WEB; i++) {
      const w = 'web' + i;
      add('lb', w, FLOW.request);
      add(w, 'cache', FLOW.read);
      add(w, 'db', FLOW.write);
      add(w, 'queue', FLOW.job);
      add(w, 'kafka', FLOW.event);
      add(w, 'blob', FLOW.asset);
    }
    add('cache', 'db', FLOW.read);
    add('queue', 'worker', FLOW.job);
    add('kafka', 'consumer', FLOW.event);
    add('kafka', 'clickhouse', FLOW.event);
    add('consumer', 'lake', FLOW.event);
    add('bi', 'clickhouse', FLOW.query);
    add('bi', 'trino', FLOW.query);
    add('trino', 'lake', FLOW.query);
    add('client', 'cdn', FLOW.asset);
    add('cdn', 'blob', FLOW.asset);
    add('blob', 'fn', FLOW.job);
    add('scheduler', 'db', FLOW.read);
    add('scheduler', 'queue', FLOW.job);
    add('kafka', 'connector', FLOW.event);
    add('connector', 'clickhouse', FLOW.event);
    add('queue', 'fn', FLOW.job);
  }

  // ------------------------------------------------------------ particles
  _buildParticles() {
    // traffic dots travelling along links
    const MAXP = (this.MAXP = 7000);
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.pMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.085, 8, 6), mat, MAXP);
    this.pMesh.frustumCulled = false;
    this.pMesh.count = 0;
    this.pMesh.setColorAt(0, tmpC.set(0xffffff));
    this.scene.add(this.pMesh);
    this.parts = [];

    // debris / rejected requests: free-flying with gravity
    const MAXF = (this.MAXF = 1500);
    const fmat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.fMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), fmat, MAXF);
    this.fMesh.frustumCulled = false;
    this.fMesh.count = 0;
    this.fMesh.setColorAt(0, tmpC.set(0xffffff));
    this.scene.add(this.fMesh);
    this.fx = [];
  }

  _spawnFx(pos, color, speed, up, life, n) {
    for (let i = 0; i < n && this.fx.length < this.MAXF; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = speed * (0.3 + Math.random() * 0.7);
      this.fx.push({
        p: pos.clone(),
        v: new THREE.Vector3(Math.cos(a) * r, up * (0.5 + Math.random()), Math.sin(a) * r),
        life,
        max: life,
        color,
        size: 0.6 + Math.random() * 1.2,
      });
    }
  }

  explode(id) {
    const v = this.nodes[id];
    const pos = v.group.position.clone().setY(HEIGHT[v.type] / 2);
    this._spawnFx(pos, 0xffb030, 9, 9, 1.6, 90);
    this._spawnFx(pos, 0xff5020, 6, 6, 1.9, 60);
    this._spawnFx(pos, 0x8a8a84, 4, 5, 2.4, 40);
    this.flash.position.copy(pos).setY(2.5);
    this.flash.intensity = 400;
    this.shake = 0.5;
    const shock = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    shock.position.copy(pos);
    this.scene.add(shock);
    this.shocks.push({ mesh: shock, t: 0 });
  }

  // ------------------------------------------------------------ zoom-in hardware rig
  _buildRig() {
    const rig = (this.rig = new THREE.Group());
    rig.visible = false;
    this.scene.add(rig);
    const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3, ...extra });
    const lit = () => new THREE.MeshStandardMaterial({ color: 0x15171a, emissive: STATUS.good, emissiveIntensity: 1 });
    const glass = () => new THREE.MeshStandardMaterial({ color: 0x8aa0b8, transparent: true, opacity: 0.14, depthWrite: false });
    const mesh = (geo, mat, x, y, z, parent = rig) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };
    mesh(new THREE.BoxGeometry(2.7, 0.08, 2.7), std(0x12301f), 0, 0.14, 0); // motherboard
    const Y = 0.18;

    // CPU: 8 cores that light up as utilisation rises
    mesh(new THREE.BoxGeometry(1.05, 0.1, 1.05), std(0x2a2f38), -0.65, Y + 0.05, -0.65);
    this.cores = [];
    for (let i = 0; i < 8; i++) {
      const c = mesh(new THREE.BoxGeometry(0.19, 0.07, 0.4), lit(), -0.65 + ((i % 4) - 1.5) * 0.235, Y + 0.13, -0.65 + (Math.floor(i / 4) - 0.5) * 0.46);
      this.cores.push(c);
    }
    // Memory: 4 DIMMs that fill up
    this.dimms = [];
    for (let i = 0; i < 4; i++) {
      const x = 0.3 + i * 0.24;
      mesh(new THREE.BoxGeometry(0.13, 0.62, 1.0), glass(), x, Y + 0.31, -0.65);
      const fill = mesh(new THREE.BoxGeometry(0.11, 0.6, 0.98), lit(), x, Y, -0.65);
      fill.geometry.translate(0, 0.3, 0);
      this.dimms.push(fill);
    }
    // Storage: a drive that fills up
    mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.7, 32), glass(), -0.65, Y + 0.35, 0.65);
    this.diskFill = mesh(new THREE.CylinderGeometry(0.47, 0.47, 0.68, 32), lit(), -0.65, Y, 0.65);
    this.diskFill.geometry.translate(0, 0.34, 0);
    // Network card: packets streaming in and out
    mesh(new THREE.BoxGeometry(1.05, 0.1, 0.6), std(0x2a2f38), 0.65, Y + 0.05, 0.65);
    mesh(new THREE.BoxGeometry(0.16, 0.26, 0.5), std(0x8a8a84), 1.2, Y + 0.13, 0.65);
    this.packets = [];
    for (let i = 0; i < 10; i++) this.packets.push(mesh(new THREE.BoxGeometry(0.12, 0.07, 0.1), lit(), 0, Y + 0.16, 0.65 + (i % 2 ? 0.14 : -0.14)));
    this.packetPhase = 0;

    this.rigAnchors = {
      cpu: new THREE.Vector3(-0.65, 0.55, -0.65),
      mem: new THREE.Vector3(0.66, 1.0, -0.65),
      disk: new THREE.Vector3(-0.65, 1.05, 0.65),
      net: new THREE.Vector3(0.65, 0.6, 0.65),
    };
    this.rigLabels = {};
    for (const [key, name] of [['cpu', 'CPU'], ['mem', 'Memory'], ['disk', 'Storage'], ['net', 'Network']]) {
      const el = document.createElement('div');
      el.className = 'rig-label';
      el.innerHTML = `<span>${name}</span><b></b>`;
      el.hidden = true;
      this.labelLayer.appendChild(el);
      this.rigLabels[key] = el;
    }
  }

  // ------------------------------------------------------------ zoom-in broker view (queues only)
  // Left to right: publishers → exchange/topic → the queue itself, oldest message at the head →
  // consumers, each holding the job it has been handed but not yet acknowledged.
  _buildQueueRig() {
    const g = new THREE.Group();
    const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3, ...extra });
    const lit = (color = FLOW.job) => new THREE.MeshStandardMaterial({ color: 0x15171a, emissive: color, emissiveIntensity: 1.2 });
    const mesh = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    mesh(new THREE.BoxGeometry(6.4, 0.08, 1.7), std(0x16181c), 0, 0.14, 0);
    // the queue: a glass lane, head (next to be delivered) on the right
    mesh(new THREE.BoxGeometry(3.4, 0.36, 0.56), new THREE.MeshStandardMaterial({ color: 0x8aa0b8, transparent: true, opacity: 0.14, depthWrite: false }), 0, 0.37, 0);
    mesh(new THREE.BoxGeometry(0.04, 0.5, 0.7), std(0x8a8a84), 1.72, 0.43, 0); // head gate
    const msgGeo = new THREE.BoxGeometry(0.075, 0.24, 0.4);
    this.qMsgs = [];
    for (let i = 0; i < Q_SLOTS; i++) this.qMsgs.push(mesh(msgGeo, lit(), 0, 0.33, 0));
    // exchange / topic: where publishers hand messages to the broker
    this.qEntry = mesh(new THREE.OctahedronGeometry(0.27), lit(FLOW.request), -2.55, 0.52, 0);
    // messages being published, delivered, and (when the queue is full) thrown away
    const dot = new THREE.BoxGeometry(0.09, 0.09, 0.09);
    this.qIn = [0, 1, 2, 3].map(() => mesh(dot, lit(), 0, 0.33, 0));
    this.qOut = [0, 1, 2].map(() => mesh(dot, lit(), 0, 0.33, 0));
    this.qLost = [0, 1, 2, 3].map(() => mesh(dot, lit(FLOW.error), 0, 0.33, 0));
    // consumers: each worker machine is a chassis running several consumer processes,
    // and each process holds the job it has been handed
    this.qMachines = [];
    const padGeo = new THREE.BoxGeometry(0.17, 0.05, 0.17);
    const jobGeo = new THREE.BoxGeometry(0.11, 0.11, 0.11);
    for (let i = 0; i < 6; i++) {
      const x = 2.3 + (i % 2) * 0.52;
      const z = (Math.floor(i / 2) - 1) * 0.52;
      const box = mesh(new THREE.BoxGeometry(0.46, 0.08, 0.46), std(0x2a2f38), x, 0.2, z);
      const slots = [];
      for (let s = 0; s < 4; s++) {
        const sx = x + ((s % 2) - 0.5) * 0.21;
        const sz = z + (Math.floor(s / 2) - 0.5) * 0.21;
        slots.push({ pad: mesh(padGeo, lit(STATUS.good), sx, 0.26, sz), job: mesh(jobGeo, lit(), sx, 0.36, sz) });
      }
      this.qMachines.push({ box, slots });
    }
    this.qPhase = { in: 0, out: 0, lost: 0 };

    const anchors = {
      pub: new THREE.Vector3(-2.3, 0.2, 1.25),
      queue: new THREE.Vector3(0, 0.9, -0.7),
      cons: new THREE.Vector3(2.0, 0.2, 1.25),
      lost: new THREE.Vector3(-0.3, 0.2, 1.7),
    };
    this.qLabels = this._addAppRig('queue', g, anchors, (n, dt) => this._updateQueueRig(n, dt), (key, n) => key === 'lost' && !(n.dropRate > 0.5 && !n.down));
    this.qLabels.lost.classList.add('bad');
  }

  // Register an application view: its meshes, where its labels sit, how it animates, and which labels to hide.
  _addAppRig(type, group, anchors, update, hide = () => false) {
    group.visible = false;
    this.scene.add(group);
    const labels = {};
    for (const key in anchors) {
      const el = document.createElement('div');
      el.className = 'rig-label';
      el.innerHTML = '<span></span><b></b>';
      el.hidden = true;
      this.labelLayer.appendChild(el);
      labels[key] = el;
    }
    this.appRigs[type] = { group, anchors, labels, update, hide };
    return labels;
  }

  // Switch every component between its application view and the hardware rig.
  setView(view) {
    this.view = view;
    if (this.focusId) this.focus(this.focusId);
  }

  // ------------------------------------------------------------ zoom-in function view
  // Event sources on the left; on the right the pool of execution environments the platform
  // manages for you: busy with an event, idle but warm, or being cold-started.
  _buildFnRig() {
    const g = new THREE.Group();
    const std = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3 });
    const lit = (color) => new THREE.MeshStandardMaterial({ color: 0x15171a, emissive: color, emissiveIntensity: 0.3 });
    const mesh = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    mesh(new THREE.BoxGeometry(6.6, 0.08, 3.0), std(0x16181c), 0, 0.14, 0);
    // triggers: a bucket (upload events) and a queue lane (polling for jobs)
    this.fnBucket = mesh(new THREE.CylinderGeometry(0.34, 0.26, 0.4, 6), lit(FLOW.asset), -2.7, 0.4, -0.75);
    this.fnQueue = mesh(new THREE.BoxGeometry(0.8, 0.22, 0.3), lit(FLOW.job), -2.7, 0.3, 0.75);
    const dot = new THREE.BoxGeometry(0.09, 0.09, 0.09);
    this.fnUpDots = [0, 1, 2].map(() => mesh(dot, lit(FLOW.asset), 0, 0.35, -0.75));
    this.fnJobDots = [0, 1, 2].map(() => mesh(dot, lit(FLOW.job), 0, 0.35, 0.75));
    // execution environments: a pad each, with the event it is handling on top
    this.fnEnvs = [];
    const padGeo = new THREE.BoxGeometry(0.3, 0.06, 0.3);
    const runGeo = new THREE.BoxGeometry(0.17, 0.17, 0.17);
    for (let i = 0; i < FN_TILES; i++) {
      const x = -1.2 + (i % 10) * 0.42;
      const z = (Math.floor(i / 10) - 1.5) * 0.46;
      this.fnEnvs.push({ pad: mesh(padGeo, lit(STATUS.good), x, 0.2, z), run: mesh(runGeo, lit(FLOW.job), x, 0.36, z) });
    }
    this.fnPhase = { up: 0, job: 0 };
    const anchors = {
      up: new THREE.Vector3(-2.5, 0.5, -1.6),
      envs: new THREE.Vector3(1.0, 0.5, -1.6),
      poll: new THREE.Vector3(-2.5, 0.2, 1.75),
      cold: new THREE.Vector3(0.6, 0.2, 1.75),
      thr: new THREE.Vector3(2.9, 0.2, 1.75),
    };
    const sim = this.sim;
    this.fnLabels = this._addAppRig('fn', g, anchors, (n, dt) => this._updateFnRig(n, dt), (key, n) => (key === 'thr' && !(n.dropRate > 0.5)) || (key === 'poll' && !sim.edges.has('queue>fn')));
    this.fnLabels.thr.classList.add('bad');
  }

  _updateFnRig(node, dt) {
    const sim = this.sim;
    const t = sim.time;
    const live = !node.down;
    const ph = this.fnPhase;
    const rate = (r) => (r > 0.01 ? 0.3 + Math.min(2.2, Math.log10(1 + r) * 0.8) : 0);
    ph.up = (ph.up + dt * rate(node.upRate)) % 1;
    ph.job = (ph.job + dt * rate(node.jobRate)) % 1;
    const s3 = sim.edges.has('blob>fn');
    const poll = sim.edges.has('queue>fn');
    this.fnBucket.material.emissiveIntensity = s3 && live ? 1.1 : 0.15;
    this.fnQueue.material.emissiveIntensity = poll && live ? 1.1 : 0.15;
    this.fnUpDots.forEach((m, i) => {
      m.visible = live && node.upRate > 0.01 && i < 1 + Math.floor(Math.log10(1 + node.upRate) * 1.5);
      m.position.x = -2.3 + ((ph.up + i / 3) % 1) * 0.9;
    });
    this.fnJobDots.forEach((m, i) => {
      m.visible = live && node.jobRate > 0.01 && i < 1 + Math.floor(Math.log10(1 + node.jobRate));
      m.position.x = -2.2 + ((ph.job + i / 3) % 1) * 0.8;
    });
    // one tile stands for several environments once there are more than fit
    const per = node.warm <= FN_TILES ? 1 : node.warm <= FN_TILES * 5 ? 5 : 25;
    const busy = live ? node.concurrency / per : 0;
    const warm = live ? Math.ceil(node.warm / per - 0.02) : 0;
    const cold = Math.ceil(busy * node.coldPct); // the newest busy ones are still starting
    this.fnEnvs.forEach(({ pad, run }, i) => {
      const load = THREE.MathUtils.clamp(busy - i, 0, 1);
      const starting = load > 0.05 && i >= Math.ceil(busy) - cold;
      pad.material.emissive.set(i < warm ? (starting ? FLOW.request : STATUS.good) : STATUS.down);
      pad.material.emissiveIntensity = i < warm ? (starting ? 1 + 0.8 * Math.sin(t * 14 + i) : 0.7) : 0.2;
      run.visible = load > 0.05;
      run.material.emissive.set(starting ? FLOW.request : FLOW.job);
      run.material.emissiveIntensity = load * (1.3 + 0.4 * Math.sin(t * 8 + i * 1.7));
      run.rotation.y = t * 2 + i;
    });

    const set = (key, name, text) => {
      this.fnLabels[key].firstChild.textContent = name;
      this.fnLabels[key].lastChild.textContent = text;
    };
    const n1 = (v) => (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString());
    set('up', 'Upload events', s3 ? `${n1(node.upRate)} /s` : 'not connected');
    set('poll', 'Queue polling', `${fmtRate(node.jobRate)} jobs/s`);
    set('envs', 'Execution environments', `${n1(node.concurrency)} busy · ${n1(node.warm)} warm · limit ${node.limit.toLocaleString()}` + (per > 1 ? ` · 1 tile = ${per}` : ''));
    set('cold', 'Cold starts', `${Math.round(node.coldPct * 100)}% of events · ${Math.round(node.latency * 1000)} ms avg run`);
    set('thr', 'Throttled (429)', `${fmtRate(node.dropRate)} events/s`);
  }

  // ------------------------------------------------------------ zoom-in database view
  // Left to right: client connections → an index lookup per table → the table's rows on disk,
  // with the buffer pool (pages held in RAM) behind and the write-ahead log every write goes through.
  _buildDbRig() {
    const g = new THREE.Group();
    const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3, ...extra });
    const lit = (color) => new THREE.MeshStandardMaterial({ color: 0x15171a, emissive: color, emissiveIntensity: 0.25 });
    const mesh = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    mesh(new THREE.BoxGeometry(6.6, 0.08, 3.9), std(0x16181c), 0, 0.14, 0);
    const Y = 0.2;
    // connection pool: one pad per slice of the connection limit
    this.dbConns = [];
    const pad = new THREE.BoxGeometry(0.2, 0.06, 0.2);
    for (let i = 0; i < 16; i++) this.dbConns.push(mesh(pad, lit(FLOW.request), -2.95 + (i % 2) * 0.28, Y, -0.55 + Math.floor(i / 2) * 0.3));
    // three tables, each an index tree (root → branches → leaves) pointing into rows on disk
    const nodeGeo = new THREE.BoxGeometry(0.2, 0.1, 0.2);
    const rowGeo = new THREE.BoxGeometry(1.5, 0.05, 0.62);
    const link = std(0x3a3f48);
    this.dbTables = [];
    for (let k = 0; k < 3; k++) {
      const z0 = -0.5 + k * 1.05;
      const tree = [mesh(nodeGeo, lit(FLOW.read), -1.95, Y + 0.02, z0)];
      for (let b = 0; b < 2; b++) tree.push(mesh(nodeGeo, lit(FLOW.read), -1.45, Y + 0.02, z0 + (b - 0.5) * 0.42));
      for (let l = 0; l < 4; l++) tree.push(mesh(nodeGeo, lit(FLOW.read), -0.95, Y + 0.02, z0 + (l - 1.5) * 0.21));
      mesh(new THREE.BoxGeometry(1.0, 0.02, 0.03), link, -1.45, Y - 0.02, z0);
      mesh(new THREE.BoxGeometry(0.03, 0.02, 0.63), link, -0.95, Y - 0.02, z0);
      mesh(new THREE.BoxGeometry(0.03, 0.02, 0.42), link, -1.45, Y - 0.02, z0);
      mesh(new THREE.BoxGeometry(0.5, 0.02, 0.03), link, -0.6, Y - 0.02, z0); // leaf → row
      const rows = [];
      for (let r = 0; r < 8; r++) rows.push(mesh(rowGeo, lit(0x8aa0b8), 0.45, Y + 0.01 + r * 0.065, z0));
      this.dbTables.push({ tree, rows });
    }
    // buffer pool: pages of the tables held in memory
    this.dbPages = [];
    const page = new THREE.BoxGeometry(0.17, 0.05, 0.3);
    for (let i = 0; i < 16; i++) this.dbPages.push(mesh(page, lit(FLOW.read), -1.95 + i * 0.21, Y, -1.5));
    // write-ahead log: an append-only strip; the bright segment is the write position
    this.dbLog = [];
    const seg = new THREE.BoxGeometry(0.34, 0.06, 0.2);
    for (let i = 0; i < 12; i++) this.dbLog.push(mesh(seg, lit(FLOW.write), 2.05, Y, -1.5 + i * 0.25));
    // replicas replaying that log
    this.dbReplicas = [];
    for (let i = 0; i < 5; i++) this.dbReplicas.push(mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.22, 16), lit(FLOW.write), 2.85, Y + 0.08, -1.2 + i * 0.5));
    this.dbPhase = { read: 0, write: 0 };

    const anchors = {
      conns: new THREE.Vector3(-4.3, 0.2, 0.4),
      index: new THREE.Vector3(-2.3, 0.2, 2.2),
      table: new THREE.Vector3(1.2, 0.2, 2.2),
      pool: new THREE.Vector3(-1.3, 0.5, -2.0),
      log: new THREE.Vector3(2.2, 0.5, -2.0),
    };
    this.dbLabels = this._addAppRig('db', g, anchors, (n, dt) => this._updateDbRig(n, dt));
  }

  _updateDbRig(node, dt) {
    const sim = this.sim;
    const terms = DB_TERMS[sim.params.tech.db] || BTREE;
    const eng = node.tech;
    const ph = this.dbPhase;
    const live = !node.down;
    const rate = (r) => (r > 0.05 ? 0.6 + Math.min(5, Math.log10(1 + r) * 1.6) : 0); // lookups shown per second
    ph.read += dt * rate(live ? node.readRate : 0);
    ph.write += dt * rate(live ? node.writeRate : 0);
    const rnd = (n, salt) => Math.abs(Math.sin(n * 12.9898 + salt * 78.233) * 43758.5453) % 1; // stable per lookup

    const open = live ? Math.round(node.conns * 16) : 0;
    const busy = loadLevel(node.conns, false);
    this.dbConns.forEach((c, i) => {
      c.material.emissive.set(i < open ? (busy === 'good' ? FLOW.request : STATUS[busy]) : STATUS.down);
      c.material.emissiveIntensity = i < open ? 1.3 : 0.25;
    });

    // rows on disk: how full the volume is, or a slow log scale where storage has no fixed size
    const fill = eng.managedDisk ? THREE.MathUtils.clamp(Math.log10(1 + (node.storedGB || 0)) / 4, 0.1, 1) : node.diskUsed;
    const nRows = Math.max(1, Math.ceil(fill * 8));
    // one read walks root → branch → leaf → row; one write lands on a row and its index leaf
    const rk = Math.floor(ph.read);
    const rf = ph.read - rk;
    const rT = Math.floor(rnd(rk, 1) * 3);
    const rLeaf = Math.floor(rnd(rk, 2) * 4);
    const rRow = Math.floor(rnd(rk, 3) * nRows);
    const wk = Math.floor(ph.write);
    const wf = ph.write - wk;
    const wT = Math.floor(rnd(wk, 4) * 3);
    const wLeaf = Math.floor(rnd(wk, 5) * 4);
    const wRow = node.readOnly ? -1 : nRows - 1 - Math.floor(rnd(wk, 6) * Math.min(2, nRows));
    const reading = live && node.readRate > 0.05;
    const writing = live && node.writeRate > 0.05 && !node.readOnly;
    this.dbTables.forEach(({ tree, rows }, k) => {
      tree.forEach((m, i) => {
        const depth = i === 0 ? 0 : i < 3 ? 1 : 2;
        const onPath = i === 0 || (i < 3 ? i - 1 === Math.floor(rLeaf / 2) : i - 3 === rLeaf);
        const hot = reading && k === rT && onPath && rf * 4 >= depth;
        const upd = writing && k === wT && i - 3 === wLeaf && wf > 0.5;
        m.material.emissive.set(upd ? FLOW.write : FLOW.read);
        m.material.emissiveIntensity = upd ? 2 : hot ? 2 : 0.3;
      });
      rows.forEach((m, r) => {
        m.visible = r < nRows;
        const hot = reading && k === rT && r === rRow && rf > 0.75;
        const upd = writing && k === wT && r === wRow;
        m.material.emissive.set(upd ? FLOW.write : hot ? FLOW.read : node.readOnly ? STATUS.critical : 0x8aa0b8);
        m.material.emissiveIntensity = upd ? 2.2 * (1 - wf) + 0.4 : hot ? 2 : node.readOnly ? 0.7 : 0.3;
      });
    });

    const warm = live ? Math.round(node.mem * 16) : 0;
    this.dbPages.forEach((m, i) => {
      const touched = reading && i === Math.floor(rnd(rk, 7) * Math.max(1, warm));
      m.material.emissive.set(STATUS[loadLevel(node.mem, false)]);
      m.material.emissiveIntensity = i < warm ? (touched ? 2 : 0.8) : 0.12;
    });
    const head = wk % 12;
    this.dbLog.forEach((m, i) => {
      const age = (head - i + 12) % 12; // segments fade the longer ago they were written
      m.material.emissiveIntensity = writing ? (age === 0 ? 2.2 : Math.max(0.2, 1 - age * 0.12)) : 0.15;
    });
    const R = node.replicas || 0;
    const lagging = node.replLag > 1;
    this.dbReplicas.forEach((m, i) => {
      m.visible = i < R;
      const up = i < (node.replicasUp ?? R);
      m.material.emissive.set(!up ? STATUS.down : lagging ? STATUS.warning : FLOW.write);
      m.material.emissiveIntensity = up ? (writing ? 0.8 + 0.6 * Math.sin(sim.time * 6 - i) : 0.5) : 0.3;
    });

    const set = (key, name, text) => {
      this.dbLabels[key].firstChild.textContent = name;
      this.dbLabels[key].lastChild.textContent = text;
    };
    const waiting = node.queue > 5 ? ` · ${Math.round(node.queue).toLocaleString()} queries waiting` : '';
    set('conns', 'Connections', (node.maxConns ? `${Math.round(node.conns * node.maxConns)} of ${node.maxConns}` : 'stateless API') + waiting);
    set('index', terms.index, `${fmtRate(node.readRate)} lookups/s · ${(node.latency * 1000).toFixed(node.latency < 0.1 ? 1 : 0)} ms`);
    const shards = node.shards > 1 ? ` · 1 of ${node.shards} shards` : '';
    set('table', terms.table, (node.readOnly ? 'DISK FULL · read-only' : eng.managedDisk ? `${fmtGB(node.storedGB || 0)} · grows on demand` : `${fmtGB(node.storedGB || 0)} · disk ${Math.round(node.diskUsed * 100)}% full`) + shards);
    set('pool', terms.pool, `${Math.round(node.mem * 100)}% of RAM`);
    const repl = R ? ` → ${node.replicasUp ?? R} replica${R > 1 ? 's' : ''} ${node.replLag < 10 ? (node.replLag || 0).toFixed(2) : Math.round(node.replLag)}s behind` : '';
    set('log', terms.log, `${fmtRate(node.writeRate)} writes/s` + repl);
  }

  _updateQueueRig(node, dt) {
    const sim = this.sim;
    const t = sim.time;
    const terms = QUEUE_TERMS[sim.params.tech.queue] || QUEUE_TERMS.rabbitmq;
    const ph = this.qPhase;
    const live = !node.down;
    // √ scale so a short backlog is visible; a bottomless managed queue barely shows one
    const shown = !live || node.queue < 1 ? 0 : THREE.MathUtils.clamp(Math.ceil(Q_SLOTS * Math.sqrt(node.queue / node.qmax)), 1, Q_SLOTS);
    const full = shown === Q_SLOTS && node.util >= 0.99;
    const rate = (r) => (r > 0.05 ? 0.25 + Math.min(2.2, Math.log10(1 + r) * 0.7) : 0); // animation speed for a flow
    ph.in = (ph.in + dt * rate(node.inRate)) % 1;
    ph.out = (ph.out + dt * rate(node.outRate)) % 1;
    ph.lost = (ph.lost + dt * 1.1) % 1;
    const HEAD = 1.64;
    const STEP = 3.28 / Q_SLOTS;
    const tail = HEAD - shown * STEP;
    const col = node.util >= 0.85 ? STATUS.critical : node.util >= 0.6 ? STATUS.warning : FLOW.job;
    // the backlog marches toward the head as consumers take messages off it
    const march = node.outRate > 0.05 && shown < Q_SLOTS ? ph.out : 0;
    this.qMsgs.forEach((m, i) => {
      m.visible = i < shown;
      m.position.x = HEAD - (i + 1 - march) * STEP + STEP / 2;
      m.material.emissive.set(col);
      m.material.emissiveIntensity = i === 0 ? 1.9 : 1.1; // the head is the next one out
    });
    const hasEntry = !!terms.entry;
    this.qEntry.visible = hasEntry;
    this.qEntry.rotation.y = t * 1.5;
    const from = hasEntry ? -2.55 : -3.05;
    const nIn = live && node.inRate > 0.05 ? Math.min(4, 1 + Math.floor(Math.log10(1 + node.inRate))) : 0;
    this.qIn.forEach((m, i) => {
      m.visible = i < nIn && !full;
      const f = (ph.in + i / 4) % 1;
      m.position.x = from + (tail - from) * f;
    });
    const busy = Math.min(node.consumers, node.inflight);
    const nOut = live && node.outRate > 0.05 ? Math.min(3, 1 + Math.floor(Math.log10(1 + node.outRate))) : 0;
    this.qOut.forEach((m, i) => {
      m.visible = i < nOut;
      const f = (ph.out + i / 3) % 1;
      m.position.x = 1.72 + f * 0.5;
    });
    // a full queue has nowhere to put new messages: they fall off the tail
    this.qLost.forEach((m, i) => {
      m.visible = live && node.dropRate > 0.5;
      const f = (ph.lost + i / 4) % 1;
      m.position.set(-1.75 - f * 0.25, 0.5 - f * f * 0.34, f * 1.0);
    });
    const M = sim.params.workerCount;
    this.qMachines.forEach(({ box, slots }, i) => {
      box.visible = i < M;
      const on = i < node.machines;
      slots.forEach(({ pad, job }, s) => {
        pad.visible = box.visible;
        pad.material.emissive.set(on ? STATUS.good : STATUS.down);
        pad.material.emissiveIntensity = on ? 0.9 : 0.4;
        // the broker deals jobs out round-robin, so every machine fills at the same pace
        const load = THREE.MathUtils.clamp(busy - (s * M + i), 0, 1);
        job.visible = box.visible && on && load > 0.05;
        job.material.emissiveIntensity = load * (1.2 + 0.5 * Math.sin(t * 9 + i * 1.3 + s));
        job.rotation.y = t * 2 + i + s;
      });
    });

    const set = (key, name, text) => {
      this.qLabels[key].firstChild.textContent = name;
      this.qLabels[key].lastChild.textContent = text;
    };
    set('pub', hasEntry ? `${terms.entry} · published` : 'Published', `${fmtRate(node.inRate)} jobs/s`);
    const wait = !node.consumers ? 'no consumer' : node.latency < 0.05 ? 'no wait' : `oldest waits ${node.latency < 90 ? node.latency.toFixed(1) + 's' : Math.round(node.latency / 60) + ' min'}`;
    set('queue', `${terms.queue} · ${terms.ready}`, `${Math.round(node.queue).toLocaleString()} of ${fmtRate(node.qmax)} · ${wait}`);
    set('cons', terms.flight, node.consumers ? `${busy.toFixed(1)} · ${node.consumers} consumers on ${node.machines} machine${node.machines > 1 ? 's' : ''} · ${fmtRate(node.outRate)} ${terms.done}/s` + (node.fnJobs > 0.05 ? ` · functions take ${fmtRate(node.fnJobs)}/s more` : '') : node.fnJobs > 0.05 ? `functions only · ${fmtRate(node.fnJobs)} jobs/s` : 'no consumers connected');
    set('lost', 'Queue full · rejected', `${fmtRate(node.dropRate)} jobs/s`);
  }

  _updateRig(node, dt) {
    const col = (u) => STATUS[loadLevel(u, false)];
    const t = this.sim.time;
    this.cores.forEach((c, i) => {
      const on = THREE.MathUtils.clamp(node.cpu * 8 - i, 0, 1);
      c.material.emissive.set(col(node.cpu));
      c.material.emissiveIntensity = on * (1.3 + 0.5 * Math.sin(t * 20 + i * 1.7));
    });
    this.dimms.forEach((d) => {
      d.scale.y = Math.max(0.02, node.mem);
      d.material.emissive.set(col(node.mem));
    });
    this.diskFill.scale.y = Math.max(0.02, node.disk);
    this.diskFill.material.emissive.set(col(node.disk));
    this.packetPhase += dt * (0.25 + node.net * 1.6);
    const shown = node.net > 0.001 ? Math.max(2, Math.ceil(node.net * 10)) : 0;
    this.packets.forEach((p, i) => {
      p.visible = i < shown;
      const f = (this.packetPhase + i / 10) % 1;
      p.position.x = i % 2 ? 0.15 + f * 1.0 : 1.15 - f * 1.0;
      p.material.emissive.set(col(node.net));
    });
    for (const key in this.rigLabels)
      this.rigLabels[key].lastChild.textContent = Math.round(node[key] * 100) + '% · ' + rawMetric(node, key, this.sim.params);
  }

  // ------------------------------------------------------------ interaction
  _bindPointer() {
    const dom = this.renderer.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const aim = (e) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
    };
    // the card floating over a component counts as part of it; cards ignore
    // pointer events (so the floor stays draggable), so hit-test their boxes
    const inCard = (e, id) => {
      const r = this.nodes[id].el.getBoundingClientRect();
      return r.width > 0 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    const pickCard = (e) => {
      // the hovered card is drawn on top, then later cards cover earlier ones
      if (this.hoverId && inCard(e, this.hoverId)) return this.hoverId;
      let found = null;
      for (const id in this.nodes) if (inCard(e, id)) found = id;
      return found;
    };
    const pick = (e) => {
      const card = pickCard(e);
      if (card) return card;
      aim(e);
      const hit = ray.intersectObjects(this.hitMeshes.filter((m) => m.parent.visible))[0];
      return hit ? hit.object.userData.id : null;
    };
    const groundAt = (e) => {
      aim(e);
      return ray.ray.intersectPlane(ground, new THREE.Vector3());
    };
    const moved = (e, d) => Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5;

    let down = null;
    dom.addEventListener(
      'pointerdown',
      (e) => {
        const id = this.placing ? null : pick(e);
        down = { x: e.clientX, y: e.clientY, id, dragging: false };
        // grabbing a component must not also orbit the camera
        if (id && !this.connecting) this.controls.enabled = false;
      },
      true
    );
    addEventListener('pointerup', (e) => {
      this.controls.enabled = true;
      const d = down;
      down = null;
      if (!d || d.dragging || e.target !== dom || moved(e, d)) return;
      if (this.placing) {
        const pt = groundAt(e);
        if (pt) this.onPlace(this.placing, pt);
        return;
      }
      const id = pick(e);
      if (this.connecting) {
        if (!id) this.connectFrom = null;
        else if (!this.connectFrom) this.connectFrom = id;
        else {
          if (id !== this.connectFrom) this.onConnect(this.connectFrom, id);
          this.connectFrom = null;
        }
        return;
      }
      if (id) this.onSelect(id);
    });
    // double-click is the shortcut for the panel's Zoom in button
    dom.addEventListener('dblclick', (e) => {
      const id = this.placing || this.connecting ? null : pick(e);
      if (id) this.onZoom(id);
    });
    dom.addEventListener('pointermove', (e) => {
      this.cursor = groundAt(e);
      if (down && down.id && !this.connecting && (down.dragging || moved(e, down))) {
        // drag a component across the floor
        down.dragging = true;
        const v = this.nodes[down.id];
        if (this.cursor) {
          v.manual = true;
          v.target.set(THREE.MathUtils.clamp(this.cursor.x, -45, 45), 0, THREE.MathUtils.clamp(this.cursor.z, -45, 45));
        }
        dom.style.cursor = 'grabbing';
        return;
      }
      this.hoverId = this.placing ? null : pick(e);
      dom.style.cursor = this.placing ? 'crosshair' : this.hoverId ? (this.connecting ? 'cell' : 'grab') : '';
    });
  }

  select(id) {
    this.selectedId = id;
  }

  focus(id) {
    this.focusId = id;
    this.labelLayer.classList.toggle('focused', !!id);
    if (!id) {
      this.tween = { pos: this._overviewPos(), target: OVERVIEW.target.clone() };
      return;
    }
    const p = this.nodes[id].target;
    // application views are wider than the motherboard, so stand further back
    const wide = this.view === 'app' && this.appRigs[this.nodes[id].type];
    this.tween = wide
      ? { pos: new THREE.Vector3(p.x + 0.2, 7.6, p.z + 3.5), target: new THREE.Vector3(p.x, 0.3, p.z + 0.1) }
      : { pos: new THREE.Vector3(p.x + 0.3, 7, p.z + 3.2), target: new THREE.Vector3(p.x, 0.4, p.z) };
  }

  _overviewPos() {
    return OVERVIEW.pos.clone().sub(OVERVIEW.target).multiplyScalar(this.fit).add(OVERVIEW.target);
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // pull the overview camera back until the diagram fits between the side panels
    const free = Math.max(300, w - SIDE_PANELS) / h;
    const fit = Math.max(0.95, 1.3 / free);
    this.fit = fit;
    if (!this.focusId) this.camera.position.copy(this._overviewPos());
  }

  _project(v, el, world) {
    tmpV.copy(world).project(this.camera);
    if (tmpV.z > 1) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const x = (tmpV.x * 0.5 + 0.5) * this.container.clientWidth;
    const y = (-tmpV.y * 0.5 + 0.5) * this.container.clientHeight;
    el.style.transform = `translate(-50%,-100%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
  }

  // ------------------------------------------------------------ frame
  update(dt, simDt) {
    const sim = this.sim;
    this._layoutWebs();

    if (this.tween) {
      const k = 1 - Math.exp(-dt * 4.5);
      this.camera.position.lerp(this.tween.pos, k);
      this.controls.target.lerp(this.tween.target, k);
      if (this.camera.position.distanceTo(this.tween.pos) < 0.02) this.tween = null;
    }
    this.controls.update();

    // nodes
    for (const id in this.nodes) {
      const v = this.nodes[id];
      const n = sim.nodes[id];
      // the component being placed is shown as a see-through preview riding on the pointer
      const preview = this.placing === id && !n.active && !!this.cursor;
      v.group.visible = n.active || preview;
      if (!n.active && n.type === 'web') v.manual = false;
      v.el.hidden = !n.active;
      if (preview) {
        v.group.position.set(this.cursor.x, 0, this.cursor.z);
        v.fade = 0.55;
        for (const m of v.mats) {
          m.opacity = v.fade;
          m.depthWrite = false;
        }
        continue;
      }
      if (!v.group.visible) {
        v.group.position.copy(v.target);
        continue;
      }
      v.group.position.lerp(v.target, 1 - Math.exp(-dt * 6));
      const level = loadLevel(n.util, n.down);
      const disabled = n.type === 'cache' && !n.active;
      v.color.lerp(tmpC.set(STATUS[disabled ? 'down' : level]), 1 - Math.exp(-dt * 6));
      v.ringMat.color.copy(v.color);
      const focused = this.focusId === id;
      v.fade += ((focused ? 0.07 : disabled ? 0.3 : 1) - v.fade) * (1 - Math.exp(-dt * 7));
      if (n.launching > 0) v.fade = Math.min(v.fade, 0.35); // a launching server is a ghost until it is in service
      const pulse = level === 'critical' ? 1.2 + 0.8 * Math.sin(sim.time * 12) : 1.3;
      for (const m of v.mats) {
        m.opacity = v.fade;
        m.depthWrite = v.fade > 0.5;
      }
      for (const m of v.glow) {
        m.emissive.copy(v.color);
        m.emissiveIntensity = n.down || disabled ? 0.15 : pulse;
      }
      // a crashed machine slumps and shakes with the hover highlight disabled
      v.body.scale.y += ((n.down ? 0.8 : 1) - v.body.scale.y) * 0.2;
      v.body.rotation.z += ((n.down ? 0.12 : 0) - v.body.rotation.z) * 0.2;
      const s = (this.hoverId === id || this.selectedId === id) && !focused ? 1.06 : 1;
      v.body.scale.x = v.body.scale.z = v.body.scale.x + (s - v.body.scale.x) * 0.25;
      // overloaded machines visibly strain
      v.body.position.x = !n.down && n.stress > 0.3 ? (Math.random() - 0.5) * 0.08 * n.stress : 0;

      if (v.spin) v.spin.rotation.y += dt * (0.2 + n.util * 3);
      if (v.bars) v.bars.forEach((b, i) => (b.scale.x = Math.max(0.02, Math.min(1, n.partitions[i] / 50000))));
      if (v.slots) {
        const fill = n.util > 0 ? 0.6 + Math.log10(1 + n.queue) * 1.7 : 0; // log scale: 8 slots ≈ 20k jobs
        v.slots.forEach((sl, i) => (sl.material.emissiveIntensity = THREE.MathUtils.clamp(fill - i, 0, 1) * 1.5));
        if (n.queue < 5) v.slots.forEach((sl) => (sl.material.emissiveIntensity = 0));
      }
      if (v.units) v.units.forEach((u, i) => (u.visible = i < sim.params.workerCount));
      if (n.down && Math.random() < dt * 6) this._spawnFx(tmpV.copy(v.group.position).setY(HEIGHT[v.type] * 0.7), 0xffc040, 2, 3, 0.6, 1);
      if (!n.down && n.dropRate > 1) {
        v.dropAcc = (v.dropAcc || 0) + simDt * Math.min(45, 1.2 * Math.sqrt(n.dropRate));
        const k = Math.floor(v.dropAcc);
        v.dropAcc -= k;
        if (k) this._spawnFx(tmpV.copy(v.group.position).setY(HEIGHT[v.type]), FLOW.error, 2.5, 4.5, 1.1, k);
      }
    }

    this.ghost.visible = !!(this.placing && this.cursor);
    if (this.ghost.visible) this.ghost.position.set(this.cursor.x, 0.1, this.cursor.z);
    const from = this.connecting && this.connectFrom && this.nodes[this.connectFrom];
    this.band.visible = !!(from && this.cursor);
    if (this.band.visible) {
      const hov = this.hoverId && this.hoverId !== this.connectFrom ? this.nodes[this.hoverId].group.position : this.cursor;
      const bp = this.band.geometry.attributes.position;
      bp.setXYZ(0, from.group.position.x, 0.5, from.group.position.z);
      bp.setXYZ(1, hov.x, 0.5, hov.z);
      bp.needsUpdate = true;
      const ok = hov !== this.cursor && sim.canConnect(this.connectFrom, this.hoverId);
      this.band.material.color.set(hov === this.cursor ? 0xc3c2b7 : ok ? STATUS.good : STATUS.critical);
    }

    // links + traffic particles
    for (const L of this.links) {
      const rate = sim.flows[L.id] || 0;
      const show = sim.nodes[L.a].active && sim.nodes[L.b].active && L.from.group.visible && L.to.group.visible && sim.edges.has(L.id); // not to a preview
      L.line.visible = show;
      if (!show) continue;
      const a = L.from.group.position;
      const b = L.to.group.position;
      const pos = L.line.geometry.attributes.position;
      pos.setXYZ(0, a.x, 0.12, a.z);
      pos.setXYZ(1, b.x, 0.12, b.z);
      pos.needsUpdate = true;
      L.line.material.opacity = rate > 0.5 ? 0.18 + Math.min(0.5, Math.sqrt(rate) / 160) : 0.06;
      // dot density grows with √rate so both 50 req/s and 20k req/s read clearly
      // Requests travel out in one lane; responses ('<') and errors ('!') come back in the other.
      const len = a.distanceTo(b);
      for (const lane of LANES) {
        const r = lane.key ? sim.flows[L.id + lane.key] || 0 : rate;
        L.acc[lane.key] = (L.acc[lane.key] || 0) + simDt * Math.min(95, 0.9 * Math.sqrt(r));
        while (L.acc[lane.key] >= 1) {
          L.acc[lane.key] -= 1;
          if (this.parts.length < this.MAXP)
            this.parts.push({
              L,
              t: 0,
              rev: lane.rev,
              color: lane.color || L.color,
              speed: (7.5 + Math.random() * 2) / len,
              off: (lane.rev ? -0.2 : 0.2) + (Math.random() - 0.5) * 0.2,
              lift: 0.5 + Math.random() * 0.3,
            });
        }
      }
    }
    let i = 0;
    for (let k = this.parts.length - 1; k >= 0; k--) {
      const p = this.parts[k];
      p.t += p.speed * simDt;
      if (p.t >= 1 || !p.L.line.visible) {
        this.parts[k] = this.parts[this.parts.length - 1];
        this.parts.pop();
        continue;
      }
    }
    for (const p of this.parts) {
      const a = p.L.from.group.position;
      const b = p.L.to.group.position;
      const hA = HEIGHT[p.L.from.type] * 0.45;
      const hB = HEIGHT[p.L.to.type] * 0.45;
      const u = p.rev ? 1 - p.t : p.t;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const k = p.off / (Math.hypot(dx, dz) || 1); // sideways lane offset
      tmpV.set(a.x + dx * u + dz * k, hA + (hB - hA) * u + Math.sin(u * Math.PI) * p.lift, a.z + dz * u - dx * k);
      tmpM.makeTranslation(tmpV.x, tmpV.y, tmpV.z);
      this.pMesh.setMatrixAt(i, tmpM);
      this.pMesh.setColorAt(i, p.color);
      i++;
    }
    this.pMesh.count = i;
    this.pMesh.instanceMatrix.needsUpdate = true;
    if (this.pMesh.instanceColor) this.pMesh.instanceColor.needsUpdate = true;

    // debris
    i = 0;
    for (let k = this.fx.length - 1; k >= 0; k--) {
      const f = this.fx[k];
      f.life -= dt;
      if (f.life <= 0) {
        this.fx[k] = this.fx[this.fx.length - 1];
        this.fx.pop();
        continue;
      }
      f.v.y -= 12 * dt;
      f.p.addScaledVector(f.v, dt);
      if (f.p.y < 0.05) {
        f.p.y = 0.05;
        f.v.y *= -0.35;
        f.v.x *= 0.6;
        f.v.z *= 0.6;
      }
    }
    for (const f of this.fx) {
      const s = f.size * Math.min(1, (f.life / f.max) * 2);
      tmpM.compose(f.p, tmpQ, tmpS.set(s, s, s));
      this.fMesh.setMatrixAt(i, tmpM);
      this.fMesh.setColorAt(i, tmpC.set(f.color));
      i++;
    }
    this.fMesh.count = i;
    this.fMesh.instanceMatrix.needsUpdate = true;
    if (this.fMesh.instanceColor) this.fMesh.instanceColor.needsUpdate = true;

    for (let k = this.shocks.length - 1; k >= 0; k--) {
      const s = this.shocks[k];
      s.t += dt;
      s.mesh.scale.setScalar(0.5 + s.t * 6);
      s.mesh.material.opacity = Math.max(0, 0.3 * (1 - s.t / 0.55));
      if (s.t > 0.55) {
        this.scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        s.mesh.material.dispose();
        this.shocks.splice(k, 1);
      }
    }
    this.flash.intensity *= Math.exp(-dt * 7);

    // hardware rig for the focused node
    const sel = !this.focusId && this.selectedId && this.nodes[this.selectedId];
    this.selRing.visible = !!sel && sel.group.visible;
    if (sel) {
      this.selRing.position.copy(sel.group.position).setY(0.08);
      this.selRing.material.opacity = 0.75 + 0.25 * Math.sin(sim.time * 5);
    }
    const fnode = this.focusId && sim.nodes[this.focusId];
    const app = (fnode && this.view === 'app' && this.appRigs[fnode.type]) || null;
    this.rig.visible = !!fnode && !app;
    for (const type in this.appRigs) this.appRigs[type].group.visible = this.appRigs[type] === app;
    if (app) {
      app.group.position.copy(this.nodes[this.focusId].group.position);
      app.update(fnode, dt);
    } else if (fnode) {
      this.rig.position.copy(this.nodes[this.focusId].group.position);
      this._updateRig(fnode, dt);
    }

    // camera shake is applied only for the render, then undone
    let sx = 0;
    let sy = 0;
    if (this.shake > 0.01) {
      sx = (Math.random() - 0.5) * this.shake;
      sy = (Math.random() - 0.5) * this.shake;
      this.shake *= Math.exp(-dt * 5);
    }
    this.camera.position.x += sx;
    this.camera.position.y += sy;
    this.camera.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);

    for (const id in this.nodes) {
      const v = this.nodes[id];
      if (v.el.hidden) continue;
      if (this.focusId === id) {
        v.el.style.display = 'none';
        continue;
      }
      this._project(v, v.el, tmpV.copy(v.group.position).setY(HEIGHT[v.type] + 0.35));
    }
    // the zoom button rides at the right edge of the selected component's card
    const zv = !this.focusId && this.selectedId && !this.placing && !this.connecting ? this.nodes[this.selectedId] : null;
    const zShow = !!zv && !zv.el.hidden && zv.el.style.display !== 'none';
    this.zoomBtn.hidden = !zShow;
    if (zShow) {
      tmpV.copy(zv.group.position).setY(HEIGHT[zv.type] + 0.35).project(this.camera);
      const x = (tmpV.x * 0.5 + 0.5) * this.container.clientWidth + zv.el.offsetWidth / 2 + 6;
      const y = (-tmpV.y * 0.5 + 0.5) * this.container.clientHeight - zv.el.offsetHeight / 2;
      this.zoomBtn.style.transform = `translate(0,-50%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
    }
    for (const key in this.rigLabels) {
      const el = this.rigLabels[key];
      el.hidden = !this.rig.visible;
      if (fnode) this._project(null, el, tmpS.copy(this.rigAnchors[key]).add(this.rig.position));
    }
    for (const type in this.appRigs) {
      const r = this.appRigs[type];
      for (const key in r.labels) {
        const el = r.labels[key];
        el.hidden = r !== app || r.hide(key, fnode);
        if (!el.hidden) this._project(null, el, tmpS.copy(r.anchors[key]).add(r.group.position));
      }
    }
    this.camera.position.x -= sx;
    this.camera.position.y -= sy;
  }

  // text in labels changes far less often than positions
  updateLabels() {
    const sim = this.sim;
    for (const id in this.nodes) {
      const v = this.nodes[id];
      const n = sim.nodes[id];
      if (v.el.hidden) continue;
      const level = loadLevel(n.util, n.down);
      let stat;
      if (n.down) stat = sim.params.autoRestart ? `DOWN · restart in ${Math.max(0, Math.ceil(n.restartSecs - n.downFor))}s` : 'DOWN';
      else if (n.type === 'cache' && !n.active) stat = 'disabled';
      else if (n.type === 'db' && n.failover > 0) stat = `FAILOVER · new primary in ${Math.ceil(n.failover)}s`;
      else if (n.launching > 0) stat = `Launching… ${Math.ceil(n.launching)}s`; // autoscaled server still booting
      else if (n.type === 'kafka') stat = `${fmtRate(n.inRate)} msg/s · lag ${fmtRate(Math.max(n.lag, n.lagCH))}`;
      else if (n.type === 'lake') stat = `${fmtGB(n.storedGB)} · ${n.files.toLocaleString()} files`;
      else if (n.type === 'cdn') stat = `${fmtRate(n.inRate)} obj/s · ${Math.round(n.hit * 100)}% edge hits`;
      else if (n.type === 'scheduler') stat = n.missed > 1 ? `${Math.round(n.missed).toLocaleString()} jobs overdue` : `${fmtRate(n.outRate)} jobs/s due · ${n.aheadSecs.toFixed(0)}s queued ahead`;
      else if (n.type === 'connector') stat = `${fmtRate(n.outRate)} of ${fmtRate(n.cap || 0)} rows/s`;
      else if (n.type === 'fn') stat = `${fmtRate(n.outRate)} invocations/s · ${n.concurrency.toFixed(n.concurrency < 10 ? 1 : 0)} concurrent`;
      else if (n.type === 'blob') stat = `${fmtGB(n.storedGB)} · ${fmtRate(n.outRate)} GET/s`;
      else if (n.type === 'clickhouse') stat = `OLAP · ${fmtRate(n.insertRate)} rows/s · ${fmtRate(n.outRate)} q/s`;
      else if (n.type === 'trino' || n.type === 'bi') stat = `${n.outRate.toFixed(1)} queries/s`;
      else if (n.type === 'queue') stat = `${Math.round(n.queue).toLocaleString()} jobs waiting`;
      else if (n.type === 'cache') stat = `${rawMetric(n, 'mem', sim.params)} · ${Math.round(n.hitRatio * n.warm * 100)}% hits${n.nodes > 1 ? ` · ${n.lostNodes ? n.nodesUp + '/' : ''}${n.nodes} nodes` : ''}`;
      else if (n.type === 'db') stat = `OLTP · ${fmtRate(n.outRate)} qps${n.shards > 1 ? ` · ${n.shards} shards` : ''}${n.replicas ? ` · ${n.replicasUp < n.replicas ? n.replicasUp + '/' : ''}${n.replicas} repl` : ''}`;
      else if (n.type === 'worker') stat = `${fmtRate(n.outRate)} jobs/s`;
      else if (n.type === 'consumer') stat = `${fmtRate(n.outRate)} msg/s`;
      else stat = `${fmtRate(n.type === 'client' ? n.outRate : n.inRate)} req/s`;
      // line 1: logo + the job it does in this system; line 2: the technology doing it
      const tech = n.tech;
      const sig = (tech ? tech.name : '') + n.label;
      if (v.techSig !== sig) {
        v.techSig = sig;
        v.elName.innerHTML = !tech ? n.label : logoSVG(tech.logo, 14) + n.label;
        v.elRole.textContent = !tech || tech.name === n.label ? '' : tech.name;
        v.decal.visible = !!tech;
        if (tech) {
          if (v.decal.material.map) v.decal.material.map.dispose();
          v.decal.material.map = new THREE.CanvasTexture(logoCanvas(tech.logo));
          v.decal.material.map.colorSpace = THREE.SRGBColorSpace;
          v.decal.material.needsUpdate = true;
        }
      }
      v.elStat.textContent = stat;
      v.elData.textContent = n.down || (n.type === 'cache' && !n.active) ? '' : fmtBits(n.bps);
      v.el.dataset.level = level;
      v.el.classList.toggle('hover', this.hoverId === id);
      v.el.classList.toggle('selected', this.selectedId === id);
      // while wiring, show which components the chosen one may connect to
      v.el.dataset.wire = !this.connecting ? '' : !this.connectFrom ? 'pick' : id === this.connectFrom ? 'from' : sim.canConnect(this.connectFrom, id) ? 'ok' : 'no';
      v.elBar.style.width = Math.min(100, n.util * 100) + '%';
      v.elBar.parentNode.style.visibility = n.type === 'client' || n.type === 'bi' ? 'hidden' : '';
    }
  }
}
