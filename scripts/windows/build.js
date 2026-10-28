import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoot = resolve(root, 'dist', 'windows');
const relativeOutput = relative(resolve(root, 'dist'), outputRoot);

if (relativeOutput.startsWith('..') || isAbsolute(relativeOutput)) {
  throw new Error('绿色版必须输出到项目 dist 目录');
}

let scriptPath = resolve(root, 'scripts', 'windows', 'build.ps1');
let powershell = 'pwsh';

if (process.platform !== 'win32') {
  const argumentsList = ['-w', scriptPath];
  scriptPath = execFileSync('wslpath', argumentsList, { encoding: 'utf8' }).trim();
  powershell = 'pwsh.exe';
}

const argumentsList = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 };
const output = execFileSync(powershell, argumentsList, options);
process.stdout.write(output);
const artifactLine = output.split('\n').find((line) => line.startsWith('ARTIFACT_ROOT='));

if (!artifactLine) throw new Error('未找到 Windows 构建产物目录');

let artifactRoot = artifactLine.slice('ARTIFACT_ROOT='.length).trim();

if (process.platform !== 'win32') {
  const argumentsList = ['-u', artifactRoot];
  artifactRoot = execFileSync('wslpath', argumentsList, { encoding: 'utf8' }).trim();
}

if (!/^calendar-planner-artifacts-[a-f0-9]{32}$/.test(basename(artifactRoot))) {
  throw new Error('构建产物不属于本次临时目录');
}

mkdirSync(outputRoot, { recursive: true });

for (const entry of readdirSync(artifactRoot, { withFileTypes: true })) {
  if (!entry.isFile()) continue;

  const source = join(artifactRoot, entry.name);
  const destination = join(outputRoot, entry.name);
  copyFileSync(source, destination);
}

const directories = [artifactRoot];

for (let index = 0; index < directories.length; index += 1) {
  const directory = directories[index];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (lstatSync(path).isSymbolicLink()) throw new Error('临时构建目录不允许符号链接');

    if (entry.isDirectory()) {
      directories.push(path);
    } else {
      unlinkSync(path);
    }
  }
}

directories.reverse().forEach((directory) => rmdirSync(directory));
console.log('Windows 绿色版目录：' + outputRoot);
