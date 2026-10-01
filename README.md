# System Design Simulator

Interactive 3D visualization of a small web service under load: clients → load balancer → web servers → cache / database, plus a job queue with workers and a Kafka stream with a consumer.

```
npm install
npm run dev
```

- Drag the traffic slider (20 → 20,000 req/s, log scale) and watch bottlenecks appear, backlogs grow and nodes explode.
- Click any component to zoom in and see its CPU, memory, storage and network, with live metrics in the side panel. `Esc` returns to the overview.
- Deep links: `?traffic=5200&web=4&focus=db&t=20` (`t` skips ahead N simulated seconds).

Code: `src/sim.js` (rate-based simulation, no rendering), `src/scene.js` (Three.js), `src/ui.js` (panels and charts).
