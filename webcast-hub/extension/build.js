import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

esbuild.build({
  entryPoints: [
    path.join(__dirname, 'popup.ts'), 
    path.join(__dirname, 'service-worker.ts'),
    path.join(__dirname, 'offscreen.ts')
  ],
  bundle: true,
  outdir: __dirname,
  format: 'esm',
  target: 'es2022',
  minify: false,
  define: {
    'import.meta.env.VITE_WS_URL': 'undefined',
    'import.meta.env': '{}'
  }
}).then(() => {
  console.log('Extension built successfully');
}).catch(() => process.exit(1));
