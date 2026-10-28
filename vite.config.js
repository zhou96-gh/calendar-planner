import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  clearScreen: false,
  plugins: [{
    name: 'calendar-module-entry',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replace(
        '<script defer src="src/startup.js"></script>',
        '<script type="module" src="/src/startup.js"></script>'
      )
    }
  }],
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true
  },
  build: {
    outDir: 'web-dist',
    emptyOutDir: true,
    target: 'es2022'
  }
});
