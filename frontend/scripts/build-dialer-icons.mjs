// Renders HaiVE Dialer's PNG icons and iPhone launch screens from the SVG
// sources in public/dialer/icons, with the Chrome already on the machine (no
// image library to install). Run `npm run dialer:icons` after changing an SVG
// and commit the PNGs it writes. CHROME_PATH overrides where Chrome is found.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const icons = join(root, 'public/dialer/icons');
const splash = join(root, 'public/dialer/splash');

const chrome =
  process.env.CHROME_PATH ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((path) => existsSync(path));
if (!chrome) throw new Error('Chrome not found — set CHROME_PATH.');

const work = mkdtempSync(join(tmpdir(), 'dialer-icons-'));

/** One screenshot of `body` at width × height, transparent where nothing is drawn. */
function render(out, width, height, body, background = 'transparent') {
  const page = join(work, 'page.html');
  writeFileSync(page, `<!doctype html><html><body style="margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${background}">${body}</body></html>`);
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    `--window-size=${width},${height}`,
    `--screenshot=${out}`,
    pathToFileURL(page).href,
  ]);
  console.log(`  ${out.slice(root.length + 1)}`);
}

const img = (svg, size, style = '') => `<img src="${pathToFileURL(join(icons, svg)).href}" width="${size}" height="${size}" style="display:block;${style}">`;

console.log('Icons:');
for (const size of [192, 512]) {
  render(join(icons, `icon-${size}.png`), size, size, img('icon.svg', size));
  render(join(icons, `maskable-${size}.png`), size, size, img('icon-maskable.svg', size));
}
// iOS rounds the corners itself and shows black through transparency: full-bleed.
render(join(icons, 'apple-touch-icon.png'), 180, 180, img('icon-maskable.svg', 180));
render(join(icons, 'favicon-32.png'), 32, 32, img('icon.svg', 32));
render(join(icons, 'shortcut-call-96.png'), 96, 96, img('shortcut-call.svg', 96));

// What an iPhone shows while the installed Dialer opens: the icon on the app's
// own background. iOS picks the file by the screen it is on (see dialer/index.html).
export const SPLASH_SCREENS = [
  [750, 1334],
  [828, 1792],
  [1125, 2436],
  [1170, 2532],
  [1179, 2556],
  [1206, 2622],
  [1242, 2688],
  [1284, 2778],
  [1290, 2796],
  [1320, 2868],
];
console.log('Launch screens:');
mkdirSync(splash, { recursive: true });
for (const [width, height] of SPLASH_SCREENS) {
  const size = Math.round(width * 0.3);
  const body = `<div style="display:flex;align-items:center;justify-content:center;width:${width}px;height:${height}px">${img('icon.svg', size)}</div>`;
  render(join(splash, `launch-${width}x${height}.png`), width, height, body, '#ffffff');
}

rmSync(work, { recursive: true, force: true });
