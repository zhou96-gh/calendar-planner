import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createQuotaHolidays, prepareQuotaHolidays } from '../src/holiday/quota.js';
import { getFestivalDates, prepareFestivalDates } from '../src/holiday/festivals.js';
import { getYearLegalBreakdown, sanitizeSettings } from '../src/holiday/core.js';

const weekendRules = {
  5: { restPeriod: 'full', repeatIntervalWeeks: 0 },
  6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
};

const settings = sanitizeSettings({ weekendRules });

const testPrepareQuota = async () => {
  const first = prepareFestivalDates(2027);
  const concurrent = prepareFestivalDates(2027);
  assert.strictEqual(concurrent, first);
  let completed = false;
  first.then(() => { completed = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(completed, false);
  const dates = await first;
  assert.equal(dates['春节'], '2027-02-06');
  assert.equal(dates['除夕'], '2027-02-05');
  assert.equal(dates['清明节'], '2027-04-05');
  assert.equal(dates['端午节'], '2027-06-09');
  assert.equal(dates['中秋节'], '2027-09-15');
  const cachedDates = getFestivalDates(2027);
  assert.strictEqual(cachedDates, dates);
  const prepared = await prepareQuotaHolidays(2027, 2026, settings);
  const cachedQuota = createQuotaHolidays(2027, 2026, settings);
  assert.strictEqual(cachedQuota, prepared);
  const legalDays = Object.keys(prepared);
  assert.equal(legalDays.length, 13);
};

test('全年节日分批准备并共用同年任务，完成后额度计算直接命中缓存', testPrepareQuota);

const testSynchronousPreparation = async () => {
  const preparing = prepareFestivalDates(2032);
  const synchronous = getFestivalDates(2032);
  const prepared = await preparing;
  assert.strictEqual(prepared, synchronous);
};

test('准备期间前台同步计算完成时，后台复用完整结果并结束', testSynchronousPreparation);

const testCurrentYearQuotas = () => {
  const holidays = createQuotaHolidays(2027, 2026, settings);
  const dates = Object.keys(holidays);
  const spring = dates.filter((dateKey) => holidays[dateKey].name === '春节');
  const expectedSpring = ['2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10'];
  const breakdown = getYearLegalBreakdown(2027, settings, holidays);
  assert.equal(dates.length, 13);
  assert.deepEqual(spring, expectedSpring);
  assert.equal(breakdown.pure.length, 13);
  assert.ok(dates.every((dateKey) => dateKey.startsWith('2027-')));
  assert.ok(Object.values(holidays).every((day) => day.kind === 'legal'));
  assert.equal(holidays['2026-02-16'], undefined);
};

test('2027 年借用 2026 年法定额度，仍按本年节日分配且不生成调休补班', testCurrentYearQuotas);

const testOlderQuotas = () => {
  const holidays = createQuotaHolidays(2027, 2024, settings);
  const days = Object.values(holidays);
  const springDays = days.filter((day) => day.name === '春节').length;
  const laborDays = days.filter((day) => day.name === '劳动节').length;
  assert.equal(days.length, 11);
  assert.equal(springDays, 3);
  assert.equal(laborDays, 1);
  assert.equal(holidays['2027-02-05'], undefined);
};

test('额度使用已发布源年的既有规则，不采用未知年度的新增额度', testOlderQuotas);

const testOverlappingFestivals = () => {
  const holidays = createQuotaHolidays(2020, 2026, settings);
  const days = Object.values(holidays);
  const midAutumn = days.filter((day) => day.name === '中秋节').length;
  const national = days.filter((day) => day.name === '国庆节').length;
  assert.equal(days.length, 13);
  assert.equal(midAutumn, 1);
  assert.equal(national, 3);
};

test('节日重合时不重复占用同一天，春节除夕不重复累计额度', testOverlappingFestivals);

const testWeekendSettings = () => {
  const configured = {
    weekendRules: {
      5: { restPeriod: 'am', repeatIntervalWeeks: 0 },
      6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
    }
  };

  const partialSettings = sanitizeSettings(configured);
  const holidays = createQuotaHolidays(2027, 2026, partialSettings);
  assert.equal(holidays['2027-05-01'], undefined);
  assert.equal(holidays['2027-05-03'].name, '劳动节');
  assert.equal(holidays['2027-05-04'].name, '劳动节');
};

test('法定额度只分配全天工作日，半天周末不被拆分占用', testWeekendSettings);

const testRuntimeMerge = () => {
  const appUrl = new URL('../src/app.js', import.meta.url);
  const app = readFileSync(appUrl, 'utf8');
  const start = app.indexOf('function buildCalendarHolidays(holidays) {');
  const end = app.indexOf('function render(');
  const source = app.slice(start, end) + '\nbuildCalendarHolidays;';
  const yearQuotaSources = new Map();
  yearQuotaSources.set(2027, 2026);
  const context = { state: { settings }, yearQuotaSources, createQuotaHolidays };
  const merge = runInNewContext(source, context);
  const official = { '2027-02-05': { kind: 'work', name: '个人日期修正' } };
  const combined = merge(official);
  const breakdown = getYearLegalBreakdown(2027, settings, combined);
  const rawDates = Object.keys(official);
  const expectedRawDates = ['2027-02-05'];
  assert.equal(breakdown.pure.length, 12);
  assert.equal(combined['2027-02-05'].kind, 'work');
  assert.equal(combined['2027-02-08'].kind, 'legal');
  assert.deepEqual(rawDates, expectedRawDates);

  const withoutCorrection = {};
  const preview = merge(withoutCorrection);
  assert.equal(preview['2027-02-05'].kind, 'legal');
};

test('实际数据合并优先且不污染原数据，移除修正的预览与重新渲染一致', testRuntimeMerge);
