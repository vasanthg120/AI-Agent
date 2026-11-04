// @ts-check
// HaiVE Dialer (/dialer/): a second, separately installable app built from the
// same source as HaiVE. This Vite plugin
//   - adds the Dialer's page (dialer/index.html) as a second entry of the build,
//   - serves that page for the Dialer's own deep links (/dialer/recents…) in
//     `vite` and `vite preview`, as Nginx does in production, and
//   - writes the Dialer's service worker (dialer/sw.js → dist/dialer/sw.js),
//     filled in with exactly the files the Dialer loads, and a version that
//     changes whenever any of them does — which is how an open Dialer learns
//     that a new version is out.
// Plain JavaScript so the build's own type check needs no Node type package.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SW_TEMPLATE = join(root, 'dialer/sw.js');
const PUBLIC_DIALER = join(root, 'public/dialer');

/** The files under public/dialer the Dialer itself uses (manifest, icons), as served
 * paths. Not the iPhone launch screens: iOS fetches those once, when it is installed.
 * @returns {string[]} */
function publicFiles(dir = PUBLIC_DIALER, prefix = '/dialer') {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) return [`${prefix}/${name}`];
    return name === 'splash' ? [] : publicFiles(full, `${prefix}/${name}`);
  });
}

/** @param {import('node:http').IncomingMessage} req @param {unknown} _res @param {() => void} next */
function servePage(req, _res, next) {
  const [path, query = ''] = (req.url ?? '').split('?');
  if (/^\/dialer(\/[^.]*)?$/.test(path) && req.headers.accept?.includes('text/html')) {
    req.url = `/dialer/index.html${query ? `?${query}` : ''}`;
  }
  next();
}

/** @returns {import('vite').Plugin} */
export function haiveDialer() {
  return {
    name: 'haive-dialer',
    config() {
      return { build: { rollupOptions: { input: { main: join(root, 'index.html'), dialer: join(root, 'dialer/index.html') } } } };
    },
    configureServer(server) {
      server.middlewares.use(servePage);
    },
    configurePreviewServer(server) {
      server.middlewares.use(servePage);
    },
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find((file) => file.type === 'chunk' && file.isEntry && file.name === 'dialer');
      if (!entry || entry.type !== 'chunk') return;
      // The entry, everything it imports (now or on demand), and their styles and assets.
      /** @type {Set<string>} */
      const files = new Set();
      /** @param {string} fileName */
      const visit = (fileName) => {
        if (files.has(fileName)) return;
        files.add(fileName);
        const chunk = bundle[fileName];
        if (chunk?.type !== 'chunk') return;
        [...chunk.imports, ...chunk.dynamicImports].forEach(visit);
        chunk.viteMetadata?.importedCss.forEach((css) => files.add(css));
        chunk.viteMetadata?.importedAssets.forEach((asset) => files.add(asset));
      };
      visit(entry.fileName);
      const precache = ['/dialer/index.html', ...[...files].map((f) => `/${f}`), ...publicFiles()].sort();
      const template = readFileSync(SW_TEMPLATE, 'utf8');
      const version = createHash('sha256').update(precache.join('\n')).update(template).digest('hex').slice(0, 12);
      const source = template
        .replace("const VERSION = 'dev';", `const VERSION = '${version}';`)
        .replace('const PRECACHE = [];', `const PRECACHE = ${JSON.stringify(precache, null, 2)};`);
      this.emitFile({ type: 'asset', fileName: 'dialer/sw.js', source });
    },
  };
}
