import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_HOLIDAYS } from '../src/holiday/data.js';
import { DEFAULT_SETTINGS } from '../src/holiday/core.js';
import { decodeState, encodeState } from '../src/holiday/storage.js';
import { createDesktopExtension, decodeDesktopState, encodeDesktopState, sanitizeDesktop } from '../src/platforms/desktop-state.js';
import { createUtoolsPlatform } from '../src/platforms/utools.js';

/**
 * 平台往返使用纯对象，不连接 SQLite 或宿主。
 */
function calendarFixture() {
  const holidays = { ...BUILT_IN_HOLIDAYS };
  delete holidays['2026-01-01'];
  holidays['2028-05-01'] = { kind: 'work', name: '自定义修正' };

  return encodeState({
    settings: DEFAULT_SETTINGS,
    holidays,
    loadedYears: [2026, 2027],
    appearance: 'dark',
    layoutDensity: 'compact',
    colorSchemeId: 'custom',
    customColors: { light: {}, dark: { primary: '#123456', 'rest-bg': '#12345688' } },
    adjustments: [{
      id: 'operation-1', associationType: 'none', note: '多段调班', createdAt: 1,
      ranges: [
        { type: 'rest', startDate: '2026-09-21', startPeriod: 'am', endDate: '2026-09-21', endPeriod: 'am' },
        { type: 'work', startDate: '2026-09-20', startPeriod: 'pm', endDate: '2026-09-20', endPeriod: 'pm' },
        { type: 'rest', startDate: '2026-09-22', startPeriod: 'am', endDate: '2026-09-22', endPeriod: 'pm' }
      ]
    }]
  });
}

const testDesktopRoundTrip = () => {
  const calendar = calendarFixture();
  const desktop = sanitizeDesktop({
    todos: [{ id: 'todo-1', date: '2026-10-28', text: '准备资料', done: false, createdAt: 1 }],
    appearance: { brightness: 110, backgroundTransparency: 45, fontSizeOffset: 2 }
  });

  const schemes = new Map();
  const native = encodeDesktopState(calendar, desktop, schemes);
  const restored = decodeDesktopState(native);
  assert.deepEqual(restored.calendar, calendar);
  assert.deepEqual(restored.desktop, desktop);
  assert.equal(native.adjustments[0].compensationRequired, false);
  assert.equal(native.adjustments[0].counterRanges.length, 2);
  assert.equal(native.settings.palettes.dark['rest-bg'], '#12345688');
  assert.equal(native.settings.layoutDensity, 'compact');
  const restoredState = decodeState(restored.calendar);
  assert.equal(restoredState.holidays['2026-01-01'], undefined);
  assert.equal(restoredState.holidays['2028-05-01'].kind, 'work');
};

test('桌面 DTO 无损保留多段调班、空年度、稀疏深色覆盖、透明色、删除日期及待办', testDesktopRoundTrip);

const testLegacyImport = () => {
  const calendar = calendarFixture();
  const desktop = sanitizeDesktop();
  const schemes = new Map();
  const native = encodeDesktopState(calendar, desktop, schemes);
  delete native.settings.layoutDensity;
  const previous = decodeDesktopState(native);
  const previousState = decodeState(previous.calendar);
  assert.equal(previousState.layoutDensity, 'spacious');
  native.version = 11;
  native.holidayCache = {};
  native.holidayOverrides = { '2026-01-01': null };
  native.settings.paletteScheme = 'calendar-colors-08-fresh-v2';
  const restored = decodeDesktopState(native, true);
  const state = decodeState(restored.calendar);
  assert.equal(state.holidays['2026-01-01'], undefined);
  assert.equal(state.holidays['2026-10-01'].kind, 'block');
  assert.equal(state.colorSchemeId, 'calendar-colors-08-fresh-v2.json');
  assert.equal(state.layoutDensity, 'spacious');
  const implicitImport = () => decodeDesktopState(native);
  assert.throws(implicitImport, /不支持的桌面/);
};

test('旧桌面备份仅显式导入时按内置与删除标记还原，方案标识转换到公共格式', testLegacyImport);

const testInvalidContainers = () => {
  const calendar = calendarFixture();
  const desktop = sanitizeDesktop();
  const schemes = new Map();
  const native = encodeDesktopState(calendar, desktop, schemes);
  const damages = [
    (value) => { value.settings = []; },
    (value) => { value.holidayCache = []; },
    (value) => { value.holidayOverrides = 'invalid'; },
    (value) => { value.holidayCache[2026] = []; },
    (value) => { value.holidayCache.bad = {}; },
    (value) => { value.holidayCache[2026]['2027-01-01'] = { kind: 'legal', name: '错误年份' }; },
    (value) => { value.holidayOverrides['2027-99-99'] = null; },
    (value) => { value.holidayOverrides['2027-01-01'] = { kind: 'invalid' }; },
    (value) => { value.adjustments[0].counterRanges[0].startPeriod = 'invalid'; },
    (value) => { value.adjustments.push(structuredClone(value.adjustments[0])); }
  ];

  for (const damage of damages) {
    const broken = structuredClone(native);
    damage(broken);
    const load = () => decodeDesktopState(broken);
    assert.throws(load);
  }
};

test('损坏的完整备份容器、日期、记录和重复操作整体拒绝，不能清洗为空后覆盖数据', testInvalidContainers);

const testExtensionPublication = () => {
  const store = createDesktopExtension();
  const committed = store.getDesktop();
  store.captureExtension();
  const next = {
    ...committed,
    todos: [{ id: 'new', date: '2026-10-28', text: '尚未保存', done: false, createdAt: 1 }]
  };

  store.setDesktop(next);
  const waiting = store.getDesktop();
  const payload = store.getWriteExtension();
  assert.strictEqual(waiting, committed);
  assert.equal(payload.todos.length, 1);
  store.commitExtension();
  const saved = store.getDesktop();
  assert.equal(saved.todos.length, 1);
  store.captureExtension();
  const empty = { ...saved, todos: [] };
  store.setDesktop(empty);
  store.restoreExtension();
  const afterFailure = store.getDesktop();
  assert.strictEqual(afterFailure, saved);
};

test('桌面待办与外观草稿不提前发布给渲染或导出，成功发布、失败丢弃', testExtensionPublication);

const testUtoolsStorage = () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };

  const host = { utools: { dbStorage: storage } };
  const platform = createUtoolsPlatform(host, undefined);
  const value = { version: 7 };
  platform.storage.setItem('original-key', value);
  const saved = platform.storage.getItem('original-key');
  assert.strictEqual(saved, value);
  assert.equal(platform.kind, 'utools');
};

test('uTools 适配器保留原宿主存储键和对象契约', testUtoolsStorage);
