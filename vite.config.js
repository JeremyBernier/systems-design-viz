import { defineConfig } from 'vite';

// Two pages: the simulator (index.html) and the estimation quiz (quiz.html).
export default defineConfig({
  build: { rollupOptions: { input: { main: 'index.html', quiz: 'quiz.html' } } },
});
