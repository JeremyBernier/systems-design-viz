import { defineConfig } from 'vite';

// Two pages: the simulator (index.html) and the estimation quiz (quiz.html).
//
// The site is served at jbernier.com/systems-design-viz/ (a Worker on that domain forwards the
// path to this project's Cloudflare Pages deployment: see router/). So every asset URL carries
// the /systems-design-viz/ prefix, and the build goes into a folder of that name, which makes the
// same paths work on the Pages host too. pages/_redirects sends the Pages root there.
const BASE = '/systems-design-viz/';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? BASE : '/',
  build: {
    outDir: 'dist' + BASE,
    emptyOutDir: true,
    rollupOptions: { input: { main: 'index.html', quiz: 'quiz.html' } },
  },
}));
