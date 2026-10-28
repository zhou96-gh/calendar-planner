import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { COLOR_DEFAULTS } from '../src/holiday/appearance.js';

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

test('侧栏高度跟随日历，隐藏期间保留测量值，不监听窗口拉伸切换定位', () => {
  let callback;
  const observed = [];
  const values = new Map();
  const writes = [];
  const summaryBand = { getBoundingClientRect: () => ({ height: 72.25 }) };
  const calendarBounds = { height: 500 };
  const calendarPanel = { getBoundingClientRect: () => calendarBounds };
  const context = {
    calendarPlatform: { kind: 'utools' },
    window: {
      addEventListener: () => assert.fail('侧栏定位不应监听窗口拉伸'),
      ResizeObserver: class {
        constructor(listener) {
          callback = listener;
        }

        observe(target) {
          observed.push(target);
        }
      }
    },
    document: {
      documentElement: {
        style: {
          setProperty: (key, value) => {
            values.set(key, value);
            writes.push(key);
          }
        }
      }
    },
    elements: { summaryBand, calendarPanel }
  };
  const start = source.indexOf("if (globalThis.calendarPlatform.kind !== 'desktop' && typeof window.ResizeObserver");
  const end = source.indexOf('void loadBuiltInColorSchemes().catch');
  assert.ok(start >= 0 && end > start);
  const observerSource = source.slice(start, end);
  runInNewContext(observerSource, context);
  assert.equal(observed[0], summaryBand);
  assert.equal(observed[1], calendarPanel);
  callback([
    { target: summaryBand, borderBoxSize: [{ blockSize: 68.5 }] },
    { target: calendarPanel, borderBoxSize: [{ blockSize: 500 }] }
  ]);
  let summaryHeight = values.get('--summary-height');
  let calendarHeight = values.get('--calendar-panel-height');
  assert.equal(summaryHeight, '68.5px');
  assert.equal(calendarHeight, '500px');

  calendarBounds.height = 0;
  callback([
    { target: summaryBand, borderBoxSize: [{ blockSize: 0 }] },
    { target: calendarPanel, borderBoxSize: [{ blockSize: 0 }] }
  ]);
  summaryHeight = values.get('--summary-height');
  calendarHeight = values.get('--calendar-panel-height');
  assert.equal(summaryHeight, '68.5px');
  assert.equal(calendarHeight, '500px');

  calendarBounds.height = 700;
  callback([{ target: calendarPanel, borderBoxSize: [{ blockSize: 700 }] }]);
  calendarHeight = values.get('--calendar-panel-height');
  assert.equal(calendarHeight, '700px');
  const previousWrites = writes.length;
  callback([{ target: calendarPanel, borderBoxSize: [{ blockSize: 700 }] }]);
  assert.equal(writes.length, previousWrites);

  callback([{ target: summaryBand }]);
  summaryHeight = values.get('--summary-height');
  assert.equal(summaryHeight, '72.25px');

  callback = null;
  context.calendarPlatform.kind = 'desktop';
  runInNewContext(observerSource, context);
  assert.equal(callback, null);
});

const testPaletteInterleaving = async () => {
  const handlers = {};
  const completions = [];
  const output = {};
  const control = {
    value: '#112233',
    dataset: { colorToken: 'primary' },
    closest: () => row
  };

  const row = {
    querySelector: (selector) => {
      if (selector === 'input[data-color-token]') return control;

      if (selector === ':scope > output') return output;

      return null;
    }
  };

  const context = {
    state: { colorSchemeId: 'custom', customColors: { light: {}, dark: {} } },
    previewColors: null,
    colorEditMode: 'light',
    structuredClone,
    COLOR_DEFAULTS,
    builtInColorSchemes: new Map(),
    renderColorPreview: () => {},
    applyColors: () => {},
    renderSettings: () => {},
    elements: {
      colorGrid: { addEventListener: (type, action) => { handlers[type] = action; } },
      colorScheme: {}, resetCustomColors: {}
    },
    listenForSave: (_target, type, action) => { handlers[type] = action; }
  };

  context.commitState = (update) => {
    const draft = structuredClone(context.state);
    update(draft);
    return new Promise((resolve) => {
      completions.push(() => { context.state = draft; resolve(true); });
    });
  };

  const start = source.indexOf("elements.colorGrid.addEventListener('input'");
  const end = source.indexOf("document.querySelector('#import-custom-colors')");
  assert.ok(start >= 0 && end > start);
  runInNewContext(source.slice(start, end), context);
  const event = { target: { closest: () => control } };
  handlers.input(event);
  const firstPreview = context.previewColors;
  const first = handlers.change();
  control.value = '#445566';
  handlers.input(event);
  const newerPreview = context.previewColors;
  assert.notStrictEqual(newerPreview, firstPreview);
  completions.shift()();
  await first;
  assert.strictEqual(context.previewColors, newerPreview);
  const second = handlers.change();
  completions.shift()();
  await second;
  assert.equal(context.previewColors, null);
  assert.equal(context.state.customColors.light.primary, '#445566');
};

test('颜色保存等待期间的新输入不会被旧保存清除，第二次 change 保存最新颜色', testPaletteInterleaving);

const testDialogSession = async () => {
  for (const type of ['adjustment', 'correction']) {
    let handler;
    let finish;
    let closed = 0;
    const pending = new Promise((resolve) => { finish = resolve; });
    const context = {
      selectedAdjustmentType: type,
      adjustmentSession: 1,
      elements: { adjustmentForm: {}, adjustmentDialog: { close: () => { closed += 1; } } },
      saveAdjustmentRecord: () => pending,
      saveDateEdit: () => pending,
      listenForSave: (_target, _type, action) => { handler = action; }
    };

    const start = source.indexOf("listenForSave(elements.adjustmentForm, 'submit'");
    const end = source.indexOf('globalThis.calendarPlatform.onEnter?.(');
    assert.ok(start >= 0 && end > start);
    runInNewContext(source.slice(start, end), context);
    const event = { preventDefault: () => {} };
    const saving = handler(event);
    context.adjustmentSession = 2;
    finish(true);
    await saving;
    assert.equal(closed, 0);
    await handler(event);
    assert.equal(closed, 1);
  }
};

test('异步保存完成后只关闭原编辑会话，不关闭用户新打开的调班或修正窗口', testDialogSession);

const testSettingsTabs = () => {
  for (const count of [3, 4]) {
    const handlers = {};
    let focused = -1;
    let prevented = 0;

    const panels = Array.from({ length: count }, (_, index) => ({
      id: 'settings-' + index,
      hidden: false,
      input: { value: '未提交输入-' + index }
    }));

    const tabs = panels.map((panel, index) => ({
      attributes: { 'aria-controls': panel.id },
      getAttribute(name) { return this.attributes[name]; },
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() { focused = index; },
      closest() { return this; }
    }));

    const tablist = {
      querySelectorAll: () => tabs,
      addEventListener: (type, action) => { handlers[type] = action; }
    };

    const settingsView = {
      querySelector: () => tablist,
      querySelectorAll: () => panels
    };

    const context = { elements: { settingsView }, commitState: () => assert.fail('切换 Tab 不应保存数据') };
    const start = source.indexOf('function initializeSettingsTabs() {');
    const end = source.indexOf('\nfunction renderColorPreview()');
    assert.ok(start >= 0 && end > start);
    const script = source.slice(start, end) + '\ninitializeSettingsTabs();';
    runInNewContext(script, context);

    /**
     * 同时校验唯一可见分区、选中状态、Tab 焦点入口和原输入保留。
     */
    function assertSelected(index) {
      panels.forEach((panel, position) => {
        assert.equal(panel.hidden, position !== index);
        assert.equal(panel.input.value, '未提交输入-' + position);
        assert.equal(tabs[position].attributes['aria-selected'], String(position === index));
        assert.equal(tabs[position].tabIndex, position === index ? 0 : -1);
      });
    }

    assertSelected(0);
    handlers.click({ target: { closest: () => tabs[1] } });
    assertSelected(1);
    let current = 1;
    const cases = [['End', count - 1], ['ArrowRight', 0], ['ArrowLeft', count - 1], ['Home', 0]];

    for (const [key, next] of cases) {
      const event = { key, target: tabs[current], preventDefault: () => { prevented += 1; } };
      handlers.keydown(event);
      assertSelected(next);
      assert.equal(focused, next);
      current = next;
    }

    handlers.keydown({ key: 'Tab', target: tabs[0], preventDefault: () => assert.fail('保留原生 Tab 导航') });
    handlers.click({ target: { closest: () => null } });
    assertSelected(0);
    assert.equal(prevented, 4);
  }
};

test('设置 Tab 支持共用及桌面追加分区、鼠标和键盘切换，保留输入且不保存', testSettingsTabs);

test('无可见标签的日期时段组支持新增、编辑回填及完整范围读回', () => {
  const rows = [];

  const template = {
    cloneNode() {
      const fields = ['startDate', 'startPeriod', 'endDate', 'endPeriod'].map((field) => ({
        dataset: { rangeField: field },
        tagName: field.endsWith('Period') ? 'SELECT' : 'INPUT',
        previousElementSibling: null,
        value: ''
      }));

      return { querySelectorAll: () => fields };
    }
  };

  const context = { rangeSequence: 0, elements: { rangeTemplate: { content: { firstElementChild: template } } } };
  const start = source.indexOf('function readRangeRow(row, type) {');
  const end = source.indexOf('function openAdjustmentDialog(', start);
  const script = source.slice(start, end);
  runInNewContext(script, context);
  const container = { append: (row) => rows.push(row) };
  const added = context.appendRange(container);
  const addedRange = structuredClone(context.readRangeRow(added, 'rest'));
  const emptyRange = { type: 'rest', startDate: '', startPeriod: 'am', endDate: '', endPeriod: 'am' };
  assert.deepEqual(addedRange, emptyRange);
  const editedRange = { type: 'work', startDate: '2026-10-08', startPeriod: 'pm', endDate: '2026-10-09', endPeriod: 'am' };
  const edited = context.appendRange(container, editedRange);
  const restoredRange = structuredClone(context.readRangeRow(edited, 'work'));
  assert.deepEqual(restoredRange, editedRange);
  const firstIds = added.querySelectorAll().map((field) => field.id);
  const secondIds = edited.querySelectorAll().map((field) => field.id);
  const ids = new Set([...firstIds, ...secondIds]);
  assert.equal(ids.size, 8);
  assert.equal(rows.length, 2);
});

test('范围日期按变更端修正当前行，正常、相等、空日期及仅改时段保持原值', () => {
  const start = source.indexOf("elements.adjustmentFields.addEventListener('change'");
  const end = source.indexOf("elements.adjustmentNote.addEventListener('input'", start);
  const script = source.slice(start, end);

  const cases = [
    { field: 'startDate', result: { endDate: '2026-10-10', endPeriod: 'pm' } },
    { field: 'endDate', result: { startDate: '2026-10-09', startPeriod: 'am' } },
    { field: 'startDate', values: { startDate: '2026-10-08' } },
    { field: 'endDate', values: { endDate: '2026-10-11' } },
    { field: 'startDate', values: { endDate: '2026-10-10' } },
    { field: 'endDate', values: { endDate: '2026-10-10' } },
    { field: 'startDate', values: { startDate: '' } },
    { field: 'endDate', values: { endDate: '' } },
    { field: 'startDate', values: { endDate: '' } },
    { field: 'endDate', values: { startDate: '' } },
    { field: 'startPeriod' },
    { field: 'endPeriod' }
  ];

  for (const scenario of cases) {
    const values = { startDate: '2026-10-10', startPeriod: 'pm', endDate: '2026-10-09', endPeriod: 'am', ...scenario.values };
    const unrelated = { startDate: '2026-11-01', startPeriod: 'am', endDate: '2026-11-02', endPeriod: 'pm' };

    const rows = [values, unrelated].map((range) => {
      const entries = Object.entries(range);
      const pairs = entries.map(([field, value]) => [field, { value, dataset: { rangeField: field } }]);
      const fields = Object.fromEntries(pairs);

      const row = {
        querySelector: (selector) => {
          const field = selector.match(/data-range-field="([^"]+)"/)[1];
          return fields[field];
        }
      };

      for (const field of Object.values(fields)) field.closest = () => row;

      return fields;
    });

    let change;
    let previews = 0;

    const context = {
      elements: { adjustmentFields: { addEventListener: (_type, handler) => { change = handler; } } },
      updateAdjustmentPreview: () => { previews += 1; },
      commitState: () => assert.fail('日期联动不应保存草稿')
    };

    runInNewContext(script, context);
    const event = { target: rows[0][scenario.field] };
    change(event);
    const changedEntries = Object.entries(rows[0]).map(([field, input]) => [field, input.value]);
    const actual = Object.fromEntries(changedEntries);
    const expected = { ...values, ...scenario.result };
    assert.deepEqual(actual, expected);
    const otherEntries = Object.entries(rows[1]).map(([field, input]) => [field, input.value]);
    const other = Object.fromEntries(otherEntries);
    assert.deepEqual(other, unrelated);
    assert.equal(previews, 1);
  }
});

test('密度保存成功后才更新排版和选中项，失败保持宽松，忽略无效或重复选项', async () => {
  const applyStart = source.indexOf('function applyLayoutDensity() {');
  const applyEnd = source.indexOf('function applyColors()', applyStart);
  const renderStart = source.indexOf('function renderSettings() {');
  const renderEnd = source.indexOf('  elements.colorScheme.value', renderStart);
  const actionStart = source.indexOf("listenForSave(elements.layoutDensity, 'click'");
  const actionEnd = source.indexOf("listenForSave(elements.colorScheme, 'change'", actionStart);
  const script = source.slice(applyStart, applyEnd) + source.slice(renderStart, renderEnd) + '}\n' + source.slice(actionStart, actionEnd);

  for (const rejected of [false, true]) {
    const buttons = ['compact', 'spacious'].map((value) => ({
      dataset: { value },
      attributes: {},
      classList: { toggle: () => {} },
      setAttribute(name, state) { this.attributes[name] = state; }
    }));

    const root = { dataset: { layoutDensity: 'spacious' } };
    let action;
    let resolveSave;
    let rejectSave;
    let commits = 0;

    const context = {
      state: { layoutDensity: 'spacious' },
      document: { documentElement: root },
      elements: { layoutDensity: { querySelectorAll: () => buttons } },
      listenForSave: (_target, _type, handler) => { action = handler; }
    };

    context.commitState = (update) => {
      commits += 1;
      const draft = structuredClone(context.state);
      update(draft);

      return new Promise((resolve, reject) => {
        resolveSave = () => { context.state = draft; resolve(true); };
        rejectSave = () => reject(new Error('保存失败'));
      });
    };

    runInNewContext(script, context);
    context.renderSettings();
    const invalid = { target: { closest: () => ({ dataset: { value: 'invalid' } }) } };
    await action(invalid);
    const repeated = { target: { closest: () => buttons[1] } };
    await action(repeated);
    assert.equal(commits, 0);
    const event = { target: { closest: () => buttons[0] } };
    const pending = action(event);
    assert.equal(context.state.layoutDensity, 'spacious');
    assert.equal(root.dataset.layoutDensity, 'spacious');
    assert.equal(buttons[1].attributes['aria-pressed'], 'true');

    if (rejected) {
      rejectSave();
      await assert.rejects(pending, /保存失败/);
      assert.equal(context.state.layoutDensity, 'spacious');
      assert.equal(root.dataset.layoutDensity, 'spacious');
      assert.equal(buttons[1].attributes['aria-pressed'], 'true');
    } else {
      resolveSave();
      await pending;
      assert.equal(context.state.layoutDensity, 'compact');
      assert.equal(root.dataset.layoutDensity, 'compact');
      assert.equal(buttons[0].attributes['aria-pressed'], 'true');
      assert.equal(buttons[1].attributes['aria-pressed'], 'false');
    }
  }
});
