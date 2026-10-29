import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isRecommendationAction, RECOMMENDATION_WINDOW } from '../src/desktop/recommendation-protocol.js';

const values = { maximum: '4', leaveDays: '0', workMaximum: '', crossMonth: false,
  maximumBadInput: false, workMaximumBadInput: false, leaveBadInput: false };

const bridgeUrl = new URL('../src/desktop/recommendation-bridge.js', import.meta.url);

const bridgeSource = readFileSync(bridgeUrl, 'utf8').replace(/^import[^\n]+\n/, '')
  .replace('export async function', 'async function');

/**
 * 真实桥接使用纯内存 DOM、原生调用和提交队列替身，不创建窗口或连接数据库。
 */
async function createBridge(options = {}) {
  const listeners = new Map();
  const emitted = [];
  const invoked = [];
  const errors = [];
  const refreshed = [];
  let clicked = 0;
  const cancelled = [];
  const control = (value) => ({ value, error: '', setCustomValidity(message) { this.error = message; } });
  const maximum = control('4');
  maximum.max = '31';
  const maximumLabel = { textContent: '最多 31 天' };
  const leaveDays = control('0');
  const workMaximum = control('');
  const crossMonth = { checked: false };
  const content = { innerHTML: 'shared-template' };
  const target = { dataset: { useRecommendation: 'longest' }, click: () => { clicked += 1; } };
  const results = { innerHTML: 'initial', querySelectorAll: () => [target] };
  const fields = new Map([
    ['.vacation-recommendation-content', content],
    ['#recommendation-maximum', maximum],
    ['#recommendation-maximum-label', maximumLabel],
    ['#recommendation-leave-days', leaveDays],
    ['#recommendation-work-maximum', workMaximum],
    ['#recommendation-cross-month', crossMonth],
    ['#vacation-recommendation-results', results]
  ]);

  const dialog = { querySelector: (selector) => fields.get(selector) };
  const platform = {
    listen: async (name, action) => { listeners.set(name, action); },
    emitTo: async (label, name, payload) => { emitted.push({ label, name, payload }); },
    invoke: async (command, args) => {
      invoked.push({ command, args });

      if (command === 'show_vacation_recommendations' && options.openError) throw options.openError;

      if (command === 'focus_calendar' && options.focus) await options.focus();
    }
  };

  const application = {
    whenIdle: () => options.idle ?? Promise.resolve(),
    cancelRecommendation: async (groupId) => {
      if (options.cancelError) throw options.cancelError;

      cancelled.push(groupId);
    },
    refreshRecommendations: async () => {
      refreshed.push({ maximum: maximum.value, leaveDays: leaveDays.value, workMaximum: workMaximum.value, crossMonth: crossMonth.checked });
      results.innerHTML = maximum.value + '/' + workMaximum.value;
    }
  };

  const root = { dataset: { theme: 'dark', layoutDensity: 'compact' }, style: { cssText: '--surface:#123456' } };
  const observed = [];

  class Observer {
    constructor(callback) { this.callback = callback; }
    observe(element, settings) { observed.push({ element, settings }); }
  }

  const context = {
    platform, application, dialog, notify: (error) => errors.push(error),
    document: { documentElement: root }, MutationObserver: Observer, queueMicrotask,
    isRecommendationAction, RECOMMENDATION_WINDOW
  };

  const script = bridgeSource + '\nconnectRecommendations({ platform, application, dialog, notify });';
  await runInNewContext(script, context);
  return { platform, listeners, emitted, invoked, errors, refreshed, observed, maximum, leaveDays, workMaximum,
    crossMonth, cancelled, clicked: () => clicked };
}

const testProtocol = () => {
  const configure = { kind: 'configure', session: 1, sequence: 1, values };
  const use = { ...configure, kind: 'use', value: 'shortest-work' };
  const validConfiguration = isRecommendationAction(configure);
  const validSelection = isRecommendationAction(use);
  assert.equal(validConfiguration, true);
  assert.equal(validSelection, true);
  const cancel = isRecommendationAction({ kind: 'cancel', session: 1, sequence: 1, value: 'group' });
  assert.equal(cancel, true);

  for (const invalid of [null, {}, { ...configure, kind: 'script' }, { ...use, value: 'unknown' },
    { ...use, values: null }, { ...configure, session: 0 }, { ...configure, sequence: 0 },
    { ...configure, values: { ...values, maximum: 4 } },
    { ...configure, kind: 'cancel', value: '' }, { ...configure, kind: 'cancel', value: 4 },
    { ...configure, values: { ...values, crossMonth: 'true' } }]) {
    const valid = isRecommendationAction(invalid);
    assert.equal(valid, false);
  }
};

const testOpenClose = async () => {
  const bridge = await createBridge();
  await bridge.platform.openRecommendations();
  assert.equal(bridge.platform.recommendationsOpen, true);
  assert.equal(bridge.emitted[0].label, RECOMMENDATION_WINDOW);
  assert.equal(bridge.emitted[0].payload.template, 'shared-template');
  assert.equal(bridge.emitted[0].payload.theme, 'dark');
  assert.equal(bridge.emitted[0].payload.layoutDensity, 'compact');
  const session = bridge.emitted[0].payload.session;
  const ready = bridge.listeners.get('recommendation-ready');
  ready();
  await new Promise(setImmediate);
  assert.equal(bridge.emitted.length, 2);
  await bridge.platform.closeRecommendations();
  assert.equal(bridge.platform.recommendationsOpen, false);
  await bridge.platform.openRecommendations();
  const newSession = bridge.emitted.at(-1).payload.session;
  assert.ok(newSession > session);
  const closed = bridge.listeners.get('recommendation-closed');
  closed({ payload: session });
  assert.equal(bridge.platform.recommendationsOpen, true);
  closed({ payload: newSession });
  assert.equal(bridge.platform.recommendationsOpen, false);
  assert.ok(bridge.invoked.every((item) => !['save_state', 'exit_app'].includes(item.command)));
};

const testConfiguration = async () => {
  const bridge = await createBridge();
  await bridge.platform.openRecommendations();
  const session = bridge.emitted[0].payload.session;
  const receive = bridge.listeners.get('recommendation-action');
  const changedValues = { ...values, maximum: '2.5', workMaximum: '6.5', crossMonth: true };
  const action = { kind: 'configure', session, sequence: 2, values: changedValues };
  await receive({ payload: action });
  assert.equal(bridge.maximum.value, '2.5');
  assert.equal(bridge.workMaximum.value, '6.5');
  assert.equal(bridge.crossMonth.checked, true);
  const stale = { ...action, sequence: 1, values };
  await receive({ payload: stale });
  assert.equal(bridge.maximum.value, '2.5');
  assert.equal(bridge.refreshed.length, 1);
  const badInput = { ...action, sequence: 3, values: { ...changedValues, workMaximum: '', workMaximumBadInput: true } };
  await receive({ payload: badInput });
  assert.ok(bridge.workMaximum.error);
  assert.equal(bridge.invoked.length, 1);
};

const testUseWhileSaving = async () => {
  let complete;
  const idle = new Promise((resolve) => { complete = resolve; });
  const options = { idle };
  const bridge = await createBridge(options);
  await bridge.platform.openRecommendations();
  const session = bridge.emitted[0].payload.session;
  const receive = bridge.listeners.get('recommendation-action');
  const configure = { kind: 'configure', session, sequence: 1, values };
  const first = receive({ payload: configure });
  const changedValues = { ...values, maximum: '1.5', workMaximum: '5.5' };
  const use = { kind: 'use', value: 'longest', session, sequence: 2, values: changedValues };
  const second = receive({ payload: use });
  const pendingClicks = bridge.clicked();
  assert.equal(pendingClicks, 0);
  complete();
  await Promise.all([first, second]);
  assert.equal(bridge.maximum.value, '1.5');
  assert.equal(bridge.workMaximum.value, '5.5');
  const confirmedClicks = bridge.clicked();
  assert.equal(confirmedClicks, 1);
  assert.equal(bridge.refreshed.length, 1);
  const lastInvocation = bridge.invoked.at(-1);
  assert.equal(lastInvocation.command, 'focus_calendar');
};

const testStaleUse = async () => {
  let complete;
  const focusing = new Promise((resolve) => { complete = resolve; });
  const options = { focus: () => focusing };
  const bridge = await createBridge(options);
  await bridge.platform.openRecommendations();
  const session = bridge.emitted[0].payload.session;
  const use = { kind: 'use', value: 'longest', session, sequence: 1, values };
  const receive = bridge.listeners.get('recommendation-action');
  const pending = receive({ payload: use });
  await new Promise(setImmediate);
  await bridge.platform.closeRecommendations();
  await bridge.platform.openRecommendations();
  complete();
  await pending;
  const clicks = bridge.clicked();
  assert.equal(clicks, 0);
  assert.equal(bridge.platform.recommendationsOpen, true);
};

const testOpenFailure = async () => {
  const options = { openError: new Error('模拟原生窗口失败') };
  const bridge = await createBridge(options);
  const opening = bridge.platform.openRecommendations();
  await assert.rejects(opening, /模拟原生窗口失败/);
  assert.equal(bridge.platform.recommendationsOpen, false);
  assert.equal(bridge.emitted.length, 0);
};

const testCloseWhileSaving = async () => {
  const options = { idle: new Promise(() => {}) };
  const bridge = await createBridge(options);
  await bridge.platform.openRecommendations();
  const session = bridge.emitted[0].payload.session;
  const receive = bridge.listeners.get('recommendation-action');
  const close = { kind: 'close', session, sequence: 1 };
  await receive({ payload: close });
  assert.equal(bridge.platform.recommendationsOpen, false);
  const lastInvocation = bridge.invoked.at(-1);
  assert.equal(lastInvocation.command, 'hide_vacation_recommendations');
};

const testSnapshot = () => {
  const viewUrl = new URL('../src/desktop/recommendation-window.js', import.meta.url);
  const source = readFileSync(viewUrl, 'utf8');
  const start = source.indexOf('function applySnapshot(snapshot) {');
  const end = source.indexOf('\nfunction send(', start);
  const fields = new Map([
    ['#recommendation-maximum', { value: '' }],
    ['#recommendation-maximum-label', { textContent: '' }],
    ['#recommendation-leave-days', { value: '' }],
    ['#recommendation-work-maximum', { value: '' }],
    ['#recommendation-cross-month', { checked: false }],
    ['#vacation-recommendation-results', { innerHTML: '', scrollLeft: 12 }]
  ]);

  const maximum = fields.get('#recommendation-maximum');
  maximum.validity = { badInput: false };
  Object.defineProperty(maximum, 'valueAsNumber', { get: () => Number(maximum.value) });

  const content = { innerHTML: '', scrollTop: 42, querySelector: (selector) => fields.get(selector) };
  const root = { dataset: {}, style: {} };
  const context = { root, content, errorOutput: {},
    session: 0, sequence: 0, lastRevision: -1 };
  const script = source.slice(start, end);
  runInNewContext(script, context);
  const initial = { session: 1, sequence: 0, revision: 1, template: 'template-1', results: 'first',
    values, limits: { maximum: '31', label: '最多 31 天' },
    theme: 'dark', layoutDensity: 'compact', style: '--surface:#123456' };
  context.applySnapshot(initial);
  const workMaximum = fields.get('#recommendation-work-maximum');
  const results = fields.get('#vacation-recommendation-results');
  let resultHtml = results.innerHTML;
  const resultProperty = {
    get: () => resultHtml,
    set: (value) => {
      resultHtml = value;
      content.scrollTop = 0;
    }
  };

  Object.defineProperty(results, 'innerHTML', resultProperty);
  workMaximum.value = '6.';
  context.sequence = 2;
  context.applySnapshot({ ...initial, revision: 2, sequence: 1, results: 'stale' });
  assert.equal(results.innerHTML, 'first');
  context.applySnapshot({ ...initial, revision: 3, sequence: 2, results: 'current' });
  assert.equal(results.innerHTML, 'current');
  assert.equal(workMaximum.value, '6.');
  assert.equal(content.scrollTop, 42);
  assert.equal(results.scrollLeft, 12);
  maximum.value = '6';
  const limited = { ...initial, revision: 4, sequence: 2,
    values: { ...values, maximum: '4' }, limits: { maximum: '4', label: '最多 4 天' } };
  context.applySnapshot(limited);
  assert.equal(maximum.value, '4');
  assert.equal(maximum.max, '4');
  const maximumLabel = fields.get('#recommendation-maximum-label');
  assert.equal(maximumLabel.textContent, '最多 4 天');
  assert.equal(workMaximum.value, '6.');
  const reopened = { ...initial, session: 2, revision: 5, template: 'template-2' };
  context.applySnapshot(reopened);
  assert.equal(content.innerHTML, 'template-2');
  assert.equal(workMaximum.value, '');
  assert.equal(context.sequence, 0);
};

const testIncreasingMaximum = async () => {
  const bridge = await createBridge();
  await bridge.platform.openRecommendations();
  const session = bridge.emitted[0].payload.session;
  const receive = bridge.listeners.get('recommendation-action');

  for (const [index, maximum] of ['5', '6'].entries()) {
    const action = { kind: 'configure', session, sequence: index + 1, values: { ...values, maximum, leaveDays: '2' } };
    await receive({ payload: action });
    const last = bridge.emitted.at(-1).payload;
    assert.equal(last.values.maximum, maximum);
    assert.equal(last.values.leaveDays, '2');
  }

  const maximums = bridge.refreshed.map((item) => item.maximum);
  const expected = ['5', '6'];
  assert.deepEqual(maximums, expected);
};

const testCancelWhileSaving = async () => {
  let complete;
  const idle = new Promise((resolve) => { complete = resolve; });
  const bridge = await createBridge({ idle });
  await bridge.platform.openRecommendations();
  const session = bridge.emitted[0].payload.session;
  const receive = bridge.listeners.get('recommendation-action');
  const cancel = { kind: 'cancel', session, sequence: 1, value: 'selected-group' };
  const pending = receive({ payload: cancel });
  const changedValues = { ...values, maximum: '2' };
  const configure = { kind: 'configure', session, sequence: 2, values: changedValues };
  const configured = receive({ payload: configure });
  assert.equal(bridge.cancelled.length, 0);
  complete();
  await Promise.all([pending, configured]);
  const expected = ['selected-group'];
  assert.deepEqual(bridge.cancelled, expected);
  assert.equal(bridge.platform.recommendationsOpen, true);
  assert.equal(bridge.refreshed.length, 1);
  assert.equal(bridge.maximum.value, '2');
  assert.equal(bridge.invoked.length, 1);
  const old = { ...cancel, sequence: 1, value: 'stale-group' };
  await receive({ payload: old });
  assert.deepEqual(bridge.cancelled, expected);
};

const testCancelFailure = async () => {
  const cancelError = new Error('模拟取消保存失败');
  const bridge = await createBridge({ cancelError });
  await bridge.platform.openRecommendations();
  const session = bridge.emitted[0].payload.session;
  const receive = bridge.listeners.get('recommendation-action');
  const action = { kind: 'cancel', session, sequence: 1, value: 'selected-group' };
  await receive({ payload: action });
  assert.equal(bridge.errors[0], cancelError);
  assert.equal(bridge.cancelled.length, 0);
  assert.equal(bridge.platform.recommendationsOpen, true);
};

test('推荐窗动作只接受配置、关闭和白名单方案标识', testProtocol);
test('独立窗口重复打开复用原生窗口，旧关闭回执不会关闭新会话', testOpenClose);
test('配置在主窗口重新计算，过期输入被忽略，不写入存储', testConfiguration);
test('保存期间使用方案等待提交完成并携带最新配置', testUseWhileSaving);
test('等待主窗口聚焦期间关闭重开推荐窗，旧方案不再打开编辑器', testStaleUse);
test('原生窗口打开失败时恢复关闭状态并抛出错误', testOpenFailure);
test('推荐窗关闭不等待主窗口未完成的保存操作', testCloseWhileSaving);
test('独立窗口丢弃过期结果，同一会话刷新保留输入与滚动位置', testSnapshot);
test('独立窗口调休上限从4增加到5、6并携带免补班假期时均重新计算', testIncreasingMaximum);
test('独立窗口取消等待提交且不被后续配置丢弃，仅传回原组标识并保留窗口', testCancelWhileSaving);
test('独立窗口取消保存失败保留窗口并报告错误', testCancelFailure);
