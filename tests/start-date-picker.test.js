import test from 'node:test';
import assert from 'node:assert/strict';
import { connectStartDatePicker } from '../src/holiday/start-date-picker.js';

/**
 * 面板交互使用内存 DOM，不创建宿主窗口或访问存储。
 */
function createPicker(defaultDate = '2027-02-05') {
  const document = { documentElement: { clientWidth: 800, clientHeight: 600 } };

  const createElement = (tag) => ({
    tag, ownerDocument: document, children: [], dataset: {}, attributes: {}, style: {}, listeners: {},
    value: '', offsetWidth: 268, offsetHeight: 300, open: false,
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, action) {
      this.listeners[type] ??= [];
      this.listeners[type].push(action);
    },
    dispatchEvent(event) { (this.listeners[event.type] ?? []).forEach((action) => action(event)); },
    append(...elements) {
      elements.forEach((element) => { element.parent = this; });
      this.children.push(...elements);
    },
    replaceChildren() { this.children = []; },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    },
    matches() { return this.open; },
    showPopover() { this.open = true; this.dispatchEvent({ type: 'toggle' }); },
    hidePopover() { this.open = false; this.dispatchEvent({ type: 'toggle' }); },
    closest() { return this.id === 'recommendation-start-date' ? this : null; },
    focus() { document.focused = this; },
    getBoundingClientRect() { return { left: 700, bottom: 550 }; },
    querySelector(selector) {
      const date = selector.match(/data-date="([^"]+)"/)?.[1];
      return this.children.find((child) => child.dataset.date === date)
        ?? this.children.map((child) => child.querySelector(selector)).find(Boolean);
    },
    click() { this.dispatchEvent({ type: 'click', target: this }); }
  });

  document.createElement = createElement;
  const root = createElement('div');
  const input = createElement('input');
  input.id = 'recommendation-start-date';
  input.dataset.defaultDate = defaultDate;
  let changes = 0;
  input.addEventListener('input', () => { changes += 1; });
  root.append(input);
  connectStartDatePicker(root);
  const open = () => root.dispatchEvent({ type: 'click', target: input });
  return { root, input, document, open, changes: () => changes, panel: () => root.children.at(-1) };
}

const testSelection = () => {
  const picker = createPicker();
  picker.open();
  let panel = picker.panel();
  assert.equal(picker.input.value, '');
  assert.equal(picker.document.focused.dataset.date, '2027-02-05');
  assert.equal(picker.document.focused.textContent, '5');
  assert.equal(picker.document.focused.children.length, 0);
  assert.equal(picker.document.focused.title, '农历腊月廿九 除夕');
  assert.equal(picker.document.focused.attributes['aria-label'], '2027-02-05 农历腊月廿九 除夕');
  const springFestival = panel.querySelector('[data-date="2027-02-06"]');
  assert.equal(springFestival.textContent, '6');
  assert.equal(springFestival.title, '农历正月初一 春节');
  const ordinary = panel.querySelector('[data-date="2027-02-08"]');
  assert.equal(ordinary.title, '农历正月初三');
  let changes = picker.changes();
  assert.equal(changes, 0);
  const highlighted = picker.document.focused.attributes['aria-pressed'];
  assert.equal(highlighted, 'false');
  assert.equal(panel.style.left, '524px');
  assert.equal(panel.style.top, '292px');
  let stopped = false;
  const escape = { type: 'keydown', key: 'Escape', target: picker.document.focused,
    preventDefault: () => {}, stopPropagation: () => { stopped = true; } };

  picker.root.dispatchEvent(escape);
  assert.equal(stopped, true);
  assert.equal(panel.open, false);
  assert.equal(picker.input.value, '');
  picker.open();
  picker.document.focused.click();
  assert.equal(picker.input.value, '2027-02-05');
  changes = picker.changes();
  assert.equal(changes, 1);
  picker.open();
  panel = picker.panel();
  assert.equal(picker.document.focused.dataset.date, '2027-02-05');
  panel.children[2].click();
  assert.equal(picker.input.value, '');
  changes = picker.changes();
  assert.equal(changes, 2);
  picker.input.value = '2027-03-12';
  picker.open();
  assert.equal(picker.document.focused.dataset.date, '2027-03-12');
};

const testNavigation = () => {
  const picker = createPicker('2028-02-29');
  const keyboard = { type: 'keydown', key: 'Enter', target: picker.input, preventDefault: () => {} };
  picker.root.dispatchEvent(keyboard);
  assert.equal(picker.document.focused.dataset.date, '2028-02-29');
  const panel = picker.panel();
  panel.children[0].children[2].click();
  assert.equal(panel.children[0].children[1].textContent, '2028-03');
  panel.children[0].children[0].click();
  assert.equal(panel.children[0].children[1].textContent, '2028-02');
  panel.hidePopover();
  assert.equal(picker.input.value, '');
  const changes = picker.changes();
  assert.equal(changes, 0);
  const leapMonth = createPicker('2009-06-23');
  leapMonth.open();
  assert.equal(leapMonth.document.focused.title, '农历闰五月初一');
  const overlapping = createPicker('2020-10-01');
  overlapping.open();
  const description = overlapping.document.focused.title;
  assert.ok(description.includes('国庆节'));
  assert.ok(description.includes('中秋节'));
};

test('空日期只定位节日，取消不填值，点选当天提交，清空及重开回填正确', testSelection);
test('支持键盘打开、闰日及月份切换，浏览和关闭均不产生选择', testNavigation);
