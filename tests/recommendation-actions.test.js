import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  addDays, calculateAdjustmentDays, classifyDay, getAdjustmentRanges, getAdjustmentSummary,
  hasAdjustmentOverlap, mergeAssociatedAdjustment, sanitizeAdjustmentRecords, sanitizeSettings
} from '../src/holiday/core.js';
import { getVacationAdjustmentLimit, hasCrossMonthCompensation, recommendVacations } from '../src/holiday/recommendations.js';
import { createQuotaHolidays } from '../src/holiday/quota.js';
import {
  getVacationRecordGroup, getVacationReplacementRecords, getVacationSelection
} from '../src/holiday/recommendation-selection.js';

const appUrl = new URL('../src/app.js', import.meta.url);
const app = readFileSync(appUrl, 'utf8');
const functionsStart = app.indexOf('function openVacationRecommendations(');
const functionsEnd = app.indexOf('function sumItemDays(');
const recommendationFunctions = app.slice(functionsStart, functionsEnd);

/**
 * 最小页面替身只承载公共推荐交互，不连接宿主或实际存储。
 */
function createPage() {
  const createElement = (tagName = 'div') => ({
    tagName: tagName.toUpperCase(), attributes: {},
    children: [], dataset: {}, textContent: '', value: '', checked: false,
    get valueAsNumber() { return Number(this.value); },
    checkValidity: () => true,
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...children) { this.children.push(...children); },
    prepend(child) { this.children.unshift(child); },
    replaceChildren() { this.children = []; this.textContent = ''; }
  });

  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const state = {
    settings: sanitizeSettings(), adjustments: [], loadedYears: [2026],
    holidays: { '2026-10-01': { kind: 'legal', name: '国庆节' } }
  };

  const elements = {
    recommendationDialog: dialog, recommendationHoliday: createElement(),
    recommendationMaximum: createElement(), recommendationCrossMonth: createElement(),
    recommendationMaximumLabel: createElement(), recommendationLeaveDays: createElement(),
    recommendationWorkMaximum: createElement(),
    recommendationResults: createElement()
  };

  const context = {
    state, elements, document: { createElement }, classifyDay, recommendVacations, getVacationAdjustmentLimit,
    hasCrossMonthCompensation,
    getVacationSelection, getAdjustmentRanges, calculateAdjustmentDays, addDays,
    structuredClone, createAdjustmentId: () => crypto.randomUUID(),
    recommendationRequest: 0, recommendationDateKey: '', recommendationEndDate: '',
    vacationRecommendations: [], calendarHolidays: state.holidays,
    ensureHolidayData: async () => {}, buildCalendarHolidays: (holidays) => holidays,
    formatDays: String
  };

  elements.recommendationLeaveDays.value = '0';
  runInNewContext(recommendationFunctions, context);
  return context;
}

const testTemporaryOptions = async () => {
  const page = createPage();
  const original = structuredClone(page.state);
  page.openVacationRecommendations('2026-10-01', '2026-10-01');
  await page.prepareVacationRecommendations();
  assert.equal(page.elements.recommendationDialog.open, true);
  assert.equal(page.elements.recommendationMaximum.value, '4');
  assert.equal(page.elements.recommendationWorkMaximum.value, '');
  assert.equal(page.elements.recommendationLeaveDays.value, '0');
  assert.equal(page.elements.recommendationCrossMonth.checked, false);
  const table = page.elements.recommendationResults.children[0];
  assert.equal(table.tagName, 'TABLE');
  assert.equal(table.attributes['aria-label'], '休假推荐方案');
  const headings = table.children[0].children[0].children.map((cell) => cell.textContent);
  const expectedHeadings = ['方案', '休假', '调休', '补班', '统计', '操作'];
  assert.deepEqual(headings, expectedHeadings);
  const rows = table.children[1].children;
  assert.equal(rows.length, 3);
  assert.equal(rows[2].children[0].textContent, '最短连续上班');
  assert.ok(rows.every((row) => row.children.length === 6));
  assert.ok(rows.every((row) => {
    const items = row.children[4].children[0].children;
    return items.every((item) => !item.textContent.startsWith('假期 '));
  }));
  assert.ok(!page.elements.recommendationResults.children[1].textContent.includes('假期 ≤'));
  page.elements.recommendationMaximum.value = '1.5';
  page.elements.recommendationWorkMaximum.value = '7.5';
  page.elements.recommendationCrossMonth.checked = true;
  await page.prepareVacationRecommendations();
  const updatedTable = page.elements.recommendationResults.children[0];
  const updatedRows = updatedTable.children[1].children;
  assert.equal(updatedRows.length, 2);
  assert.equal(updatedRows[0].children[0].textContent, '最早放假');
  assert.equal(updatedRows[1].children[0].textContent, '最长假期');
  const plans = page.vacationRecommendations;
  const longestSchedule = JSON.stringify({ vacation: plans[1].vacation, ranges: plans[1].ranges,
    leaveRanges: plans[1].leaveRanges });
  const shortestSchedule = JSON.stringify({ vacation: plans[2].vacation, ranges: plans[2].ranges,
    leaveRanges: plans[2].leaveRanges });
  assert.equal(longestSchedule, shortestSchedule);
  assert.notEqual(plans[0].vacation.startDate, plans[1].vacation.startDate);
  assert.deepEqual(page.state, original);
};

const testSidebarSelection = () => {
  const page = createPage();
  const start = app.indexOf('function renderHolidayList(');
  const end = app.indexOf('function openVacationRecommendations(');
  const source = app.slice(start, end);
  page.formatHolidayDates = (items) => items.map((item) => item.dateKey).join('、');
  page.sumItemDays = (items) => items.length;
  runInNewContext(source, page);
  const container = page.document.createElement('div');
  const holidays = [
    { dateKey: '2026-10-01', name: '国庆节' },
    { dateKey: '2026-10-02', name: '国庆节' },
    { dateKey: '2026-12-25', name: '其他假期' }
  ];

  const render = () => {
    page.renderHolidayList(container, holidays, '暂无');
    const rows = container.children;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].dataset.date, '2026-10-01');
    assert.equal(rows[0].dataset.holidayEndDate, '2026-10-02');
    assert.equal(rows[1].children.length, 3);
    return rows[0];
  };

  assert.equal(render().children.length, 3);
  const names = { earliest: '最早放假', longest: '最长假期', 'shortest-work': '最短连续上班' };

  for (const [planId, name] of Object.entries(names)) {
    page.state.adjustments = [{
      id: `rec|2026-10-01|2026-10-02|${planId}|saved|m`, createdAt: 1, note: '自定义备注'
    }];

    const row = render();
    assert.equal(row.children.length, 3);
    assert.equal(row.children[1].children.length, 1);
    assert.equal(row.children[1].children[0].className, 'holiday-recommendation');
    assert.equal(row.children[1].children[0].textContent, name);
  }

  const remainingHolidays = holidays.slice(1);
  page.renderHolidayList(container, remainingHolidays, '暂无', holidays);
  assert.equal(container.children[0].children[1].children[0].textContent, '最短连续上班');
  page.state.adjustments = [];
  assert.equal(render().children[1].children.length, 0);
  page.state.adjustments = [{ id: 'ordinary', createdAt: 1, note: '最长假期' }];
  assert.equal(render().children[1].children.length, 0);
};

const testStalePreparation = async () => {
  const page = createPage();
  const completions = [];
  page.elements.recommendationDialog.open = true;
  page.recommendationDateKey = '2026-10-01';
  page.recommendationEndDate = '2026-10-01';
  page.elements.recommendationMaximum.value = '4';
  page.ensureHolidayData = () => new Promise((resolve) => { completions.push(resolve); });
  const first = page.prepareVacationRecommendations();
  page.elements.recommendationMaximum.value = '0';
  const second = page.prepareVacationRecommendations();
  completions[1]();
  await second;
  const plans = page.vacationRecommendations;
  assert.ok(plans.every((plan) => plan.adjustmentDays === 0));
  completions[0]();
  await first;
  assert.strictEqual(page.vacationRecommendations, plans);
};

const testUseRecommendation = () => {
  const page = createPage();
  const listeners = {};
  const opened = [];
  page.elements.recommendationMaximum.addEventListener = () => {};
  page.elements.recommendationLeaveDays.addEventListener = () => {};
  page.elements.recommendationWorkMaximum.addEventListener = () => {};
  page.elements.recommendationCrossMonth.addEventListener = () => {};
  page.elements.recommendationDialog.addEventListener = (type, action) => { listeners[type] = action; };
  page.listenForSave = () => {};
  page.openAdjustmentDialog = (...args) => opened.push(args);
  page.elements.recommendationDialog.open = true;
  page.recommendationDateKey = '2026-10-01';
  page.recommendationEndDate = '2026-10-01';
  page.elements.recommendationMaximum.value = '1';
  page.elements.monthlyMaxAdjustmentDays = {};
  page.elements.allowCrossMonthAdjustment = {};
  const start = app.indexOf('const saveMonthlyMaximum =');
  const end = app.indexOf("listenForSave(elements.appearanceMode, 'click'");
  const source = app.slice(start, end);
  runInNewContext(source, page);
  const original = structuredClone(page.state);
  const button = { dataset: { useRecommendation: 'longest' } };
  const event = { target: { closest: (selector) => {
    if (selector === '[data-use-recommendation]') return button;

    return null;
  } } };

  listeners.click(event);
  assert.equal(page.elements.recommendationDialog.open, false);
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], 'rest');
  assert.equal(opened[0][1].associationType, 'required');
  assert.ok(opened[0][1].ranges.some((range) => range.type === 'work'));
  page.elements.recommendationLeaveDays.value = '2';
  page.elements.recommendationDialog.open = true;
  listeners.click(event);
  assert.equal(opened[1][1].associationType, 'required');
  assert.ok(opened[1][1].leaveRanges.length > 0);
  assert.ok(opened[1][1].ranges.some((range) => range.type === 'work'));
  page.elements.recommendationMaximum.value = '0';
  page.elements.recommendationDialog.open = true;
  listeners.click(event);
  assert.equal(opened[2][1].associationType, 'none');
  assert.equal(opened[2][1].leaveRanges.length, 0);
  assert.ok(opened[2][1].ranges.every((range) => range.type === 'rest'));
  assert.deepEqual(page.state, original);
};

const testTableStates = () => {
  const page = createPage();
  page.recommendationDateKey = '2026-10-01';
  page.recommendationEndDate = '2026-10-01';
  page.elements.recommendationMaximum.value = '0';
  page.renderVacationRecommendations();
  const rows = page.elements.recommendationResults.children[0].children[1].children;
  assert.equal(rows.length, 1);
  assert.ok(rows.every((row) => row.children[5].textContent === '-'));

  for (const row of rows) {
    for (const column of [1, 2, 3]) {
      assert.ok(row.children[column].children.every((item) => item.tagName === 'UL'));
    }

    const statistics = row.children[4];
    assert.equal(statistics.className, 'recommendation-statistics');
    const items = statistics.children[0];
    assert.equal(items.className, 'recommendation-statistic-items');
    assert.equal(items.children.length, 4);
    assert.ok(items.children.every((item) => item.className === 'recommendation-day-count'));
    assert.equal(items.children[1].textContent, '调休 0 天');
    assert.equal(items.children[2].textContent, '补班 0 天');
    assert.ok(items.children[3].textContent.startsWith('连班 '));
  }

  const base = page.vacationRecommendations[0];
  const fullDay = { type: 'work', startPeriod: 'am', endPeriod: 'pm' };
  const work = [
    { ...fullDay, startDate: '2027-02-15', endDate: '2027-02-15' },
    { ...fullDay, startDate: '2027-02-08', endDate: '2027-02-08', startPeriod: 'pm' },
    { ...fullDay, startDate: '2027-02-09', endDate: '2027-02-09', startPeriod: 'pm' },
    { ...fullDay, startDate: '2027-01-31', endDate: '2027-02-01', startPeriod: 'pm', endPeriod: 'am' },
    { ...fullDay, startDate: '2027-02-04', endDate: '2027-02-04', endPeriod: 'am' },
    { ...fullDay, startDate: '2027-02-05', endDate: '2027-02-05', endPeriod: 'am' },
    { ...fullDay, startDate: '2027-02-02', endDate: '2027-02-03' }
  ];

  page.recommendVacations = () => [{ ...base, ranges: work }];
  page.renderVacationRecommendations();
  const row = page.elements.recommendationResults.children[0].children[1].children[0];
  const workLabels = row.children[3].children[0].children.map((item) => item.textContent);
  const expected = ['2027-01（31）下午', '2027-02（2-3、15）',
    '2027-02（1、4、5）上午', '2027-02（8、9）下午'];
  assert.deepEqual(workLabels, expected);
  assert.equal(row.children[2].children[0].children.length, 0);
  assert.equal(row.children[2].children[1].children.length, 0);
  page.elements.recommendationLeaveDays.value = '1';
  const vacation = { ...fullDay, type: 'rest', startDate: '2027-01-31', endDate: '2027-02-03',
    startPeriod: 'pm', endPeriod: 'am' };
  const restRanges = [
    { ...fullDay, type: 'rest', startDate: '2027-02-06', endDate: '2027-02-07' },
    { ...fullDay, type: 'rest', startDate: '2027-02-08', endDate: '2027-02-08', endPeriod: 'am' }
  ];

  const leaveRanges = [{ ...fullDay, type: 'rest', startDate: '2027-02-09', endDate: '2027-02-09',
    startPeriod: 'pm' }];
  page.recommendVacations = () => [{ ...base, vacation, ranges: [...restRanges, ...work], leaveRanges, leaveDays: 1 }];
  page.renderVacationRecommendations();
  const leaveRow = page.elements.recommendationResults.children[0].children[1].children[0];
  assert.ok(leaveRow.children[4].children[0].children.some((item) => item.textContent === '假期 1 天'));
  assert.ok(page.elements.recommendationResults.children[1].textContent.includes('假期 ≤ 1 天'));
  const vacationLabels = leaveRow.children[1].children[0].children.map((item) => item.textContent);
  const expectedVacation = ['2027-01（31）下午', '2027-02（1-2）', '2027-02（3）上午'];
  assert.deepEqual(vacationLabels, expectedVacation);
  const leaveLabels = leaveRow.children[2].children[0].children.map((item) => item.textContent);
  const expectedLeave = ['假期 2027-02（9）下午'];
  assert.deepEqual(leaveLabels, expectedLeave);
  const restLabels = leaveRow.children[2].children[1].children.map((item) => item.textContent);
  const expectedRest = ['调休 2027-02（6-7）', '调休 2027-02（8）上午'];
  assert.deepEqual(restLabels, expectedRest);
  const noPlans = () => [{ id: 'shortest-work', title: '最短连续上班', unavailable: true }];
  page.recommendVacations = noPlans;
  page.renderVacationRecommendations();
  const unavailable = page.elements.recommendationResults.children[0].children[1].children[0];
  assert.equal(unavailable.children.length, 2);
  assert.equal(unavailable.children[1].colSpan, 5);
  assert.ok(unavailable.children[1].textContent.includes('没有可用方案'));
};

const testWorkMaximum = async () => {
  const page = createPage();
  const original = structuredClone(page.state);
  page.elements.recommendationDialog.open = true;
  page.recommendationDateKey = '2026-10-01';
  page.recommendationEndDate = '2026-10-01';
  page.elements.recommendationMaximum.value = '4';
  page.elements.recommendationWorkMaximum.value = '1';
  await page.prepareVacationRecommendations();
  assert.ok(page.vacationRecommendations.every((plan) => plan.unavailable));
  page.elements.recommendationWorkMaximum.value = '';
  await page.prepareVacationRecommendations();
  assert.ok(page.vacationRecommendations.every((plan) => !plan.unavailable));
  assert.deepEqual(page.state, original);
  page.elements.recommendationWorkMaximum.value = '1.25';
  page.elements.recommendationWorkMaximum.checkValidity = () => false;
  page.renderVacationRecommendations();
  assert.equal(page.vacationRecommendations.length, 0);
  assert.ok(page.elements.recommendationResults.textContent.includes('0.5'));
};

const testNativeWindow = async () => {
  const page = createPage();
  let opened = 0;
  page.calendarPlatform = {
    recommendationsOpen: false,
    openRecommendations: async () => {
      opened += 1;
      page.calendarPlatform.recommendationsOpen = true;
    }
  };

  page.elements.recommendationDialog.showModal = () => assert.fail('桌面推荐不能再打开主窗口内的模态弹窗');
  page.openVacationRecommendations('2026-10-01', '2026-10-01');
  await page.prepareVacationRecommendations();
  assert.equal(opened, 1);
  assert.equal(page.elements.recommendationDialog.open, false);
  assert.equal(page.vacationRecommendations.length, 3);
};

const testCapacity = () => {
  const page = createPage();
  page.state.settings = sanitizeSettings({ weekendRules: {
    5: { restPeriod: 'none', repeatIntervalWeeks: 0 },
    6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
  } });

  page.recommendationDateKey = '2026-10-01';
  page.recommendationEndDate = '2026-10-01';
  page.elements.recommendationMaximum.value = '31';
  page.renderVacationRecommendations();
  assert.equal(page.elements.recommendationMaximum.max, '6');
  assert.equal(page.elements.recommendationMaximum.value, '6');
  assert.equal(page.elements.recommendationMaximumLabel.textContent, '调休上限（最多 6 天）');
  page.elements.recommendationCrossMonth.checked = true;
  page.elements.recommendationMaximum.value = '31';
  page.renderVacationRecommendations();
  assert.equal(page.elements.recommendationMaximum.max, '11');
  assert.equal(page.elements.recommendationMaximum.value, '11');
};

const testCapacityWorkMaximum = async () => {
  const page = createPage();
  page.state.loadedYears = [2027];
  page.state.holidays = createQuotaHolidays(2027, 2026, page.state.settings);
  page.calendarHolidays = page.state.holidays;
  const original = structuredClone(page.state);
  page.openVacationRecommendations('2027-02-05', '2027-02-10');
  await page.prepareVacationRecommendations();
  assert.equal(page.elements.recommendationMaximum.value, '4');
  page.elements.recommendationWorkMaximum.value = '6';
  page.renderVacationRecommendations();
  assert.equal(page.elements.recommendationMaximum.max, '2');
  assert.equal(page.elements.recommendationMaximum.value, '2');
  assert.ok(page.vacationRecommendations.every((plan) => plan.longestWorkDays <= 6));
  page.elements.recommendationWorkMaximum.value = '6.5';
  page.renderVacationRecommendations();
  assert.equal(page.elements.recommendationMaximum.max, '2.5');
  assert.equal(page.elements.recommendationMaximum.value, '2');
  page.elements.recommendationMaximum.value = '4';
  page.elements.recommendationWorkMaximum.value = '6.25';
  page.renderVacationRecommendations();
  assert.equal(page.elements.recommendationMaximum.value, '4');
  assert.equal(page.elements.recommendationMaximum.max, '2.5');
  assert.ok(page.elements.recommendationResults.textContent.includes('0.5'));
  page.elements.recommendationWorkMaximum.value = '0.5';
  page.renderVacationRecommendations();
  assert.equal(page.elements.recommendationMaximum.max, '0');
  assert.equal(page.elements.recommendationMaximum.value, '0');
  page.elements.recommendationWorkMaximum.value = '';
  page.renderVacationRecommendations();
  assert.equal(page.elements.recommendationMaximum.max, '10');
  assert.equal(page.elements.recommendationMaximum.value, '0');
  assert.deepEqual(page.state, original);

  // 重新打开时取默认值，再按当次容量下调，不改写已保存的设置。
  page.getVacationAdjustmentLimit = () => 1.5;
  page.openVacationRecommendations('2027-02-05', '2027-02-10');
  await page.prepareVacationRecommendations();
  assert.equal(page.elements.recommendationMaximum.value, '1.5');
  assert.deepEqual(page.state, original);
};

/**
 * 实际保存逻辑只写入独立快照替身，核对免补班假期不会产生补班欠额。
 */
const testLeaveSave = async () => {
  const settings = sanitizeSettings({ weekendRules: {
    5: { restPeriod: 'full', repeatIntervalWeeks: 0 },
    6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
  } });

  const rest = { type: 'rest', startDate: '2026-10-13', startPeriod: 'am', endDate: '2026-10-13', endPeriod: 'pm' };
  const work = { type: 'work', startDate: '2026-10-17', startPeriod: 'am', endDate: '2026-10-17', endPeriod: 'pm' };
  const leave = { ...rest, startDate: '2026-10-15', endDate: '2026-10-15' };
  const draft = { id: '', associationType: 'required', ranges: [rest, work], note: '推荐' };
  const context = {
    state: { settings, adjustments: [] }, calendarHolidays: {}, recommendationLeaveRanges: [leave],
    recommendationSelection: null, getVacationReplacementRecords,
    selectedAdjustmentId: '', activeAdjustmentRangeType: 'rest', structuredClone,
    getAdjustmentDraft: () => structuredClone(draft), calculateAdjustmentDays, getAdjustmentRanges,
    getAdjustmentSummary, hasAdjustmentOverlap, mergeAssociatedAdjustment, sanitizeAdjustmentRecords,
    render: () => {}, showToast: () => {}, createAdjustmentId: () => crypto.randomUUID()
  };

  context.commitState = async (update) => {
    const next = structuredClone(context.state);
    update(next);
    context.state = next;
  };

  const start = app.indexOf('function hasValidAdjustmentRange(');
  const end = app.indexOf('\nfunction createAdjustmentId(', start);
  const source = app.slice(start, end);
  runInNewContext(source, context);
  const occupied = { id: 'occupied', associationType: 'none', ranges: [leave], createdAt: 1, note: '' };
  context.state.adjustments = [occupied];
  const rejected = await context.saveAdjustmentRecord();
  assert.equal(rejected, false);
  assert.equal(context.state.adjustments.length, 1);
  context.state.adjustments = [];
  await context.saveAdjustmentRecord();
  assert.equal(context.state.adjustments.length, 2);
  const free = context.state.adjustments.find((record) => record.associationType === 'none');
  assert.equal(free.ranges[0].startDate, '2026-10-15');
  const summary = getAdjustmentSummary(context.state.adjustments, settings, context.calendarHolidays);
  assert.equal(summary.restRemaining, 0);
  assert.equal(summary.workRemaining, 0);
  assert.equal(summary.restTotal, 2);
  assert.equal(summary.workTotal, 1);
  const original = structuredClone(context.state);
  context.commitState = async (update) => {
    const next = structuredClone(context.state);
    update(next);
    throw new Error('模拟保存失败');
  };

  // 新建推荐与原记录不重叠，失败时两类记录均不得提前发布。
  context.state.adjustments = [];
  const beforeFailure = structuredClone(context.state);
  const saving = context.saveAdjustmentRecord();
  await assert.rejects(saving, /模拟保存失败/);
  assert.deepEqual(context.state, beforeFailure);
  assert.equal(original.adjustments.length, 2);
};

/**
 * 用真实推荐、采用与保存函数配合内存提交替身验证完整更换及撤回过程。
 */
const testSelectionLifecycle = async () => {
  const page = createPage();
  page.state.settings = sanitizeSettings({ weekendRules: {
    5: { restPeriod: 'full', repeatIntervalWeeks: 0 },
    6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
  } });

  page.state.holidays = { '2026-10-14': { kind: 'legal', name: '测试假期' } };
  page.calendarHolidays = page.state.holidays;
  const rest = { type: 'rest', startDate: '2026-10-28', endDate: '2026-10-28', startPeriod: 'am', endPeriod: 'pm' };
  const manual = { id: 'manual', ranges: [rest], associationType: 'none', note: '手动安排', createdAt: 1 };
  page.state.adjustments = [manual];
  const original = structuredClone(page.state.adjustments);
  const listeners = {};
  page.elements.recommendationDialog.addEventListener = (type, action) => { listeners[type] = action; };
  page.elements.recommendationMaximum.addEventListener = () => {};
  page.elements.recommendationLeaveDays.addEventListener = () => {};
  page.elements.recommendationWorkMaximum.addEventListener = () => {};
  page.elements.recommendationCrossMonth.addEventListener = () => {};
  page.listenForSave = () => {};
  let draft;
  page.openAdjustmentDialog = (type, record) => {
    draft = { id: '', ranges: structuredClone(record.ranges), associationType: record.associationType, note: record.note };
    page.recommendationLeaveRanges = structuredClone(record.leaveRanges);
    page.recommendationSelection = structuredClone(record.recommendationSelection);
  };

  const bindings = { getVacationReplacementRecords, getAdjustmentSummary, hasAdjustmentOverlap,
    mergeAssociatedAdjustment, sanitizeAdjustmentRecords, recommendationSelection: null,
    selectedAdjustmentId: '', activeAdjustmentRangeType: 'rest', getAdjustmentDraft: () => draft,
    render: () => {}, showToast: () => {} };

  Object.assign(page, bindings);
  const actionsStart = app.indexOf('const saveMonthlyMaximum =');
  const actionsEnd = app.indexOf("listenForSave(elements.appearanceMode, 'click'");
  const actionSource = app.slice(actionsStart, actionsEnd);
  runInNewContext(actionSource, page);
  const saveStart = app.indexOf('function hasValidAdjustmentRange(');
  const saveEnd = app.indexOf('\nfunction createAdjustmentId(', saveStart);
  const saveSource = app.slice(saveStart, saveEnd);
  runInNewContext(saveSource, page);
  const cancelStart = app.indexOf('async function cancelVacationRecommendation(');
  const cancelEnd = app.indexOf('\nfunction initializeDateCorrection(', cancelStart);
  const cancelSource = app.slice(cancelStart, cancelEnd);
  runInNewContext(cancelSource, page);
  page.recommendationDateKey = '2026-10-14';
  page.recommendationEndDate = '2026-10-14';
  page.elements.recommendationMaximum.value = '1';
  page.elements.recommendationLeaveDays.value = '1';
  page.elements.recommendationDialog.open = true;
  const button = { dataset: { useRecommendation: 'longest' } };
  const event = { target: { closest: (selector) => {
    if (selector === '[data-use-recommendation]') return button;

    return null;
  } } };

  let fail = false;
  page.commitState = async (update) => {
    const next = structuredClone(page.state);
    update(next);

    if (fail) throw new Error('模拟写入失败');

    page.state = structuredClone(next);
  };

  listeners.click(event);
  assert.deepEqual(page.state.adjustments, original);
  await page.saveAdjustmentRecord();
  const holiday = { dateKey: page.recommendationDateKey, endDate: page.recommendationEndDate };
  const selected = getVacationSelection(page.state.adjustments, holiday);
  assert.equal(selected.records.length, 2);
  page.openVacationRecommendations(holiday.dateKey, holiday.endDate);
  await page.prepareVacationRecommendations();
  assert.equal(page.elements.recommendationLeaveDays.value, '1');
  page.elements.recommendationMaximum.value = '1';
  page.elements.recommendationDialog.open = true;
  page.renderVacationRecommendations();
  const results = page.elements.recommendationResults;
  assert.equal(results.children[0].children[1].textContent, '取消方案');
  const recommended = page.vacationRecommendations;
  const baseline = recommendVacations({ dateKey: holiday.dateKey, holidayEndDate: holiday.endDate,
    settings: page.state.settings, holidays: page.state.holidays, adjustments: original, maximum: 1, leaveDays: 1 });
  const actualPlans = JSON.stringify(recommended);
  const expectedPlans = JSON.stringify(baseline);
  assert.equal(actualPlans, expectedPlans);
  page.elements.recommendationLeaveDays.value = '';
  page.renderVacationRecommendations();
  assert.equal(results.children[0].children[1].textContent, '取消方案');
  page.elements.recommendationMaximum.value = '0';
  page.elements.recommendationLeaveDays.value = '2';
  button.dataset.useRecommendation = 'earliest';
  listeners.click(event);
  const beforeReplacement = structuredClone(page.state.adjustments);
  fail = true;
  const failedSave = page.saveAdjustmentRecord();
  await assert.rejects(failedSave, /模拟写入失败/);
  assert.deepEqual(page.state.adjustments, beforeReplacement);
  fail = false;
  await page.saveAdjustmentRecord();
  const replacement = getVacationSelection(page.state.adjustments, holiday);
  assert.notEqual(replacement.groupId, selected.groupId);
  assert.equal(replacement.records.length, 1);
  assert.equal(replacement.records[0].associationType, 'none');
  assert.equal(page.state.adjustments.length, 2);
  const afterReplacement = structuredClone(page.state.adjustments);
  const staleSave = await page.saveAdjustmentRecord();
  assert.equal(staleSave, false);
  assert.deepEqual(page.state.adjustments, afterReplacement);
  const staleCancel = await page.cancelVacationRecommendation(selected.groupId);
  assert.equal(staleCancel, false);
  fail = true;
  const failedCancel = page.cancelVacationRecommendation(replacement.groupId);
  await assert.rejects(failedCancel, /模拟写入失败/);
  assert.deepEqual(page.state.adjustments, afterReplacement);
  fail = false;
  page.prepareVacationRecommendations = () => assert.fail('取消方案不应等待年度数据加载');
  await page.cancelVacationRecommendation(replacement.groupId);
  assert.deepEqual(page.state.adjustments, original);
  const none = getVacationSelection(page.state.adjustments, holiday);
  assert.equal(none, null);
  page.elements.recommendationMaximum.value = '1';
  page.elements.recommendationLeaveDays.value = '1';
  page.elements.recommendationDialog.open = true;
  listeners.click(event);
  await page.saveAdjustmentRecord();
  const deleted = getVacationSelection(page.state.adjustments, holiday);
  assert.equal(deleted.records.length, 2);
  let deleteAction;
  page.getVacationRecordGroup = getVacationRecordGroup;
  page.window = { confirm: () => true };
  page.elements.calendarView = {};
  page.listenForSave = (element, type, action) => { deleteAction = action; };
  const deleteStart = app.indexOf("listenForSave(elements.calendarView, 'click',");
  const deleteEnd = app.indexOf('\n});', deleteStart) + 4;
  const deleteSource = app.slice(deleteStart, deleteEnd);
  runInNewContext(deleteSource, page);
  const deleteButton = { dataset: { deleteAdjustmentId: deleted.records[0].id } };
  const deleteEvent = { target: { closest: () => deleteButton } };
  await deleteAction(deleteEvent);
  assert.deepEqual(page.state.adjustments, original);
};

const testMakeupCrossMonthRestore = async () => {
  const page = createPage();
  const dateKey = '2027-01-01';
  const groupId = `rec|${dateKey}|${dateKey}|earliest|saved`;
  const rest = { type: 'rest', startDate: '2026-12-30', endDate: '2026-12-30', startPeriod: 'am', endPeriod: 'pm' };
  const work = { ...rest, type: 'work', startDate: '2027-01-09', endDate: '2027-01-09' };
  const free = { ...rest, startDate: '2026-12-31', endDate: '2026-12-31' };
  const main = { id: `${groupId}|m`, associationType: 'required', ranges: [rest, work], note: '最早放假', createdAt: 1 };
  const leave = { ...main, id: `${groupId}|l`, associationType: 'none', ranges: [free] };
  page.state.adjustments = [main, leave];
  page.state.holidays = { [dateKey]: { kind: 'legal', name: '元旦' } };
  page.calendarHolidays = page.state.holidays;
  const years = [];
  page.ensureHolidayData = async (year) => { years.push(year); };
  page.openVacationRecommendations(dateKey, dateKey);
  await page.prepareVacationRecommendations();
  assert.equal(page.elements.recommendationCrossMonth.checked, true);
  assert.equal(page.elements.recommendationLeaveDays.value, '1');
  const preparedYears = [...new Set(years)].sort();
  const expected = [2026, 2027];
  assert.deepEqual(preparedYears, expected);
  page.elements.recommendationDialog.close();
  main.ranges[1] = { ...work, startDate: '2026-12-27', endDate: '2026-12-27' };
  page.openVacationRecommendations(dateKey, dateKey);
  await page.prepareVacationRecommendations();
  assert.equal(page.elements.recommendationCrossMonth.checked, false);
  page.elements.recommendationDialog.close();
  page.state.adjustments = [{ ...main, ranges: [rest] }];
  page.openVacationRecommendations(dateKey, dateKey);
  await page.prepareVacationRecommendations();
  assert.equal(page.elements.recommendationCrossMonth.checked, false);
  page.elements.recommendationDialog.close();
  page.state.adjustments = [{ ...main, associationType: 'none', ranges: [free] }];
  page.openVacationRecommendations(dateKey, dateKey);
  await page.prepareVacationRecommendations();
  assert.equal(page.elements.recommendationCrossMonth.checked, false);
};

test('推荐弹窗默认四天且不跨月，临时修改只改变方案，不写入设置', testTemporaryOptions);
test('假日侧栏仅显示已保存推荐类型名称，更换同步、取消隐藏且普通备注不冒充方案', testSidebarSelection);
test('旧年度准备晚到不会覆盖新一轮参数生成的方案', testStalePreparation);
test('使用方案重新计算并交给原调班表单，未确认前不提交排班', testUseRecommendation);
test('表格保持零调班状态及不可用方案的列对齐', testTableStates);
test('最长上班上限仅影响本次方案，留空恢复不限，非法输入显示校验提示', testWorkMaximum);
test('桌面推荐走独立窗口入口，隐藏的公共表单仍能生成方案', testNativeWindow);
test('调休输入最大值随可补班日期和跨月配置更新，超过容量时回到上限', testCapacity);
test('上班上限联动容量并下调默认临时额度，放宽不自动回升且不写入设置', testCapacityWorkMaximum);
test('采用混合方案时免补班假期与调休原子保存，不产生补班欠额', testLeaveSave);
test('已采用方案可整体更换或取消，失败及过期操作保留原状态，其他手动调班不受影响', testSelectionLifecycle);
test('跨月回填比较每月调休补班余额，忽略假日月份和免补班假期，仍准备相邻年度', testMakeupCrossMonthRestore);
