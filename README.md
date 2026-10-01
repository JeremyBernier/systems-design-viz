# System Design Simulator

Interactive 3D visualization of a small web service under load: clients → load balancer → web servers → cache / database, plus a job queue with workers, and an analytics side fed by Kafka: a lake writer committing Parquet files to an S3 + Iceberg data lake, ClickHouse for real-time queries, Trino for SQL on the lake, and dashboards querying both.

```
npm install
npm run dev
```

- Drag the traffic slider (20 → 20,000 req/s, log scale) and watch bottlenecks appear, backlogs grow and nodes explode.
- Click any component to zoom in and see its CPU, memory, storage and network, with live metrics in the side panel. `Esc` returns to the overview.
- **System** presets (YouTube, Instagram, Uber, a simple web app) reconfigure components, technologies and traffic.
- **Build**: place components, drag them around, and use *Connect components* to wire sensible pairs together. Click a component to change its technology (e.g. PostgreSQL → DynamoDB, EC2 → Lambda), toggle its connections or remove it.
- Estimated monthly cost is shown in the header, with a per-component breakdown in the right panel. Prices are ballpark public on-demand list prices and live in `src/tech.js`.
- Deep links: `?preset=uber&traffic=5200&web=4&db=dynamodb&olap=snowflake&queries=120&compaction=0&focus=db&t=20` (`t` skips ahead N simulated seconds).

Code: `src/sim.js` (rate-based simulation, no rendering), `src/tech.js` (technology catalog, logos, prices), `src/presets.js`, `src/cost.js`, `src/scene.js` (Three.js), `src/ui.js` (panels and charts).
