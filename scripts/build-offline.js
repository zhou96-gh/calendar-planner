import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = resolve(projectRoot, 'dist');
const packageRoot = resolve(distRoot, 'utools');
const packageFiles = ['plugin.json', 'index.html', 'preload.js', 'assets', 'src', 'themes'];
const desktopFiles = new Set([
  join(projectRoot, 'src', 'desktop'),
  join(projectRoot, 'src', 'platforms', 'desktop.js'),
  join(projectRoot, 'src', 'platforms', 'desktop-state.js')
]);

if (!packageRoot.startsWith(`${distRoot}${sep}`)) {
  throw new Error('离线打包目录必须位于 dist 目录内');
}

await rm(packageRoot, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });

for (const file of packageFiles) {
  const source = join(projectRoot, file);
  const destination = join(packageRoot, file);
  const options = { recursive: true, filter: (path) => !desktopFiles.has(path) };
  await cp(source, destination, options);
}

const bootstrap = "import { createUtoolsPlatform } from './platforms/utools.js';\n"
  + "document.documentElement.classList.add('platform-utools');\n"
  + 'globalThis.calendarPlatform = createUtoolsPlatform(window, localStorage);\n'
  + "await import('./app.js');\n";
const bootstrapPath = join(packageRoot, 'src', 'bootstrap.js');
await writeFile(bootstrapPath, bootstrap, 'utf8');

const plugin = JSON.parse(await readFile(join(packageRoot, 'plugin.json'), 'utf8'));
for (const file of [plugin.main, plugin.logo, plugin.preload]) {
  const fileStat = await stat(join(packageRoot, file));
  if (!fileStat.isFile()) {
    throw new Error(`插件运行文件不存在：${file}`);
  }
}

console.log(`离线打包目录：${packageRoot}`);
