import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MAX_WEB, fmtRate, fmtBits, fmtGB, rawMetric } from './sim.js';

// Categorical flow colours (one per kind of traffic) and reserved status colours.
export const FLOW = {
  request: 0x3987e5,
  read: 0x199e70,
  write: 0xd95926,
  event: 0x9085e9,
  job: 0xc98500,
  query: 0xd55181,
  error: 0xe66767,
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
const OVERVIEW = { pos: new THREE.Vector3(5, 32, 27), target: new THREE.Vector3(5, 0, 2.5) };
const SIDE_PANELS = 620; // px of the window covered by the two side panels

const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();

export class Scene {
  constructor(container, sim, { onSelect }) {
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
    container.appendChild(this.labelLayer);

    this._buildNodes();
    this._layoutWebs();
    for (const id in this.nodes) this.nodes[id].group.position.copy(this.nodes[id].target);
    this._buildLinks();
    this._buildParticles();
    this._buildRig();
    this._bindPointer();

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
      cache: [4, -6.5],
      db: [10, -3.5],
      queue: [4, 2],
      worker: [10, 2.5],
      kafka: [4, 9.5],
      consumer: [10, 8],
      lake: [16, 8],
      trino: [22, 8],
      clickhouse: [10, 13.5],
      bi: [16, 13.5],
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
      else v.target.set(-2, 0, 0);
      group.position.copy(v.target);

      const el = document.createElement('div');
      el.className = 'node-label';
      el.innerHTML = '<div class="nl-name"></div><div class="nl-stat"></div><div class="nl-bar"><i></i></div><div class="nl-data"></div>';
      this.labelLayer.appendChild(el);
      v.el = el;
      v.elName = el.children[0];
      v.elStat = el.children[1];
      v.elBar = el.children[2].firstChild;
      v.elData = el.children[3];

      this.scene.add(group);
      this.nodes[id] = v;
    }
  }

  _layoutWebs() {
    const n = this.sim.params.webCount;
    for (let i = 0; i < MAX_WEB; i++) {
      const v = this.nodes['web' + i];
      const idx = Math.min(i, n - 1);
      v.target.set(-1.5, 0, (idx - (n - 1) / 2) * 3.9);
    }
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
      this.links.push({ id: `${from}>${to}`, from: this.nodes[from], to: this.nodes[to], color: new THREE.Color(color), line, acc: 0 });
    };
    add('client', 'lb', FLOW.request);
    for (let i = 0; i < MAX_WEB; i++) {
      const w = 'web' + i;
      add('lb', w, FLOW.request);
      add(w, 'cache', FLOW.read);
      add(w, 'db', FLOW.write);
      add(w, 'queue', FLOW.job);
      add(w, 'kafka', FLOW.event);
    }
    add('cache', 'db', FLOW.read);
    add('queue', 'worker', FLOW.job);
    add('kafka', 'consumer', FLOW.event);
    add('kafka', 'clickhouse', FLOW.event);
    add('consumer', 'lake', FLOW.event);
    add('bi', 'clickhouse', FLOW.query);
    add('bi', 'trino', FLOW.query);
    add('trino', 'lake', FLOW.query);
  }

  // ------------------------------------------------------------ particles
  _buildParticles() {
    // traffic dots travelling along links
    const MAXP = (this.MAXP = 4000);
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
    const pick = (e) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects(this.hitMeshes.filter((m) => m.parent.visible))[0];
      return hit ? hit.object.userData.id : null;
    };
    let down = null;
    dom.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
    dom.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const id = pick(e);
      if (id) this.onSelect(id);
    });
    dom.addEventListener('pointermove', (e) => {
      this.hoverId = pick(e);
      dom.style.cursor = this.hoverId ? 'pointer' : '';
    });
  }

  focus(id) {
    this.focusId = id;
    this.labelLayer.classList.toggle('focused', !!id);
    if (!id) {
      this.tween = { pos: this._overviewPos(), target: OVERVIEW.target.clone() };
      return;
    }
    const p = this.nodes[id].target;
    this.tween = { pos: new THREE.Vector3(p.x + 0.3, 7, p.z + 3.2), target: new THREE.Vector3(p.x, 0.4, p.z) };
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
    const fit = Math.max(0.9, 1.17 / free);
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
      v.group.visible = n.active || n.type === 'cache';
      v.el.hidden = !v.group.visible;
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
      const s = this.hoverId === id && !focused ? 1.06 : 1;
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

    // links + traffic particles
    for (const L of this.links) {
      const rate = sim.flows[L.id] || 0;
      const show = L.from.group.visible && L.to.group.visible;
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
      L.acc += simDt * Math.min(95, 0.9 * Math.sqrt(rate));
      while (L.acc >= 1) {
        L.acc -= 1;
        if (this.parts.length < this.MAXP)
          this.parts.push({ L, t: 0, speed: (7.5 + Math.random() * 2) / a.distanceTo(b), off: (Math.random() - 0.5) * 0.3, lift: 0.5 + Math.random() * 0.3 });
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
      tmpV.set(a.x + (b.x - a.x) * p.t, hA + (hB - hA) * p.t + Math.sin(p.t * Math.PI) * p.lift, a.z + (b.z - a.z) * p.t + p.off);
      tmpM.makeTranslation(tmpV.x, tmpV.y, tmpV.z);
      this.pMesh.setMatrixAt(i, tmpM);
      this.pMesh.setColorAt(i, p.L.color);
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
    const fnode = this.focusId && sim.nodes[this.focusId];
    this.rig.visible = !!fnode;
    if (fnode) {
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
    for (const key in this.rigLabels) {
      const el = this.rigLabels[key];
      el.hidden = !fnode;
      if (fnode) this._project(null, el, tmpS.copy(this.rigAnchors[key]).add(this.rig.position));
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
      if (n.down) stat = sim.params.autoRestart ? `DOWN · restart in ${Math.max(0, Math.ceil(8 - n.downFor))}s` : 'DOWN';
      else if (n.type === 'cache' && !n.active) stat = 'disabled';
      else if (n.type === 'kafka') stat = `${fmtRate(n.inRate)} msg/s · lag ${fmtRate(Math.max(n.lag, n.lagCH))}`;
      else if (n.type === 'lake') stat = `${fmtGB(n.storedGB)} · ${n.files.toLocaleString()} files`;
      else if (n.type === 'clickhouse') stat = `${fmtRate(n.insertRate)} rows/s · ${fmtRate(n.outRate)} q/s`;
      else if (n.type === 'trino' || n.type === 'bi') stat = `${n.outRate.toFixed(1)} queries/s`;
      else if (n.type === 'queue') stat = `depth ${fmtRate(n.queue)}`;
      else if (n.type === 'cache') stat = `${Math.round(n.hitRatio * n.warm * 100)}% hits`;
      else if (n.type === 'db') stat = `${fmtRate(n.outRate)} qps`;
      else if (n.type === 'worker') stat = `${fmtRate(n.outRate)} jobs/s`;
      else if (n.type === 'consumer') stat = `${fmtRate(n.outRate)} msg/s`;
      else stat = `${fmtRate(n.type === 'client' ? n.outRate : n.inRate)} req/s`;
      v.elName.textContent = n.label;
      v.elStat.textContent = stat;
      v.elData.textContent = n.down || (n.type === 'cache' && !n.active) ? '' : fmtBits(n.bps);
      v.el.dataset.level = level;
      v.elBar.style.width = Math.min(100, n.util * 100) + '%';
      v.elBar.parentNode.style.visibility = n.type === 'client' || n.type === 'bi' ? 'hidden' : '';
    }
  }
}
