import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const web = join(root, 'web-dist');
const pluginRoot = join(root, 'dist', 'utools');
const html = readFileSync(join(web, 'index.html'), 'utf8');
const entry = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1];
assert.ok(entry, '桌面入口必须引用构建后的模块');
const entryPath = join(web, entry.replace(/^\//, ''));
assert.ok(existsSync(entryPath), '桌面入口模块必须存在');
assert.ok(!html.includes('src/startup.js'), '桌面包不能保留未打包的轻量入口');
const webAssets = readdirSync(join(web, 'assets'));
const hasRecommendationWindow = webAssets.some((name) => name.startsWith('recommendation-window-') && name.endsWith('.js'));
assert.ok(hasRecommendationWindow, '桌面包必须包含独立休假推荐窗口入口');
const plugin = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'));

for (const file of [plugin.main, plugin.preload, plugin.logo, 'themes/index.json', 'src/vendor/lunar.LICENSE']) {
  const path = join(pluginRoot, file);
  assert.ok(existsSync(path), path);
}

for (const directory of ['src/desktop', 'src/platforms/desktop.js', 'src/platforms/desktop-state.js', 'node_modules', 'src-tauri']) {
  const present = existsSync(join(pluginRoot, directory));
  assert.equal(present, false, '插件包不能依赖桌面实现：' + directory);
}

const bootstrap = readFileSync(join(pluginRoot, 'src/bootstrap.js'), 'utf8');
assert.ok(bootstrap.includes('createUtoolsPlatform'));
assert.ok(bootstrap.includes("document.documentElement.classList.add('platform-utools')"));
assert.ok(!bootstrap.includes('desktop'));

/**
 * 两端共享源码必须原样进入插件包，只有平台 bootstrap 由打包器选择。
 */
function verifySharedDirectory(relativePath) {
  const sourceRoot = join(root, relativePath);

  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const relativeFile = join(relativePath, entry.name);

    if (entry.isDirectory()) {
      verifySharedDirectory(relativeFile);
    } else {
      const source = readFileSync(join(root, relativeFile));
      const packaged = readFileSync(join(pluginRoot, relativeFile));
      assert.deepEqual(packaged, source, relativeFile);
    }
  }
}

for (const directory of ['src/holiday', 'src/vendor', 'themes', 'assets']) verifySharedDirectory(directory);

for (const relativeFile of ['index.html', 'src/app.js', 'src/styles.css', 'src/startup.js']) {
  const sourcePath = join(root, relativeFile);
  const packagedPath = join(pluginRoot, relativeFile);
  const source = readFileSync(sourcePath);
  const packaged = readFileSync(packagedPath);
  assert.deepEqual(packaged, source, relativeFile);
}
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const tauri = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8');
const cargoVersion = cargo.match(/^version = "([^"]+)"/m)?.[1];
assert.equal(packageLock.version, packageJson.version);
assert.equal(packageLock.packages[''].version, packageJson.version);
assert.equal(tauri.version, packageJson.version);
assert.equal(cargoVersion, packageJson.version);
console.log('双平台构建入口、插件隔离、共享源码与版本检查通过');
