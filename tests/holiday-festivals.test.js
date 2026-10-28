import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { formatLunarDate, getFestivalNames } from '../src/holiday/festivals.js';
import {
  buildMonthGrid,
  classifyDay,
  createCalendarCalculation,
  DEFAULT_SETTINGS,
  getConsecutiveRestState,
  removeAdjustmentYear
} from '../src/holiday/core.js';
import { decodeHolidayImport, encodeHolidays, replaceHolidayYears } from '../src/holiday/storage.js';

const testLocalFestivals = () => {
  const expected = {
    '2027-01-01': ['元旦'],
    '2027-02-05': ['除夕'],
    '2027-02-06': ['春节'],
    '2027-04-05': ['清明节'],
    '2027-05-01': ['劳动节'],
    '2027-06-09': ['端午节'],
    '2027-09-15': ['中秋节'],
    '2027-10-01': ['国庆节']
  };

  Object.entries(expected).forEach(([dateKey, names]) => {
    const actual = getFestivalNames(dateKey);
    assert.deepEqual(actual, names);
  });
};

test('2027 年没有官方安排时仍能计算公历、农历、除夕和清明节日', testLocalFestivals);

const testLunarLabels = () => {
  const expected = {
    '2027-01-07': '冬月三十',
    '2027-01-08': '腊月初一',
    '2027-02-05': '腊月廿九',
    '2027-02-06': '正月初一',
    '2027-02-07': '正月初二',
    '2027-03-07': '正月三十',
    '2027-03-08': '二月初一',
    '2027-06-09': '五月初五',
    '2027-09-15': '八月十五',
    '2009-06-23': '闰五月初一'
  };

  Object.entries(expected).forEach(([dateKey, label]) => {
    const actual = formatLunarDate(dateKey);
    assert.equal(actual, label);
  });
};

test('农历显示使用离线历法，覆盖 2027 年春节、月界及闰月', testLunarLabels);

const testDomesticFestivals = () => {
  const expected = {
    '2027-01-30': ['北方小年'],
    '2027-01-31': ['南方小年'],
    '2027-02-14': ['情人节'],
    '2027-02-20': ['元宵节'],
    '2027-03-08': ['妇女节'],
    '2027-03-09': ['龙抬头'],
    '2027-05-04': ['青年节'],
    '2027-05-09': ['母亲节'],
    '2027-06-01': ['儿童节'],
    '2027-06-20': ['父亲节'],
    '2027-07-01': ['建党节', '香港回归纪念日'],
    '2027-08-01': ['建军节'],
    '2027-09-10': ['教师节'],
    '2027-12-04': ['国家宪法日'],
    '2027-12-13': ['国家公祭日'],
    '2027-12-20': ['澳门回归纪念日']
  };

  Object.entries(expected).forEach(([dateKey, expectedNames]) => {
    const actual = getFestivalNames(dateKey);
    expectedNames.forEach((name) => {
      const found = actual.includes(name);
      const message = `${dateKey} 缺少 ${name}`;
      assert.ok(found, message);
    });
  });
};

test('国内传统节日、公共节日、纪念日与按星期计算的节日均显示', testDomesticFestivals);

const testDomesticFestivalFiltering = () => {
  const christmas = getFestivalNames('2027-12-25');
  const thanksgiving = getFestivalNames('2027-11-25');
  const halloween = getFestivalNames('2027-10-31');
  const overlapping = getFestivalNames('2027-07-01');
  const heavenDay = getFestivalNames('2027-02-14');
  const earthDay = getFestivalNames('2027-02-15');
  const expectedHeavenDay = ['情人节'];
  const expectedEarthDay = [];
  const hasChristmas = christmas.includes('圣诞节');
  const hasThanksgiving = thanksgiving.includes('感恩节');
  const hasHalloween = halloween.includes('万圣节前夜');
  const uniqueCount = new Set(overlapping).size;
  assert.equal(hasChristmas, false);
  assert.equal(hasThanksgiving, false);
  assert.equal(hasHalloween, false);
  assert.equal(uniqueCount, overlapping.length);
  assert.deepEqual(heavenDay, expectedHeavenDay);
  assert.deepEqual(earthDay, expectedEarthDay);

  const options = { includeFolk: true };
  const fullHeavenDay = getFestivalNames('2027-02-14', options);
  const fullEarthDay = getFestivalNames('2027-02-15', options);
  const expectedFullHeavenDay = ['情人节', '天公生'];
  const expectedFullEarthDay = ['石头节'];
  const filteredAgain = getFestivalNames('2027-02-15');
  assert.deepEqual(fullHeavenDay, expectedFullHeavenDay);
  assert.deepEqual(fullEarthDay, expectedFullEarthDay);
  assert.deepEqual(filteredAgain, expectedEarthDay);
};

test('日期格过滤民俗，明细保留完整民俗，别名归一且缓存互不影响', testDomesticFestivalFiltering);

const testCommonFestivalsFirst = () => {
  const qixi = getFestivalNames('2026-08-19');
  const expectedQixi = ['七夕节', '中国医师节'];
  const womensDay = getFestivalNames('2027-03-08');
  const includesFolkFestival = womensDay.includes('中和节');
  assert.deepEqual(qixi, expectedQixi);
  assert.equal(womensDay[0], '妇女节');
  assert.equal(includesFolkFestival, false);
};

test('同日常用节日优先于纪念日，冷门民俗项不再显示', testCommonFestivalsFirst);

const testLeapMonthAndOverlap = () => {
  const leapMonth = getFestivalNames('2009-06-27');
  const overlap = getFestivalNames('2020-10-01');
  const ordinary = getFestivalNames('2027-02-08');
  const expectedOverlap = ['国庆节', '中秋节'];
  assert.deepEqual(leapMonth, []);
  assert.deepEqual(overlap, expectedOverlap);
  assert.deepEqual(ordinary, []);
};

test('闰五月不误判端午，重合节日同时保留，普通日期没有节日', testLeapMonthAndOverlap);

const testFestivalDoesNotChangeRest = () => {
  const holidays = {};
  const day = classifyDay('2027-01-01', DEFAULT_SETTINGS, holidays);
  const names = getFestivalNames(day.dateKey);
  assert.ok(names.includes('元旦'));
  assert.equal(day.isRest, false);
  assert.equal(day.pureLegalAmount, 0);
  assert.deepEqual(day.officialLabels, []);
};

test('本地节日不产生官方标签或改变周末休息结果', testFestivalDoesNotChangeRest);

const testYearImport = () => {
  const holidays = {
    '2026-01-01': { kind: 'legal', name: '元旦' },
    '2027-01-02': { kind: 'work', name: '旧修正' }
  };

  const state = { holidays, loadedYears: [2026, 2027], settings: DEFAULT_SETTINGS, adjustments: [] };
  const importedDays = { '2027-01-01': { kind: 'legal', name: '元旦' } };
  const content = {
    version: 7,
    holidayData: encodeHolidays(importedDays),
    loadedYears: [2026, 2027],
    settings: { weekStartsOn: 0 },
    adjustments: [{ id: '不得导入' }]
  };

  const imported = decodeHolidayImport(content);
  const result = replaceHolidayYears(state, imported);
  const expectedYears = [2026, 2027];
  assert.equal(result.holidays['2027-01-02'], undefined);
  assert.equal(result.holidays['2027-01-01'].kind, 'legal');
  assert.equal(result.holidays['2026-01-01'].kind, 'legal');
  assert.equal(result.settings, state.settings);
  assert.equal(result.adjustments, state.adjustments);
  assert.deepEqual(result.loadedYears, expectedYears);
};

test('导入只替换实际有日期的年份，保留其他年份、设置及个人调班', testYearImport);

const testAnnualImport = () => {
  const content = {
    year: 2027,
    days: [{ date: '2027-01-01', name: '元旦', isOffDay: true }]
  };

  const imported = decodeHolidayImport(content);
  const empty = { year: 2027, days: [] };
  const wrongYear = { ...content, year: 3000 };
  const readEmpty = () => decodeHolidayImport(empty);
  const readWrongYear = () => decodeHolidayImport(wrongYear);
  assert.equal(imported.holidays['2027-01-01'].kind, 'block');
  assert.throws(readEmpty, /暂无/);
  assert.throws(readWrongYear, /年份无效/);
};

test('导入支持 holiday-cn 年度文件，拒绝空年度和错误年份', testAnnualImport);

const testCrossYearReset = () => {
  const records = [{
    id: 'cross-year',
    associationType: 'required',
    note: '跨年安排',
    ranges: [{
      type: 'rest', startDate: '2026-12-31', startPeriod: 'pm', endDate: '2028-01-01', endPeriod: 'am'
    }]
  }, {
    id: 'only-2027',
    ranges: [{
      type: 'work', startDate: '2027-05-01', startPeriod: 'am', endDate: '2027-05-02', endPeriod: 'pm'
    }]
  }];

  const result = removeAdjustmentYear(records, 2027);
  const expected = [{
    type: 'rest', startDate: '2026-12-31', startPeriod: 'pm', endDate: '2026-12-31', endPeriod: 'pm'
  }, {
    type: 'rest', startDate: '2028-01-01', startPeriod: 'am', endDate: '2028-01-01', endPeriod: 'am'
  }];

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'cross-year');
  assert.equal(result[0].note, '跨年安排');
  assert.deepEqual(result[0].ranges, expected);
  assert.equal(records[0].ranges[0].endDate, '2028-01-01');
};

test('年份重置切除跨年个人调班，保留其他年份的时段和操作信息', testCrossYearReset);

/**
 * 仅模拟渲染使用的 DOM 接口，保留实际日历渲染函数和计算逻辑。
 */
function createElement() {
  const children = [];
  const attributes = {};
  const classes = new Set();
  const classList = {
    add: (name) => classes.add(name),
    remove: (name) => classes.delete(name),
    toggle: (name, enabled) => {
      if (enabled) {
        classes.add(name);
      } else {
        classes.delete(name);
      }
    }
  };

  return {
    children,
    attributes,
    classes,
    classList,
    dataset: {},
    focus: () => {},
    append: (...items) => children.push(...items),
    replaceChildren: (...items) => children.splice(0, children.length, ...items),
    setAttribute: (name, value) => { attributes[name] = value; },
    get childElementCount() { return children.length; }
  };
}

const testCalendarFestivalRendering = () => {
  const appUrl = new URL('../src/app.js', import.meta.url);
  const app = readFileSync(appUrl, 'utf8');
  const start = app.indexOf('function renderCalendar(');
  const end = app.indexOf('function renderSummary(');
  const source = app.slice(start, end) + '\nrenderCalendar;';
  const elements = {
    monthTitle: createElement(),
    weekdayHeader: createElement(),
    calendarGrid: createElement(),
    selectedDateLabel: createElement(),
    selectedDateLunar: createElement(),
    selectedDayStatus: createElement(),
    selectedFestivalCount: createElement(),
    selectedFestivalList: createElement()
  };

  const state = { settings: DEFAULT_SETTINGS, holidays: {}, adjustments: [] };
  const context = {
    elements,
    state,
    calendarHolidays: state.holidays,
    document: { createElement },
    viewYear: 2027,
    viewMonth: 2,
    now: new Date(),
    activeDateKey: '',
    WEEKDAY_LABELS: ['一', '二', '三', '四', '五', '六', '日'],
    CATEGORY_LABELS: { 'schedule-rest': '休息', 'regular-work': '上班', 'manual-rest': '调休' },
    buildMonthGrid,
    classifyDay,
    createCalendarCalculation,
    getConsecutiveRestState,
    getFestivalNames,
    formatLongDate: (dateKey) => dateKey,
    toLocalDateKey: () => '2027-02-01',
    formatLunarDate
  };

  const render = runInNewContext(source, context);
  render();
  const festival = elements.calendarGrid.children.find((button) => button.dataset.date === '2027-02-06');
  const accessibleName = festival.attributes['aria-label'];
  const header = festival.children[0].children[0];
  const main = festival.children[0].children[1];
  const lunarLabel = header.children[0].textContent;
  const hasOfficialHoliday = festival.classes.has('official-holiday');
  assert.match(accessibleName, /春节/);
  assert.equal(lunarLabel, '正月初一');
  assert.equal(main.children[0].textContent, '6');
  assert.equal(main.children[1].textContent, '春节');
  assert.equal(hasOfficialHoliday, false);
  const isBoldFestival = festival.classes.has('festival-holiday');
  assert.equal(isBoldFestival, false);

  const lantern = elements.calendarGrid.children.find((button) => button.dataset.date === '2027-02-20');
  const lanternName = lantern.children[0].children[1].children[1].textContent;
  const lanternBold = lantern.classes.has('festival-holiday');
  assert.match(lanternName, /元宵节/);
  assert.equal(lanternBold, false);

  const workday = elements.calendarGrid.children.find((button) => button.dataset.date === '2027-02-02');
  assert.equal(workday.children[1].children.length, 0);
  assert.match(workday.attributes['aria-label'], /全天 上班/);

  const restDay = elements.calendarGrid.children.find((button) => button.dataset.date === '2027-02-07');
  const restLines = restDay.children[1].children;
  assert.equal(restLines.length, 0);
  assert.match(restDay.attributes['aria-label'], /全天 休息/);

  state.adjustments = [{
    id: 'half-day-rest',
    type: 'rest',
    associationType: 'none',
    ranges: [{ type: 'rest', startDate: '2027-02-01', endDate: '2027-02-01', startPeriod: 'am', endPeriod: 'am' }]
  }];

  render();
  const halfDay = elements.calendarGrid.children.find((button) => button.dataset.date === '2027-02-01');
  const halfDayLines = halfDay.children[1].children;
  assert.equal(halfDayLines.length, 2);
  assert.equal(halfDayLines[0].className, 'period-status-item manual-rest');
  assert.equal(halfDayLines[0].title, '上午 调休');
  assert.equal(halfDayLines[1].className, 'period-status-item regular-work');
  assert.equal(halfDayLines[1].title, '下午 上班');
  assert.ok(halfDayLines.every((item) => !item.textContent));
  assert.match(halfDay.attributes['aria-label'], /上午 调休 下午 上班/);
  state.adjustments = [];

  state.holidays['2027-02-06'] = { kind: 'legal', name: '春节' };
  state.holidays['2027-02-07'] = { kind: 'legal', name: '春节假期' };
  render();
  const arrangedFestival = elements.calendarGrid.children.find((button) => button.dataset.date === '2027-02-06');
  const arrangedBold = arrangedFestival.classes.has('festival-holiday');
  const arrangedHeader = arrangedFestival.children[0].children[0];
  const arrangedTags = arrangedHeader.children[1];
  assert.equal(arrangedHeader.children[0].className, 'day-lunar');
  assert.equal(arrangedTags.className, 'day-tags');
  assert.equal(arrangedTags.children[0].textContent, '放假');
  assert.equal(arrangedBold, true);
  const allocated = elements.calendarGrid.children.find((button) => button.dataset.date === '2027-02-07');
  const allocatedName = allocated.children[0].children[1].children[1].textContent;
  const allocatedOfficial = allocated.classes.has('official-holiday');
  assert.equal(allocatedName, '京汉铁路罢工纪念日');
  assert.equal(allocatedOfficial, true);

  context.viewMonth = 7;
  context.activeDateKey = '2027-07-01';
  render();
  const overlapping = elements.calendarGrid.children.find((button) => button.dataset.date === '2027-07-01');
  const displayedName = overlapping.children[0].children[1].children[1].textContent;
  assert.equal(displayedName, '建党节');

  const detailStart = app.indexOf('function renderSelectedDate(');
  const detailEnd = app.indexOf('function renderYearResult() {');
  const detailSource = app.slice(detailStart, detailEnd) + '\nrenderSelectedDate;';
  const renderDetail = runInNewContext(detailSource, context);
  renderDetail();
  const detailNames = elements.selectedFestivalList.children.map((item) => item.textContent);
  const expectedDetails = ['建党节', '香港回归纪念日'];
  assert.deepEqual(detailNames, expectedDetails);
  assert.equal(elements.selectedFestivalCount.textContent, '2 个');
  assert.equal(elements.selectedDateLabel.textContent, '2027-07-01');

  let onDateClick;
  elements.calendarGrid.addEventListener = (type, handler) => { onDateClick = handler; };
  elements.calendarGrid.querySelector = (selector) => {
    if (selector === '.day-cell.selected') {
      return elements.calendarGrid.children.find((button) => button.classes.has('selected'));
    }

    const dateKey = selector.match(/data-date="([^"]+)"/)?.[1];
    return elements.calendarGrid.children.find((button) => button.dataset.date === dateKey);
  };

  context.render = () => { render(); renderDetail(); };
  const clickStart = app.indexOf("elements.calendarGrid.addEventListener('click'");
  const clickEnd = app.indexOf("elements.calendarGrid.addEventListener('contextmenu'");
  const clickSource = app.slice(clickStart, clickEnd);
  runInNewContext(clickSource, context);
  const ordinary = elements.calendarGrid.children.find((button) => button.dataset.date === '2027-07-02');
  const event = { button: 0, target: { closest: () => ordinary } };
  onDateClick(event);
  assert.equal(elements.selectedFestivalCount.textContent, '0 个');
  assert.equal(elements.selectedFestivalList.children.length, 1);
  assert.equal(elements.selectedFestivalList.children[0].textContent, '当天没有节日');
  assert.equal(elements.selectedDateLabel.textContent, '2027-07-02');

  const nextMonth = elements.calendarGrid.children.find((button) => button.dataset.date === '2027-08-01');
  const crossMonthEvent = { button: 0, target: { closest: () => nextMonth } };
  onDateClick(crossMonthEvent);
  assert.equal(context.viewMonth, 8);
  assert.equal(elements.selectedDateLabel.textContent, '2027-08-01');
  assert.equal(elements.selectedFestivalList.children[0].textContent, '建军节');

  context.activeDateKey = '2027-02-15';
  renderDetail();
  assert.equal(elements.selectedFestivalCount.textContent, '1 个');
  assert.equal(elements.selectedFestivalList.children[0].textContent, '石头节');
  const briefNames = getFestivalNames('2027-02-15');
  assert.deepEqual(briefNames, []);
};

test('日历只显示优先节日，选中日期的侧栏展示完整清单并清除旧明细', testCalendarFestivalRendering);

const testSidebarDefaults = () => {
  const htmlUrl = new URL('../index.html', import.meta.url);
  const html = readFileSync(htmlUrl, 'utf8');
  const details = html.match(/<details\b[^>]*>/g) ?? [];
  const selected = details.find((tag) => tag.includes('id="selected-date-section"'));
  const current = details.find((tag) => tag.includes('id="year-holiday-section"'));
  const expired = details.find((tag) => tag.includes('id="expired-holiday-section"'));
  assert.ok(selected);
  assert.ok(current);
  assert.ok(expired);
  const selectedOpen = /\sopen(?:\s|=|>)/.test(selected);
  const currentOpen = /\sopen(?:\s|=|>)/.test(current);
  const expiredOpen = /\sopen(?:\s|=|>)/.test(expired);
  assert.equal(selectedOpen, true);
  assert.equal(currentOpen, true);
  assert.equal(expiredOpen, false);
};

test('侧栏各分区原生可折叠，过期假期默认关闭', testSidebarDefaults);
