import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { BUILT_IN_HOLIDAYS } from '../src/holiday/data.js';
import {
  buildMonthGrid,
  createCalendarCalculation,
  DEFAULT_SETTINGS,
  removeAdjustmentYear,
  sanitizeSettings
} from '../src/holiday/core.js';
import { HolidayDataUnavailableError } from '../src/holiday/fetch.js';
import { createUtoolsPlatform } from '../src/platforms/utools.js';
import { createDesktopExtension } from '../src/platforms/desktop-state.js';
import {
  STORAGE_VERSION,
  decodeHolidayImport,
  decodeState,
  encodeState,
  replaceHolidayYears,
  sanitizeLoadedYears
} from '../src/holiday/storage.js';

const appUrl = new URL('../src/app.js', import.meta.url);
const appSource = readFileSync(appUrl, 'utf8');
const storageKey = 'holiday-planner-state-v7';
const historyRecord = {
  id: 'history-rest',
  associationType: 'required',
  ranges: [{
    type: 'rest',
    startDate: '2020-01-06',
    startPeriod: 'am',
    endDate: '2020-01-06',
    endPeriod: 'pm'
  }],
  note: '历史调休',
  createdAt: 1
};

const expectedHistory = [historyRecord];

/**
 * 从实际应用提取连续职责块，确保回归测试覆盖当前实现而非复制逻辑。
 */
function readAppSection(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker);
  assert.ok(start >= 0 && end > start);
  return appSource.slice(start, end);
}

/**
 * 创建独立序列化存储，模拟关闭插件后的重新读取，不连接实际数据库。
 */
function createMemoryStorage() {
  const values = new Map();
  const writes = [];
  const storage = {
    getItem: (key) => {
      const raw = values.get(key);

      if (!raw) return null;

      return JSON.parse(raw);
    },
    setItem: (key, value) => {
      const raw = JSON.stringify(value);
      values.set(key, raw);
      writes.push(key);
    },
    removeItem: (key) => values.delete(key)
  };

  return { storage, values, writes };
}

/**
 * 执行应用实际存取、导入和再次进入逻辑，仅用 Mock 替代宿主与页面。
 */
function createPersistenceHarness(storage, useBrowserStorage = false, fetchHolidayYear = async () => ({})) {
  const messages = [];
  const errors = [];
  const rendered = [];
  const prepared = [];
  const calculations = [];
  let enter;
  const utools = {
    dbStorage: storage,
    onPluginEnter: (callback) => { enter = callback; }
  };

  const context = {
    window: { utools: useBrowserStorage ? undefined : utools, confirm: () => true },
    localStorage: storage,
    console: { warn: (...args) => errors.push(args), error: (...args) => errors.push(args) },
    showToast: (message, isError) => messages.push({ message, isError }),
    render: () => {},
    buildCalendarHolidays: (holidays) => holidays,
    buildMonthGrid,
    createCalendarCalculation,
    applyLayoutDensity: () => rendered.push('density'),
    applyColors: () => rendered.push('colors'),
    renderSettings: () => rendered.push('settings'),
    renderCalendar: (calculation) => {
      rendered.push('calendar');
      calculations.push(calculation);
    },
    renderSummary: (calculation) => calculations.push(calculation),
    renderAdjustmentRecords: () => {},
    renderSelectedDate: (calculation) => calculations.push(calculation),
    renderYearResult: () => rendered.push('year'),
    renderYearDataStatus: () => rendered.push('status'),
    setView: () => {},
    elements: {
      dataStatus: { textContent: '' },
      importFile: { value: 'mock.json' },
      resetYear: { value: '2027' },
      resetData: { disabled: false }
    },
    yearFetchStates: new Map(),
    yearQuotaSources: new Map(),
    now: new Date(2026, 9, 26),
    activeDateKey: '',
    HolidayDataUnavailableError,
    fetchHolidayYear,
    prepareQuotaHolidays: async (year, sourceYear) => prepared.push({ year, sourceYear }),
    builtInColorSchemes: new Map(),
    JSON,
    structuredClone,
    BUILT_IN_HOLIDAYS,
    DEFAULT_SETTINGS,
    STORAGE_VERSION,
    decodeState,
    decodeHolidayImport,
    encodeState,
    replaceHolidayYears,
    removeAdjustmentYear,
    sanitizeLoadedYears,
    sanitizeSettings
  };

  const keySource = readAppSection('const STORAGE_KEY =', 'const WEEKDAY_LABELS =');
  const storageSource = readAppSection('function cloneBuiltInHolidays() {', 'async function loadBuiltInColorSchemes() {');
  const importSource = readAppSection('async function importData(file) {', 'function showToast(');
  const fetchSource = readAppSection('function hasHolidayData(year) {', 'function renderHolidayList(');
  const navigationSource = readAppSection('function moveMonth(offset) {', 'function exportData(');
  const dateSource = readAppSection('function toLocalDateKey(date) {', '\nfunction formatDays(');
  context.calendarPlatform = createUtoolsPlatform(context.window, context.localStorage);
  const enterSource = readAppSection('globalThis.calendarPlatform.onEnter?.(', "window.addEventListener('online'");
  const source = keySource + storageSource + importSource + fetchSource + dateSource + navigationSource
    + '\nlet storageReadError = null; let viewYear = 2026; let viewMonth = 10; let renderedYear = null; let state = loadState();\n'
    + enterSource + '\n({ getState: () => state, getQuotaSources: () => yearQuotaSources,\n'
    + 'getViewYear: () => viewYear, setViewYear: (year) => { viewYear = year; },\n'
    + 'persist, commitState, importData, resetYearData, ensureHolidayData, moveMonth });';
  const application = runInNewContext(source, context);
  const renderSource = readAppSection('function render(', 'function setView(');
  const renderView = (scope = 'all') => {
    context.renderScope = scope;
    return runInNewContext(renderSource + '\nrender(renderScope);', context);
  };

  const setPreparation = (prepare) => { context.prepareQuotaHolidays = prepare; };

  const platform = context.calendarPlatform;
  return { ...application, enter, messages, errors, rendered, prepared, calculations, renderView, setPreparation, platform };
}

const testNavigationRendering = async () => {
  const memory = createMemoryStorage();
  const fetchYear = async (year) => ({ [year + '-01-01']: { kind: 'legal', name: '元旦' } });
  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  app.setViewYear(2026);
  app.renderView();
  await app.ensureHolidayData(2027);
  assert.strictEqual(app.calculations[0], app.calculations[1]);
  assert.strictEqual(app.calculations[0], app.calculations[2]);
  app.rendered.length = 0;
  app.moveMonth(1);
  const expectedMonth = ['calendar', 'status'];
  assert.deepEqual(app.rendered, expectedMonth);
  assert.notStrictEqual(app.calculations[0], app.calculations[3]);
  app.rendered.length = 0;
  app.moveMonth(2);
  const expectedYear = ['calendar', 'year'];
  assert.deepEqual(app.rendered, expectedYear);
  await app.ensureHolidayData(2028);
  app.rendered.length = 0;
  app.renderView();
  const expectedFull = ['density', 'colors', 'settings', 'calendar', 'year'];
  assert.deepEqual(app.rendered, expectedFull);
};

test('真实切月跳过设置与同年列表，跨年刷新年度列表，每轮渲染共用独立日期上下文', testNavigationRendering);

const testAsyncCommitFailure = async () => {
  const memory = createMemoryStorage();
  let rejectWrite;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const pending = new Promise((_resolve, reject) => { rejectWrite = reject; });
  memory.storage.setItem = () => {
    markStarted();
    return pending;
  };

  const app = createPersistenceHarness(memory.storage);
  app.platform.storage = memory.storage;
  const extension = createDesktopExtension();
  Object.assign(app.platform, extension);
  const before = encodeState(app.getState());
  const first = app.commitState((draft) => {
    draft.settings.weekStartsOn = 0;
    const next = { ...app.platform.getDesktop(), appearance: { brightness: 110 } };
    app.platform.setDesktop(next);
  });
  const rejected = assert.rejects(first, /异步写入失败/);
  await started;
  const waiting = encodeState(app.getState());
  const waitingExtension = app.platform.getDesktop();
  assert.equal(waitingExtension.appearance.brightness, 100);
  assert.deepEqual(waiting, before);
  rejectWrite(new Error('异步写入失败'));
  await rejected;
  const after = encodeState(app.getState());
  const failedExtension = app.platform.getDesktop();
  assert.equal(failedExtension.appearance.brightness, 100);
  assert.deepEqual(after, before);
  const message = app.messages.at(-1);
  assert.equal(message.isError, true);
};

test('异步保存等待期间不发布状态，失败后保留原状态并提示失败', testAsyncCommitFailure);

const testSerialCommits = async () => {
  const memory = createMemoryStorage();
  const write = memory.storage.setItem;
  let finish;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  let writes = 0;
  memory.storage.setItem = async (key, value) => {
    writes += 1;

    if (writes === 1) {
      markStarted();
      await pending;
    }

    write(key, value);
  };

  const app = createPersistenceHarness(memory.storage);
  app.platform.storage = memory.storage;
  const first = app.commitState((draft) => { draft.settings.weekStartsOn = 0; });
  await started;
  const second = app.commitState((draft) => { draft.appearance = 'dark'; });
  assert.equal(writes, 1);
  finish();
  await Promise.all([first, second]);
  const reopened = createPersistenceHarness(memory.storage);
  const restored = reopened.getState();
  assert.equal(writes, 2);
  assert.equal(restored.settings.weekStartsOn, 0);
  assert.equal(restored.appearance, 'dark');
};

test('并发提交按顺序保存快照，后一次提交保留前一次已提交字段', testSerialCommits);

const testImportDuringAsyncWrite = async () => {
  for (const failFirst of [false, true]) {
    const memory = createMemoryStorage();
    const write = memory.storage.setItem;
    let finish;
    let rejectFirst;
    let markStarted;
    const pending = new Promise((resolve, reject) => { finish = resolve; rejectFirst = reject; });
    const started = new Promise((resolve) => { markStarted = resolve; });
    let writes = 0;
    memory.storage.setItem = async (key, value) => {
      writes += 1;

      if (writes === 1) {
        markStarted();
        await pending;
      }

      write(key, value);
    };

    const official = { '2027-01-02': { kind: 'work', name: '旧自动请求' } };
    const fetchYear = async () => official;
    const app = createPersistenceHarness(memory.storage, false, fetchYear);
    app.platform.storage = memory.storage;
    const loading = app.ensureHolidayData(2027);
    await started;
    const content = JSON.stringify({
      year: 2027,
      days: [{ date: '2027-01-01', name: '导入正式安排', isOffDay: true }]
    });

    const file = { text: async () => content };
    const importing = app.importData(file);
    await Promise.resolve();

    if (failFirst) {
      rejectFirst(new Error('模拟旧写入失败'));
    } else {
      finish();
    }

    await Promise.all([loading, importing]);
    const state = app.getState();
    assert.equal(state.holidays['2027-01-01'].name, '导入正式安排');
    assert.equal(state.holidays['2027-01-02'], undefined);
    const reopened = createPersistenceHarness(memory.storage);
    const restored = reopened.getState();
    assert.equal(restored.holidays['2027-01-01'].name, '导入正式安排');
    assert.equal(restored.holidays['2027-01-02'], undefined);
  }
};

test('旧年度请求写入等待期间导入同年安排，无论旧写入成功或失败都不会覆盖导入', testImportDuringAsyncWrite);

const testVisibleNextYearRefresh = async () => {
  for (const available of [true, false]) {
    const memory = createMemoryStorage();
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const fetchYear = async (year) => {
      await pending;

      if (!available) throw new HolidayDataUnavailableError(year);

      return { '2027-01-01': { kind: 'legal', name: '元旦' } };
    };

    const app = createPersistenceHarness(memory.storage, false, fetchYear);
    app.renderView();
    app.moveMonth(2);
    app.rendered.length = 0;
    finish();
    await app.ensureHolidayData(2027);
    const expected = ['calendar', 'status'];
    assert.deepEqual(app.rendered, expected);
    assert.equal(app.messages.length, 0);
  }
};

test('下一年正式安排或参考假期准备完成后，局部刷新十二月可见跨年日期', testVisibleNextYearRefresh);

const testImportDuringPreparation = async () => {
  const memory = createMemoryStorage();
  const fetchYear = async (year) => { throw new HolidayDataUnavailableError(year); };
  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  let finish;
  let started;
  const pending = new Promise((resolve) => { finish = resolve; });
  const preparing = new Promise((resolve) => { started = resolve; });
  app.setPreparation(() => {
    started();
    return pending;
  });

  const loading = app.ensureHolidayData(2027);
  await preparing;
  const content = JSON.stringify({
    year: 2027,
    days: [{ date: '2027-01-01', name: '元旦', isOffDay: true }]
  });

  const file = { text: async () => content };
  await app.importData(file);
  finish();
  await loading;
  const sources = app.getQuotaSources();
  const hasReference = sources.has(2027);
  assert.equal(hasReference, false);
  const state = app.getState();
  assert.equal(state.holidays['2027-01-01'].kind, 'block');
  assert.equal(memory.writes.length, 1);
};

test('分批准备期间导入正式安排，旧任务不能重新挂回参考状态', testImportDuringPreparation);

const testPreparationFailure = async () => {
  const memory = createMemoryStorage();
  const fetchYear = async (year) => { throw new HolidayDataUnavailableError(year); };
  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  app.setPreparation(async () => { throw new Error('模拟历法准备失败'); });
  await app.ensureHolidayData(2027);
  const sources = app.getQuotaSources();
  assert.equal(sources.size, 0);
  assert.equal(memory.writes.length, 0);
};

test('后台本地准备失败被捕获，不保存参考日期或留下未处理的拒绝', testPreparationFailure);

const testNextYearPreload = async () => {
  const memory = createMemoryStorage();
  const calls = [];
  let completeFetch;
  const pending = new Promise((resolve) => { completeFetch = resolve; });
  const fetchYear = (year) => {
    calls.push(year);

    if (year === 2027) return pending;

    return Promise.resolve({ '2028-01-01': { kind: 'legal', name: '元旦' } });
  };

  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  app.setViewYear(2026);
  app.renderView();
  app.renderView();
  const loading = app.ensureHolidayData(2027);
  const expectedCalls = [2027];
  assert.deepEqual(calls, expectedCalls);
  const calendarRenders = app.rendered.filter((part) => part === 'calendar');
  assert.equal(calendarRenders.length, 2);
  assert.equal(memory.writes.length, 0);

  const official = { '2027-01-01': { kind: 'legal', name: '元旦' } };
  completeFetch(official);
  await loading;
  await app.ensureHolidayData(2027);
  const reopened = createPersistenceHarness(memory.storage, false, fetchYear);
  await reopened.ensureHolidayData(2027);
  assert.deepEqual(calls, expectedCalls);
  assert.equal(memory.writes.length, 1);
  assert.equal(app.messages.length, 0);
  const restored = reopened.getState();
  assert.equal(restored.holidays['2027-01-01'].name, '元旦');

  app.setViewYear(2027);
  app.renderView();
  await app.ensureHolidayData(2028);
  const expectedNextCalls = [2027, 2028];
  assert.deepEqual(calls, expectedNextCalls);
  const state = app.getState();
  assert.equal(state.holidays['2028-01-01'].name, '元旦');
};

test('渲染后预加载下一年，不阻塞绘制且跨年、重开均复用缓存，同年请求去重', testNextYearPreload);

const testPreloadFailure = async () => {
  const memory = createMemoryStorage();
  const calls = [];
  const fetchYear = async (year) => {
    calls.push(year);
    throw new Error('网络不可用');
  };

  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  app.setViewYear(2026);
  const before = encodeState(app.getState());
  app.renderView();
  await app.ensureHolidayData(2027);
  app.renderView();
  const after = encodeState(app.getState());
  const expectedCalls = [2027];
  assert.deepEqual(after, before);
  assert.deepEqual(calls, expectedCalls);
  const calendarRenders = app.rendered.filter((part) => part === 'calendar');
  assert.equal(calendarRenders.length, 2);
  assert.equal(memory.writes.length, 0);
  assert.equal(app.messages.length, 0);
};

test('下一年预加载失败不影响当前页面和数据，重绘不会重复请求', testPreloadFailure);

const testRoundTrip = () => {
  const memory = createMemoryStorage();
  const app = createPersistenceHarness(memory.storage);
  const state = app.getState();
  state.adjustments = [historyRecord];
  state.settings.weekStartsOn = 1;
  state.holidays['2020-01-07'] = { kind: 'work', name: '历史修正' };
  app.persist();
  const saved = memory.storage.getItem(storageKey);
  const reopened = createPersistenceHarness(memory.storage);
  const reopenedState = reopened.getState();
  const restored = encodeState(reopenedState);

  assert.deepEqual(restored, saved);
  assert.equal(reopenedState.adjustments[0].id, historyRecord.id);
  assert.equal(reopenedState.settings.weekStartsOn, 1);
  assert.equal(memory.writes.length, 1);
};
test('调休、设置和日期修正保存后重开可完整恢复，历史记录不被删除', testRoundTrip);

const testReenter = () => {
  const memory = createMemoryStorage();
  const app = createPersistenceHarness(memory.storage);
  app.getState().adjustments = [historyRecord];
  app.persist();

  app.enter();
  app.enter();

  const saved = memory.storage.getItem(storageKey);
  const state = app.getState();
  assert.equal(state.adjustments.length, 1);
  assert.equal(memory.writes.length, 1);
  assert.equal(saved.adjustments[0].id, historyRecord.id);
};
test('重复进入插件不会自动删除或重写历史调班', testReenter);

const testImport = async () => {
  const memory = createMemoryStorage();
  const app = createPersistenceHarness(memory.storage);
  app.getState().adjustments = [historyRecord];
  const content = JSON.stringify(encodeState(app.getState()));
  const file = { text: async () => content };

  await app.importData(file);

  const reopened = createPersistenceHarness(memory.storage);
  const restored = reopened.getState();
  const message = app.messages.at(-1);
  assert.deepEqual(restored.adjustments, expectedHistory);
  assert.equal(message.message, '假期安排已导入');
};
test('导入数据及重开插件均保留历史调班记录', testImport);

const testWriteFailure = () => {
  const memory = createMemoryStorage();
  memory.storage.setItem = () => { throw new Error('模拟空间不足'); };
  const app = createPersistenceHarness(memory.storage);
  app.getState().adjustments = [historyRecord];
  const save = () => app.persist();

  assert.throws(save, /模拟空间不足/);
  const message = app.messages.at(-1);
  const stored = memory.values.has(storageKey);
  assert.equal(message.isError, true);
  assert.match(message.message, /保存失败.*模拟空间不足/);
  assert.equal(stored, false);
};
test('保存异常会明确提示失败，不产生已保存数据', testWriteFailure);

const testReadFailure = () => {
  const memory = createMemoryStorage();
  memory.storage.getItem = () => { throw new Error('模拟读取失败'); };
  const app = createPersistenceHarness(memory.storage);
  const save = () => app.persist();

  assert.throws(save, /读取失败/);
  const message = app.messages.at(-1);
  assert.equal(memory.writes.length, 0);
  assert.equal(message.isError, true);
};
test('读取失败后禁止用默认状态覆盖原存储', testReadFailure);

const testInvalidData = () => {
  const memory = createMemoryStorage();
  const invalid = JSON.stringify({ version: 100, adjustments: [historyRecord] });
  memory.values.set(storageKey, invalid);
  const app = createPersistenceHarness(memory.storage);
  const save = () => app.persist();

  assert.throws(save, /读取失败/);
  const raw = memory.values.get(storageKey);
  assert.equal(raw, invalid);
};
test('无法解码的存储不会被后续操作静默覆盖', testInvalidData);

const testImportReadProtection = async () => {
  const memory = createMemoryStorage();
  memory.storage.getItem = () => { throw new Error('模拟读取失败'); };
  const app = createPersistenceHarness(memory.storage);
  app.getState().adjustments = [historyRecord];
  const content = JSON.stringify(encodeState(app.getState()));
  const file = { text: async () => content };

  await app.importData(file);

  const message = app.messages.at(-1);
  assert.equal(memory.writes.length, 0);
  assert.match(message.message, /原数据读取失败/);
  assert.equal(message.isError, true);
};

test('只导入假期安排不能解除原存储读取失败保护', testImportReadProtection);

const testResetYear = async () => {
  const memory = createMemoryStorage();
  const official = { '2027-01-01': { kind: 'legal', name: '元旦' } };
  const fetchYear = async (year) => {
    assert.equal(year, 2027);
    return official;
  };

  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  const initial = app.getState();
  const oldDate = { kind: 'work', name: '旧修正' };
  initial.holidays['2027-01-02'] = oldDate;
  const currentRange = {
    type: 'rest', startDate: '2027-03-01', startPeriod: 'am', endDate: '2027-03-01', endPeriod: 'pm'
  };

  const currentRecord = { ...historyRecord, id: 'current', ranges: [currentRange] };
  initial.adjustments = [historyRecord, currentRecord];

  await app.resetYearData();

  const saved = memory.storage.getItem(storageKey);
  const restored = decodeState(saved);
  assert.equal(restored.holidays['2027-01-02'], undefined);
  assert.equal(restored.holidays['2027-01-01'].name, '元旦');
  assert.deepEqual(restored.adjustments, expectedHistory);
  assert.equal(restored.settings.anchorMonday, initial.settings.anchorMonday);
  assert.ok(restored.holidays['2026-10-01']);
  const message = app.messages.at(-1);
  assert.equal(message.message, '2027 年数据已重置');
};

test('年份重置重新获取官方安排，仅清理指定年份个人数据并保存', testResetYear);

const testResetFetchFailure = async () => {
  const memory = createMemoryStorage();
  const fetchYear = async () => { throw new Error('该年份暂无节假日数据'); };
  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  const initial = app.getState();
  const before = encodeState(initial);

  await app.resetYearData();

  const current = app.getState();
  const after = encodeState(current);
  const message = app.messages.at(-1);
  assert.deepEqual(after, before);
  assert.equal(memory.writes.length, 0);
  assert.match(message.message, /重置失败，原数据已保留/);
};

test('年份重置获取失败时保留全部原数据且不写存储', testResetFetchFailure);

const testResetSaveFailure = async () => {
  const memory = createMemoryStorage();
  memory.storage.setItem = () => { throw new Error('存储不可用'); };
  const official = { '2027-01-01': { kind: 'legal', name: '元旦' } };
  const fetchYear = async () => official;
  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  const initial = app.getState();
  const before = encodeState(initial);

  await app.resetYearData();

  const current = app.getState();
  const after = encodeState(current);
  const message = app.messages.at(-1);
  assert.deepEqual(after, before);
  assert.equal(message.isError, true);
};

test('年份重置保存失败时恢复内存中的原安排和个人调班', testResetSaveFailure);

const testStaleFetch = async () => {
  const memory = createMemoryStorage();
  let resolveFetch;
  const pending = new Promise((resolve) => { resolveFetch = resolve; });
  const fetchYear = () => pending;
  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  const loading = app.ensureHolidayData(2027);
  const imported = {
    version: 7,
    holidayData: { blocks: [], days: { '2027-01-01': { kind: 'legal', name: '导入安排' } } },
    loadedYears: [2027]
  };

  const content = JSON.stringify(imported);
  const file = { text: async () => content };
  await app.importData(file);
  const fetched = { '2027-01-02': { kind: 'work', name: '旧请求' } };
  resolveFetch(fetched);
  await loading;

  const state = app.getState();
  assert.equal(state.holidays['2027-01-01'].name, '导入安排');
  assert.equal(state.holidays['2027-01-02'], undefined);
  assert.equal(memory.writes.length, 1);
};

test('进行中的自动获取不能覆盖用户后来导入的同年安排', testStaleFetch);

const testAutoFetchSaveFailure = async () => {
  const memory = createMemoryStorage();
  memory.storage.setItem = () => { throw new Error('存储不可用'); };
  const official = { '2027-01-01': { kind: 'legal', name: '元旦' } };
  const fetchYear = async () => official;
  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  const initial = app.getState();
  const before = encodeState(initial);

  await app.ensureHolidayData(2027);

  const current = app.getState();
  const after = encodeState(current);
  const message = app.messages.at(-1);
  assert.deepEqual(after, before);
  assert.equal(message.isError, true);
};

test('自动获取保存失败时也回滚安排和已载入年份', testAutoFetchSaveFailure);

const testQuotaFallback = async () => {
  const memory = createMemoryStorage();
  const calls = [];
  const fetchYear = async (year) => {
    calls.push(year);
    throw new HolidayDataUnavailableError(year);
  };

  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  app.setViewYear(2027);
  const sourceYear = await app.ensureHolidayData(2027);
  const state = app.getState();
  const sources = app.getQuotaSources();
  const expectedCalls = [2027];
  const expectedPreparation = [{ year: 2027, sourceYear: 2026 }];
  const viewYear = app.getViewYear();
  const targetLoaded = state.loadedYears.includes(2027);
  const referenceYear = sources.get(2027);
  assert.equal(sourceYear, 2026);
  assert.equal(referenceYear, 2026);
  assert.equal(viewYear, 2027);
  assert.deepEqual(calls, expectedCalls);
  assert.deepEqual(app.prepared, expectedPreparation);
  assert.equal(targetLoaded, false);
  assert.equal(state.holidays['2027-02-05'], undefined);
  assert.equal(memory.writes.length, 0);
};

test('当前年无安排时复用最近本地年度额度，不切换年份或保存估算日期', testQuotaFallback);

const testFetchPreviousYear = async () => {
  const memory = createMemoryStorage();
  const calls = [];
  const official = { '2026-01-01': { kind: 'legal', name: '元旦' } };
  const fetchYear = async (year) => {
    calls.push(year);

    if (year === 2027) throw new HolidayDataUnavailableError(year);

    return official;
  };

  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  const initial = app.getState();
  initial.holidays = {};
  initial.loadedYears = [];
  const sourceYear = await app.ensureHolidayData(2027);
  const saved = memory.storage.getItem(storageKey);
  const restored = decodeState(saved);
  const expectedCalls = [2027, 2026];
  const targetLoaded = restored.loadedYears.includes(2027);
  const sourceLoaded = restored.loadedYears.includes(2026);
  assert.equal(sourceYear, 2026);
  assert.deepEqual(calls, expectedCalls);
  assert.equal(restored.holidays['2026-01-01'].name, '元旦');
  assert.equal(targetLoaded, false);
  assert.equal(sourceLoaded, true);
};

test('本地没有源年数据时向前获取，并仅持久化实际已发布年份', testFetchPreviousYear);

const testNetworkNoFallback = async () => {
  const memory = createMemoryStorage();
  const calls = [];
  const fetchYear = async (year) => {
    calls.push(year);
    throw new Error('网络不可用');
  };

  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  await app.ensureHolidayData(2027);
  const expectedCalls = [2027];
  const sources = app.getQuotaSources();
  assert.deepEqual(calls, expectedCalls);
  assert.equal(sources.size, 0);
};

test('网络异常不会启动跨年查找或借用额度', testNetworkNoFallback);

const testResetWithoutFallback = async () => {
  const memory = createMemoryStorage();
  const calls = [];
  const fetchYear = async (year) => {
    calls.push(year);
    throw new HolidayDataUnavailableError(year);
  };

  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  await app.resetYearData();
  const expectedCalls = [2027];
  const sources = app.getQuotaSources();
  assert.deepEqual(calls, expectedCalls);
  assert.equal(sources.size, 0);
  assert.equal(memory.writes.length, 0);
};

test('手动重置精确年份失败时不采用往年额度，也不清理个人数据', testResetWithoutFallback);

const testQuotaReplacedByImport = async () => {
  const memory = createMemoryStorage();
  const fetchYear = async (year) => { throw new HolidayDataUnavailableError(year); };
  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  await app.ensureHolidayData(2027);
  const content = JSON.stringify({
    year: 2027,
    days: [{ date: '2027-01-01', name: '元旦', isOffDay: true }]
  });

  const file = { text: async () => content };
  await app.importData(file);
  const sources = app.getQuotaSources();
  const hasReference = sources.has(2027);
  const state = app.getState();
  assert.equal(hasReference, false);
  assert.equal(state.holidays['2027-01-01'].kind, 'block');
};

test('导入本年正式安排后清除本年的额度参考状态', testQuotaReplacedByImport);

const testSearchBoundary = async () => {
  const memory = createMemoryStorage();
  const calls = [];
  const fetchYear = async (year) => {
    calls.push(year);
    throw new HolidayDataUnavailableError(year);
  };

  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  await app.ensureHolidayData(1900);
  const expectedCalls = [1900];
  assert.deepEqual(calls, expectedCalls);
};

test('年度查找在支持的年份下界停止', testSearchBoundary);

const testConcurrentFallback = async () => {
  const memory = createMemoryStorage();
  const calls = [];
  const fetchYear = async (year) => {
    calls.push(year);
    throw new HolidayDataUnavailableError(year);
  };

  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  const first = app.ensureHolidayData(2027);
  const second = app.ensureHolidayData(2027);
  const results = await Promise.all([first, second]);
  const expectedResults = [2026, 2026];
  const expectedCalls = [2027];
  assert.deepEqual(results, expectedResults);
  assert.deepEqual(calls, expectedCalls);
};

test('同年并发自动加载共用一次获取和额度回退', testConcurrentFallback);

const testImportedFallbackYear = async () => {
  const memory = createMemoryStorage();
  let resolvePrevious;
  let markPreviousRequested;
  const previousRequest = new Promise((resolve) => { resolvePrevious = resolve; });
  const requested = new Promise((resolve) => { markPreviousRequested = resolve; });
  const fetchYear = async (year) => {
    if (year === 2027) throw new HolidayDataUnavailableError(year);

    markPreviousRequested();
    return previousRequest;
  };

  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  const initial = app.getState();
  initial.holidays = {};
  initial.loadedYears = [];
  const loading = app.ensureHolidayData(2027);
  await requested;
  const content = JSON.stringify({
    year: 2026,
    days: [{ date: '2026-01-01', name: '元旦', isOffDay: true }]
  });

  const file = { text: async () => content };
  await app.importData(file);
  const outdated = { '2026-01-02': { kind: 'legal', name: '旧请求日期' } };
  resolvePrevious(outdated);
  await loading;
  const state = app.getState();
  assert.equal(state.holidays['2026-01-01'].kind, 'block');
  assert.equal(state.holidays['2026-01-02'], undefined);
  assert.equal(memory.writes.length, 1);
};

test('回退源年正在获取时导入该年数据，旧请求不能补回已移除日期', testImportedFallbackYear);

const testAutoLoadDuringReset = async () => {
  const memory = createMemoryStorage();
  let completeReset;
  const pending = new Promise((resolve) => { completeReset = resolve; });
  let calls = 0;
  const fetchYear = () => {
    calls += 1;
    return pending;
  };

  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  const reset = app.resetYearData();
  await app.ensureHolidayData(2027);
  const official = { '2027-01-01': { kind: 'legal', name: '元旦' } };
  completeReset(official);
  await reset;
  const state = app.getState();
  assert.equal(calls, 1);
  assert.equal(state.holidays['2027-01-01'].name, '元旦');
  assert.equal(memory.writes.length, 1);
};

test('年份重置进行中，自动加载不会另起请求使重置失效', testAutoLoadDuringReset);

const testFailedResetKeepsQuotaSource = async () => {
  const memory = createMemoryStorage();
  const calls = [];
  const fetchYear = async (year) => {
    calls.push(year);
    throw new HolidayDataUnavailableError(year);
  };

  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  await app.ensureHolidayData(2027);
  await app.resetYearData();
  const sourceYear = await app.ensureHolidayData(2028);
  const expectedCalls = [2027, 2027, 2028];
  const sources = app.getQuotaSources();
  const nextYearSource = sources.get(2028);
  assert.equal(sourceYear, 2026);
  assert.equal(nextYearSource, 2026);
  assert.deepEqual(calls, expectedCalls);
};

test('精确重置失败后保留既有额度来源，后续年份仍可沿用最近已发布年度', testFailedResetKeepsQuotaSource);

const testRetryFailedPreloadOnNavigation = async () => {
  const memory = createMemoryStorage();
  const calls = [];
  let failed = true;
  const fetchYear = async (year) => {
    calls.push(year);

    if (year !== 2027 || failed) throw new Error('模拟临时网络错误');

    return { '2027-01-01': { kind: 'legal', name: '元旦' } };
  };

  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  app.renderView();
  await app.ensureHolidayData(2027);
  failed = false;
  app.setViewYear(2027);
  app.renderView('navigation');
  await app.ensureHolidayData(2027);
  const requested = calls.filter((year) => year === 2027);
  const state = app.getState();
  assert.equal(requested.length, 2);
  assert.equal(state.holidays['2027-01-01'].name, '元旦');
  assert.ok(state.loadedYears.includes(2027));
};

const testFailedNavigationDoesNotLoop = async () => {
  const memory = createMemoryStorage();
  const calls = [];
  const fetchYear = async (year) => {
    calls.push(year);
    throw new Error('模拟持续网络错误');
  };

  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  app.renderView();
  await app.ensureHolidayData(2027);
  app.setViewYear(2027);
  app.renderView('navigation');
  await app.ensureHolidayData(2027);
  app.renderView('navigation');
  await app.ensureHolidayData(2027);
  const requested = calls.filter((year) => year === 2027);
  assert.equal(requested.length, 2);
  assert.equal(memory.writes.length, 0);
};

const testNavigationSharesPendingReference = async () => {
  const memory = createMemoryStorage();
  const calls = [];
  const preparations = [];
  const fetchYear = async (year) => {
    calls.push(year);
    throw new HolidayDataUnavailableError(year);
  };

  const app = createPersistenceHarness(memory.storage, false, fetchYear);
  let begin;
  let finish;
  const started = new Promise((resolve) => { begin = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  const ready = Promise.resolve();

  app.setPreparation((year) => {
    preparations.push(year);

    if (year === 2027) begin();

    return year === 2027 ? pending : ready;
  });

  app.renderView();
  await started;
  app.setViewYear(2027);
  app.renderView('navigation');
  finish();
  await app.ensureHolidayData(2027);
  app.setViewYear(2026);
  app.renderView('navigation');
  app.setViewYear(2027);
  app.renderView('navigation');
  await app.ensureHolidayData(2027);
  const requested = calls.filter((year) => year === 2027);
  const prepared = preparations.filter((year) => year === 2027);
  const sourceYear = app.getQuotaSources().get(2027);
  assert.equal(requested.length, 1);
  assert.equal(prepared.length, 1);
  assert.equal(sourceYear, 2026);
  assert.equal(memory.writes.length, 0);
};

const testRetryReferenceChainOnNavigation = async () => {
  for (const recovered of [true, false]) {
    const memory = createMemoryStorage();
    const calls = [];
    let preloading = true;
    const fetchYear = async (year) => {
      calls.push(year);

      if (year === 2027 && (preloading || !recovered)) throw new Error('模拟参考年份临时失败');

      throw new HolidayDataUnavailableError(year);
    };

    const app = createPersistenceHarness(memory.storage, false, fetchYear);
    app.renderView();
    await app.ensureHolidayData(2027);
    preloading = false;
    app.setViewYear(2028);
    app.renderView('navigation');
    await app.ensureHolidayData(2028);
    app.renderView('navigation');
    await app.ensureHolidayData(2028);
    const retried = calls.filter((year) => year === 2027);
    const sources = app.getQuotaSources();
    assert.equal(retried.length, 2);
    const sourceYear = sources.get(2028);
    const expectedSource = recovered ? 2026 : undefined;
    const hasReference = sources.has(2028);
    assert.equal(sourceYear, expectedSource);
    assert.equal(hasReference, recovered);
    assert.equal(memory.writes.length, 0);
  }
};

test('失败的后台预加载在切入该年份时重新获取，成功后恢复年度安排', testRetryFailedPreloadOnNavigation);
test('切年重试再次失败后同年重绘不会自动循环请求', testFailedNavigationDoesNotLoop);
test('切年复用正在准备及已完成的参考假期，不重开预加载或重复全年准备', testNavigationSharesPendingReference);
test('跳过失败年份切至远年时参考链也按需重试，再次失败不会循环', testRetryReferenceChainOnNavigation);

const testBrowserStorage = () => {
  const memory = createMemoryStorage();
  const storage = {
    getItem: (key) => memory.values.get(key) ?? null,
    setItem: (key, value) => memory.values.set(key, value),
    removeItem: (key) => memory.values.delete(key)
  };

  const app = createPersistenceHarness(storage, true);
  app.getState().adjustments = [historyRecord];
  app.persist();
  const reopened = createPersistenceHarness(storage, true);
  const restored = reopened.getState();
  assert.deepEqual(restored.adjustments, expectedHistory);
};
test('浏览器 localStorage 分支也可在重开后恢复历史记录', testBrowserStorage);
