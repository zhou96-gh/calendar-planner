import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { findAttachmentTarget, readAttachmentAction, serializeAttachmentSource } from '../src/desktop/attachment-protocol.js';

test('附着窗口只回传白名单动作，复用主窗口当前节点并拒绝过期或无效输入', () => {
  const checkbox = { dataset: { todoToggle: 'todo-1' }, checked: true };
  const target = { closest: (selector) => selector === '[data-todo-toggle]' ? checkbox : null };
  const action = readAttachmentAction(target, 'change');
  const expected = { kind: 'todo-toggle', value: 'todo-1', checked: true };
  assert.deepEqual(action, expected);
  const click = readAttachmentAction(target, 'click');
  assert.equal(click, null);
  const source = { querySelectorAll: (selector) => selector === '[data-todo-toggle]' ? [checkbox] : [] };
  const sources = [source];
  const found = findAttachmentTarget(sources, action);
  assert.strictEqual(found, checkbox);

  for (const invalid of [null, { kind: 'script' }, { kind: 'todo-toggle', value: 'missing', checked: true },
    { kind: 'todo-toggle', value: 'todo-1', checked: 'true' }]) {
    const result = findAttachmentTarget(sources, invalid);
    assert.equal(result, null);
  }
});

test('视图快照序列化保留 checkbox 当前状态，不修改主窗口节点', () => {
  const attributes = new Map();
  const copiedInput = { toggleAttribute: (key, enabled) => { attributes.set(key, enabled); } };

  const clone = {
    querySelectorAll: () => [copiedInput],
    get innerHTML() { return attributes.get('checked') ? '<input checked>' : '<input>'; }
  };

  const source = { cloneNode: () => clone, querySelectorAll: () => [{ checked: true }] };
  const html = serializeAttachmentSource(source);
  assert.equal(html, '<input checked>');
});

/**
 * 执行真实桥接模块，DOM 和跨窗口传输均使用内存 Mock，不读取数据库。
 */
async function createBridgeHarness(options = {}) {
  const url = new URL('../src/desktop/attachment-bridge.js', import.meta.url);
  const source = readFileSync(url, 'utf8').replace(/^import[^\n]+\n/, '').replace('export async function', 'async function');
  const listeners = new Map();
  const emitted = [];
  const observed = [];
  const errors = [];
  let mutation;
  let currentHtml = 'committed';
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });

  const target = {
    dataset: { todoToggle: 'todo-1', todoEdit: 'todo-1' },
    dispatchEvent(event) {
      const operation = pending.then(() => { currentHtml = 'saved'; });
      event.calendarActions.push(operation);
    }
  };
  let currentTarget = target;

  const info = {
    querySelectorAll: (selector) => ['[data-todo-toggle]', '[data-todo-edit]'].includes(selector) ? [currentTarget] : [],
    cloneNode: () => ({ querySelectorAll: () => [], innerHTML: currentHtml })
  };

  const holidays = {
    querySelectorAll: () => [],
    cloneNode: () => ({ querySelectorAll: () => [], innerHTML: 'holidays' })
  };

  const platform = {
    listen: async (name, handler) => { listeners.set(name, handler); },
    emitTo: async (label, name, payload) => { emitted.push({ label, name, payload }); },
    invoke: async () => {
      if (options.focus) return options.focus();

      assert.fail('完成待办无需切换主窗口焦点');
    }
  };

  class Observer {
    constructor(callback) { mutation = callback; }
    observe(element, options) { observed.push({ element, options }); }
  }

  const root = { dataset: { theme: 'dark', layoutDensity: 'spacious' }, style: { cssText: '--page:#112233' }, classList: { contains: () => false } };
  const context = {
    document: { documentElement: root },
    MutationObserver: Observer,
    queueMicrotask,
    Event,
    findAttachmentTarget,
    serializeAttachmentSource,
    platform,
    sources: [info, holidays],
    notify: (error) => errors.push(error)
  };

  const script = source + '\nconnectAttachments({ platform, sources, notify });';
  await runInNewContext(script, context);
  await new Promise(setImmediate);
  return {
    listeners, emitted, observed, errors, complete,
    mutate: () => mutation(),
    replaceTarget: (value) => { currentTarget = value; },
    setDensity: (value) => { root.dataset.layoutDensity = value; }
  };
}

test('桥接等待主窗口保存完成后刷新两窗，批量 DOM 变化只发布完整快照', async () => {
  const harness = await createBridgeHarness();
  assert.equal(harness.emitted.length, 2);
  assert.equal(harness.observed.length, 3);
  harness.mutate();
  harness.mutate();
  await new Promise(setImmediate);
  assert.equal(harness.emitted.length, 2);
  const handler = harness.listeners.get('attachment-action');
  const event = { payload: { kind: 'todo-toggle', value: 'todo-1', checked: true } };
  const handling = handler(event);
  await new Promise(setImmediate);
  assert.equal(harness.emitted.length, 2);
  harness.complete();
  await handling;
  assert.equal(harness.emitted.length, 4);
  const last = harness.emitted.at(-1);
  assert.equal(last.payload.info, 'saved');
  assert.equal(last.payload.holidays, 'holidays');
  assert.equal(last.label, 'sidebar-holidays');
  assert.equal(harness.errors.length, 0);
});

test('附着窗口就绪可补发快照，非法动作不触发主窗口业务', async () => {
  const harness = await createBridgeHarness();
  const ready = harness.listeners.get('attachment-ready');
  ready();
  await new Promise(setImmediate);
  assert.equal(harness.emitted.length, 4);
  const action = harness.listeners.get('attachment-action');
  const event = { payload: { kind: 'todo-toggle', value: 'stale-id', checked: true } };
  await action(event);
  assert.equal(harness.emitted.length, 6);
  assert.equal(harness.errors.length, 0);
});

test('等待聚焦期间列表重渲染后，动作重新定位到当前节点', async () => {
  let focusComplete;
  const focusing = new Promise((resolve) => { focusComplete = resolve; });
  const options = { focus: () => focusing };
  const harness = await createBridgeHarness(options);
  const handler = harness.listeners.get('attachment-action');
  const event = { payload: { kind: 'todo-edit', value: 'todo-1' } };
  const handling = handler(event);
  let dispatched = 0;
  const replacement = { dataset: { todoEdit: 'todo-1' }, dispatchEvent: () => { dispatched += 1; } };
  harness.replaceTarget(replacement);
  focusComplete();
  await handling;
  assert.equal(dispatched, 1);
  assert.equal(harness.errors.length, 0);
});

test('相同 HTML 的回执仍同步密度并还原勾选值，过期快照不覆盖新外观', () => {
  const url = new URL('../src/desktop/attachment-window.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const start = source.indexOf('function applySnapshot(snapshot) {');
  const end = source.indexOf('\n/**', start);
  const checkbox = { checked: true, hasAttribute: () => false };
  const content = { querySelectorAll: () => [checkbox] };
  const root = { dataset: {}, style: {}, classList: { toggle: () => {} } };
  const context = { root, content, kind: 'info', lastHtml: 'same', lastRevision: 3, drag: { setAttribute: () => {} } };
  const script = source.slice(start, end);
  runInNewContext(script, context);
  const current = { revision: 4, info: 'same', style: 'current', theme: 'dark', layoutDensity: 'compact', locked: false };
  context.applySnapshot(current);
  assert.equal(checkbox.checked, false);
  assert.equal(root.dataset.layoutDensity, 'compact');
  const stale = { ...current, revision: 2, style: 'stale', layoutDensity: 'spacious' };
  context.applySnapshot(stale);
  assert.equal(root.style.cssText, 'current');
  assert.equal(root.dataset.layoutDensity, 'compact');
});

test('仅密度变化且 HTML 不变时仍向两个附着窗口发布新快照', async () => {
  const harness = await createBridgeHarness();
  harness.setDensity('compact');
  harness.mutate();
  await new Promise(setImmediate);
  assert.equal(harness.emitted.length, 4);
  const changed = harness.emitted.slice(-2);

  for (const message of changed) {
    assert.equal(message.payload.layoutDensity, 'compact');
    assert.equal(message.payload.info, 'committed');
    assert.equal(message.payload.holidays, 'holidays');
  }

  const options = harness.observed[2].options;
  assert.ok(options.attributeFilter.includes('data-layout-density'));
});

test('快速结束并重新拖动时，新会话必须等待上次吸附完成', async () => {
  const url = new URL('../src/desktop/attachment-window.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const start = source.indexOf('async function move(session) {');
  const end = source.indexOf("document.querySelector('#attachment-close')");
  const handlers = {};
  const commands = [];
  let finishComplete;
  const finishing = new Promise((resolve) => { finishComplete = resolve; });
  let finishes = 0;
  const errors = [];

  const context = {
    root: { classList: { contains: () => false } },
    drag: { addEventListener: (type, handler) => { handlers[type] = handler; }, setPointerCapture: () => {} },
    dragging: false, moving: false, pendingMove: false, dragSession: 0, dragQueue: Promise.resolve(),
    report: (error) => errors.push(error),
    invoke: async (name) => {
      commands.push(name);

      if (name === 'finish_attachment_drag' && finishes++ === 0) await finishing;
    }
  };

  const script = source.slice(start, end);
  runInNewContext(script, context);
  const event = { button: 0, pointerId: 1, preventDefault: () => {} };
  handlers.pointerdown(event);
  await context.dragQueue;
  handlers.pointerup();
  await new Promise(setImmediate);
  handlers.pointerdown(event);
  await new Promise(setImmediate);
  const before = ['begin_attachment_drag', 'finish_attachment_drag'];
  assert.deepEqual(commands, before);
  finishComplete();
  await context.dragQueue;
  handlers.pointerup();
  await context.dragQueue;
  const expected = ['begin_attachment_drag', 'finish_attachment_drag', 'begin_attachment_drag', 'finish_attachment_drag'];
  assert.deepEqual(commands, expected);
  assert.equal(errors.length, 0);
});

test('待办与假期开关各自更新可见状态，关闭一窗不影响另一窗', async () => {
  const url = new URL('../src/desktop/extension.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const start = source.indexOf('  const sidebarToggles =');
  const end = source.indexOf("  bind(footer, 'click'");
  assert.ok(start >= 0 && end > start);
  const handlers = [];
  const calls = [];
  const nativeVisibility = [false, false];

  const toggles = [0, 1].map(() => ({
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; }
  }));

  const context = {
    sidebarVisibility: [false, false],
    query: (selector) => selector === '#desktop-info-toggle' ? toggles[0] : toggles[1],
    bind: (target, _type, action) => { handlers[toggles.indexOf(target)] = action; },
    platform: {
      invoke: async (name, args) => {
        calls.push({ name, ...args });
        nativeVisibility[args.panel] = args.visible;
        return [...nativeVisibility];
      }
    }
  };

  const script = source.slice(start, end);
  runInNewContext(script, context);
  assert.equal(toggles[0].attributes['aria-expanded'], 'false');
  assert.equal(toggles[1].attributes['aria-expanded'], 'false');
  await handlers[0]();
  assert.equal(toggles[0].attributes['aria-expanded'], 'true');
  assert.equal(toggles[1].attributes['aria-expanded'], 'false');
  await handlers[1]();
  assert.equal(toggles[0].attributes['aria-expanded'], 'true');
  assert.equal(toggles[1].attributes['aria-expanded'], 'true');
  await handlers[0]();
  assert.equal(toggles[0].attributes['aria-expanded'], 'false');
  assert.equal(toggles[1].attributes['aria-expanded'], 'true');
  assert.equal(toggles[0].disabled, false);
  const expected = { name: 'set_attachment_visible', panel: 0, visible: false };
  assert.deepEqual(calls[2], expected);
  const closedByNative = [false, false];
  context.setSidebarExpanded(closedByNative);
  assert.equal(toggles[1].attributes['aria-expanded'], 'false');
});

test('待办与调班 Tab 同步选中状态、键盘入口和互斥面板', () => {
  const url = new URL('../src/desktop/extension.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const start = source.indexOf("  bind(footer, 'click'");
  const end = source.indexOf("  bind(query('#desktop-add-todo')", start);
  const todos = { hidden: false };
  const adjustmentPanel = { hidden: true };

  const tabs = ['todos', 'adjustments'].map((view) => ({
    dataset: { desktopView: view },
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; }
  }));

  let click;
  const context = {
    footer: { querySelectorAll: () => tabs },
    adjustmentPanel,
    query: () => todos,
    bind: (_target, _type, handler) => { click = handler; }
  };

  const script = source.slice(start, end);
  runInNewContext(script, context);

  for (const view of ['adjustments', 'todos']) {
    const target = { closest: () => ({ dataset: { desktopView: view } }) };
    click({ target });
    const todosHidden = view !== 'todos';
    const adjustmentsHidden = view !== 'adjustments';
    assert.equal(todos.hidden, todosHidden);
    assert.equal(adjustmentPanel.hidden, adjustmentsHidden);

    for (const tab of tabs) {
      const selected = tab.dataset.desktopView === view;
      const selectedValue = String(selected);
      assert.equal(tab.attributes['aria-selected'], selectedValue);
      const expectedTabIndex = selected ? 0 : -1;
      assert.equal(tab.tabIndex, expectedTabIndex);
    }
  }
});

test('附着窗口 Tab 方向键循环切换并沿用视图动作，普通按键保持原行为', () => {
  const url = new URL('../src/desktop/attachment-window.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const start = source.indexOf("content.addEventListener('keydown'");
  const end = source.indexOf("for (const type of ['click', 'change'])", start);
  let focused = -1;
  const actions = [];

  const tabs = ['todos', 'adjustments'].map((view, index) => ({
    dataset: { desktopView: view },
    focus: () => { focused = index; },
    click: () => { actions.push(readAttachmentAction(tabs[index], 'click')); },
    closest() { return this; },
    parentElement: { querySelectorAll: () => tabs }
  }));

  let keydown;
  const context = { content: { addEventListener: (_type, handler) => { keydown = handler; } } };
  const script = source.slice(start, end);
  runInNewContext(script, context);

  const cases = [
    ['ArrowRight', 0, 1],
    ['ArrowRight', 1, 0],
    ['ArrowLeft', 0, 1],
    ['Home', 1, 0],
    ['End', 0, 1]
  ];

  for (const [key, current, expected] of cases) {
    let prevented = false;
    const event = { key, target: tabs[current], preventDefault: () => { prevented = true; } };
    keydown(event);
    assert.equal(prevented, true);
    assert.equal(focused, expected);
    const expectedAction = { kind: 'view', value: tabs[expected].dataset.desktopView };
    const action = actions.at(-1);
    assert.deepEqual(action, expectedAction);
  }

  const count = actions.length;
  const preventDefault = () => assert.fail('无关按键不应被拦截');
  keydown({ key: 'Tab', target: tabs[0], preventDefault });
  const target = { closest: () => null };
  keydown({ key: 'ArrowRight', target, preventDefault });
  assert.equal(actions.length, count);
});

test('视图快照替换后将 Tab 焦点交给新节点，内容外焦点不被抢占', () => {
  const url = new URL('../src/desktop/attachment-window.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const start = source.indexOf('function applySnapshot(snapshot) {');
  const end = source.indexOf('\n/**', start);
  const oldTab = { id: 'desktop-adjustments-tab' };
  const focused = [];
  let replacement;

  const content = {
    scrollTop: 40,
    querySelectorAll: () => [],
    set innerHTML(_html) { replacement = { focus: (options) => focused.push(options.preventScroll) }; }
  };

  const document = {
    activeElement: { closest: () => oldTab },
    getElementById: (id) => id === oldTab.id ? replacement : null
  };

  const root = { dataset: {}, style: {}, classList: { toggle: () => {} } };
  const context = { root, content, document, kind: 'info', lastHtml: '', lastRevision: 0, drag: { setAttribute: () => {} } };
  const script = source.slice(start, end);
  runInNewContext(script, context);
  const snapshot = { revision: 1, info: 'new', style: '', theme: 'dark', locked: false };
  context.applySnapshot(snapshot);
  assert.deepEqual(focused, [true]);
  assert.equal(content.scrollTop, 40);
  document.activeElement = { closest: () => null };
  const next = { ...snapshot, revision: 2, info: 'newer' };
  context.applySnapshot(next);
  assert.deepEqual(focused, [true]);
});

test('移入调班 Tab 的原计数随月份渲染更新，列表仍保留编辑和删除动作', () => {
  const extensionUrl = new URL('../src/desktop/extension.js', import.meta.url);
  const extension = readFileSync(extensionUrl, 'utf8');
  const count = { textContent: '' };
  let headingRemoved = false;
  const heading = { querySelector: () => count, remove: () => { headingRemoved = true; } };
  const panel = { querySelector: () => heading };
  let tabCount;
  const tab = { append: (_space, node) => { tabCount = node; } };
  const mounting = { document: { querySelector: () => panel }, footer: { querySelector: () => tab } };
  const mountStart = extension.indexOf("  const adjustmentPanel = document.querySelector('.adjustment-panel');");
  const mountEnd = extension.indexOf("  adjustmentPanel.id = 'desktop-adjustments';", mountStart);
  const mountScript = extension.slice(mountStart, mountEnd);
  runInNewContext(mountScript, mounting);
  assert.strictEqual(tabCount, count);
  assert.equal(headingRemoved, true);
  const list = { children: [], replaceChildren() { this.children = []; }, append(node) { this.children.push(node); } };

  const document = {
    createElement: () => ({
      dataset: {},
      children: [],
      setAttribute(name, value) { this[name] = value; },
      append(...nodes) { this.children.push(...nodes); }
    })
  };

  const range = { type: 'rest', startDate: '2026-10-08', endDate: '2026-10-08' };
  const operation = { id: 'operation-1', ranges: [range], note: '测试调班', createdAt: 1 };

  const context = {
    document,
    elements: { adjustmentRecordCount: count, adjustmentRecordList: list },
    state: { adjustments: [operation], settings: {} },
    viewYear: 2026,
    viewMonth: 10,
    calendarHolidays: {},
    getAdjustmentRanges: (record) => record.ranges,
    formatAdjustmentRange: (record) => record.startDate + ' → ' + record.endDate,
    calculateAdjustmentDays: () => 1,
    formatDays: String
  };

  const appUrl = new URL('../src/app.js', import.meta.url);
  const app = readFileSync(appUrl, 'utf8');
  const start = app.indexOf('function renderAdjustmentRecords() {');
  const end = app.indexOf('\n/**', start);
  const script = app.slice(start, end);
  runInNewContext(script, context);
  context.renderAdjustmentRecords();
  assert.equal(tabCount.textContent, '1 条');
  assert.equal(list.children.length, 1);
  const [edit, remove] = list.children[0].children;
  assert.equal(edit.dataset.adjustmentId, operation.id);
  assert.equal(edit.dataset.adjustmentType, 'rest');
  assert.equal(remove.dataset.deleteAdjustmentId, operation.id);
  assert.equal(edit.title, '2026-10-08 → 2026-10-08 · 调休 · 测试调班 · 1 天');
  context.viewMonth = 11;
  context.renderAdjustmentRecords();
  assert.equal(tabCount.textContent, '0 条');
  assert.equal(list.children[0].textContent, '本月暂无调休或补班记录');
});
