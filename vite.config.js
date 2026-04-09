import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import fs from 'node:fs/promises';
import path from 'node:path';

const geometrySourceDir = path.resolve('src/generated/geometry');
const geometryAssetDir = 'generated/geometry';

function trackGeometryAssetsPlugin() {
  return {
    name: 'track-geometry-assets',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestPath = req.url?.split('?')[0];
        if (!requestPath?.startsWith(`/${geometryAssetDir}/`) || !requestPath.endsWith('.json')) {
          next();
          return;
        }

        const fileName = path.basename(requestPath);
        const filePath = path.join(geometrySourceDir, fileName);

        try {
          const body = await fs.readFile(filePath);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(body);
        } catch {
          next();
        }
      });
    },
    async generateBundle() {
      const entries = await fs.readdir(geometrySourceDir, { withFileTypes: true });

      await Promise.all(entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(async entry => {
          const source = await fs.readFile(path.join(geometrySourceDir, entry.name));
          this.emitFile({
            type: 'asset',
            fileName: `${geometryAssetDir}/${entry.name}`,
            source,
          });
        }));
    },
  };
}

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/racetrack-3d/' : '/',
  plugins: [svelte(), trackGeometryAssetsPlugin()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        debug: 'debug.html',
      },
    },
  },
}));
