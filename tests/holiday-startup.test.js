import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { constants, runInNewContext } from 'node:vm';
import { BUILT_IN_HOLIDAYS } from '../src/holiday/data.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/holiday/core.js';
import { STORAGE_VERSION, decodeState, encodeState } from '../src/holiday/storage.js';
import { createUtoolsPlatform } from '../src/platforms/utools.js';

const startupUrl = new URL('../src/startup.js', import.meta.url);
const startupSource = readFileSync(startupUrl, 'utf8');
const appUrl = new URL('../src/app.js', import.meta.url);
const appSource = readFileSync(appUrl, 'utf8');
const legacyKeys = [
  'holiday-planner-state-v6',
  'holiday-planner-state-v5',
  'holiday-planner-state-v4',
  'holiday-planner-state-v3'
];

/**
 * 用独立文档和任务队列验证启动顺序，不访问 uTools 或浏览器存储。
 */
function createStartupHarness(readyState) {
  const tasks = [];
  const listeners = new Map();
  const errors = [];
  const classes = [];
  const toast = {
    textContent: '',
    classList: { add: (...names) => classes.push(...names) }
  };

  const context = {
    document: {
      readyState,
      addEventListener: (type, callback, options) => {
        const listener = { callback, options };
        listeners.set(type, listener);
      },
      querySelector: () => toast
    },
    setTimeout: (callback, delay) => tasks.push({ callback, delay }),
    console: { error: (...args) => errors.push(args) }
  };

  const options = {
    filename: fileURLToPath(startupUrl),
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
  };

  runInNewContext(startupSource, context, options);

  return { tasks, listeners, errors, classes, toast };
}

/**
 * 执行真实读取逻辑，所有存储调用均由测试提供的 Mock 承接。
 */
function loadWithMockStorage(dbStorage) {
  const warnings = [];
  const keyStart = appSource.indexOf('const STORAGE_KEY =');
  const keyEnd = appSource.indexOf('const WEEKDAY_LABELS =');
  const functionStart = appSource.indexOf('function cloneBuiltInHolidays() {');
  const functionEnd = appSource.indexOf('\nfunction persist(');
  const dateStart = appSource.indexOf('function toLocalDateKey(date) {');
  const dateEnd = appSource.indexOf('\nfunction formatDays(');
  const source = appSource.slice(keyStart, keyEnd) + appSource.slice(functionStart, functionEnd)
    + appSource.slice(dateStart, dateEnd) + '\nloadState();';

  const context = {
    window: { utools: { dbStorage } },
    console: { warn: (...args) => warnings.push(args) },
    BUILT_IN_HOLIDAYS,
    DEFAULT_SETTINGS,
    STORAGE_VERSION,
    decodeState,
    encodeState,
    storageReadError: null,
    sanitizeSettings
  };

  context.calendarPlatform = createUtoolsPlatform(context.window, undefined);
  const state = runInNewContext(source, context);

  return { state, warnings };
}

const testEntry = () => {
  const htmlUrl = new URL('../index.html', import.meta.url);
  const html = readFileSync(htmlUrl, 'utf8');
  assert.ok(html.includes('<script defer src="src/startup.js"></script>'));
  assert.ok(!html.includes('src="src/app.js"'));
};
test('页面只载入轻量入口，不在页面就绪前执行业务模块', testEntry);

const testLoading = () => {
  for (const readyState of ['loading', 'interactive']) {
    const harness = createStartupHarness(readyState);
    assert.equal(harness.tasks.length, 0);
    assert.equal(harness.errors.length, 0);
    const ready = harness.listeners.get('DOMContentLoaded');
    assert.equal(ready.options.once, true);

    ready.callback();

    assert.equal(harness.tasks.length, 1);
    assert.equal(harness.tasks[0].delay, 0);
    assert.equal(harness.errors.length, 0);
  }
};
test('页面加载中或 defer 执行时先等待事件，就绪回调只安排独立任务', testLoading);

const testReady = () => {
  const harness = createStartupHarness('complete');
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.tasks.length, 1);
  assert.equal(harness.tasks[0].delay, 0);
  assert.equal(harness.errors.length, 0);
};
test('页面已就绪时仍通过独立任务启动，不同步执行初始化', testReady);

const testImportFailure = async () => {
  const harness = createStartupHarness('complete');

  // Node 没有浏览器 window，真实业务模块会拒绝加载，用于验证入口的失败提示。
  await harness.tasks[0].callback();

  assert.equal(harness.errors.length, 1);
  assert.equal(harness.errors[0][0], '假期安排启动失败');
  assert.equal(harness.toast.textContent, '假期安排启动失败，请重新打开插件');
  const expectedClasses = ['visible', 'error'];
  assert.deepEqual(harness.classes, expectedClasses);
};
test('业务模块载入失败会被捕获并显示提示', testImportFailure);

const testSavedState = () => {
  const saved = encodeState({
    settings: DEFAULT_SETTINGS,
    holidays: BUILT_IN_HOLIDAYS,
    loadedYears: [2026],
    adjustments: [],
    appearance: 'dark'
  });

  const removed = [];
  const dbStorage = {
    getItem: () => saved,
    removeItem: (key) => {
      removed.push(key);

      if (key === legacyKeys[0]) throw new Error('模拟清理失败');
    },
    setItem: () => assert.fail('读取有效数据不应覆盖存储')
  };

  const result = loadWithMockStorage(dbStorage);
  const expected = decodeState(saved);
  assert.deepEqual(result.state, expected);
  assert.deepEqual(removed, legacyKeys);
  assert.equal(result.warnings.length, 1);
};
test('单个旧键清理失败不影响已保存设置，也不阻止其余键清理', testSavedState);

const testFreshState = () => {
  const removed = [];
  const dbStorage = {
    getItem: () => null,
    removeItem: (key) => {
      removed.push(key);
      throw new Error('模拟存储未就绪');
    },
    setItem: () => assert.fail('首次读取不应写入默认数据')
  };

  const result = loadWithMockStorage(dbStorage);
  assert.equal(result.state.version, STORAGE_VERSION);
  assert.equal(result.state.appearance, 'system');
  assert.equal(result.state.loadedYears[0], 2026);
  assert.deepEqual(removed, legacyKeys);
  assert.equal(result.warnings.length, legacyKeys.length);
};
test('首次安装即使所有旧键清理失败，仍可获得默认状态', testFreshState);

const testReadFailure = () => {
  const dbStorage = {
    getItem: () => { throw new Error('模拟读取失败'); },
    removeItem: () => { throw new Error('模拟清理失败'); },
    setItem: () => assert.fail('读取失败不应覆盖存储')
  };

  const result = loadWithMockStorage(dbStorage);
  assert.equal(result.state.version, STORAGE_VERSION);
  assert.equal(result.warnings.length, legacyKeys.length + 1);
};
test('读取与旧键清理同时失败时，仍回退默认状态且不写入数据', testReadFailure);
