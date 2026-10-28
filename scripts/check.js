import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');

/**
 * 检查项目自己的 JavaScript，跳过依赖和编译产物。
 */
function checkDirectory(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      checkDirectory(path);
    } else if (entry.name.endsWith('.js')) {
      const argumentsList = ['--check', path];
      execFileSync(process.execPath, argumentsList);
    }
  }
}

for (const name of ['src', 'scripts', 'tests']) {
  checkDirectory(join(root, name));
}

console.log('JavaScript 语法检查通过');
