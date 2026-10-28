import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  buildMonthGrid,
  calculateAdjustmentDays,
  classifyDay,
  createCalendarCalculation,
  getAdjustmentSummary,
  getConsecutiveRestState,
  getMonthSummary,
  getWeekType,
  getYearLegalBreakdown,
  hasAdjustmentOverlap,
  mergeAssociatedAdjustment,
  pruneExpiredAdjustments,
  sanitizeAdjustmentRecords,
  sanitizeHolidays,
  sanitizeSettings,
  startOfWeek
} from '../src/holiday/core.js';
import { BUILT_IN_HOLIDAYS } from '../src/holiday/data.js';

const settings = sanitizeSettings(DEFAULT_SETTINGS);

const testSharedDayCalculation = () => {
  const adjustments = [{
    id: 'shared-rest',
    associationType: 'none',
    ranges: [{ type: 'rest', startDate: '2026-09-21', endDate: '2026-09-21', startPeriod: 'am', endPeriod: 'am' }]
  }];

  const calculation = createCalendarCalculation(settings, BUILT_IN_HOLIDAYS, adjustments);
  const dateKey = '2026-09-21';
  const first = calculation.classifyDay(dateKey);
  const expected = classifyDay(dateKey, settings, BUILT_IN_HOLIDAYS, adjustments);
  assert.deepEqual(first, expected);
  assert.equal(first.restAmount, 0.5);
  const expectedSummary = getMonthSummary(2026, 9, settings, BUILT_IN_HOLIDAYS, adjustments);
  const summary = calculation.getMonthSummary(2026, 9);
  assert.deepEqual(summary, expectedSummary);

  buildMonthGrid(2026, 9).forEach((key) => {
    const day = calculation.classifyDay(key);
    const expectedDay = classifyDay(key, settings, BUILT_IN_HOLIDAYS, adjustments);
    const consecutive = calculation.getConsecutiveRestState(key);
    const expectedConsecutive = getConsecutiveRestState(key, settings, BUILT_IN_HOLIDAYS, adjustments);
    assert.deepEqual(day, expectedDay);
    assert.deepEqual(consecutive, expectedConsecutive);
  });

  const repeated = calculation.classifyDay(dateKey);
  assert.strictEqual(repeated, first);
};

test('同一渲染共用日期结果，月统计和跨月连休保持原有半天及调班规则', testSharedDayCalculation);

const testFreshCalculation = () => {
  const configured = sanitizeSettings(DEFAULT_SETTINGS);
  const holidays = {};
  const adjustments = [];
  const first = createCalendarCalculation(configured, holidays, adjustments);
  const original = first.classifyDay('2026-09-26');
  assert.equal(original.restAmount, 0);
  configured.weekendRules[5].repeatIntervalWeeks = 0;
  const changedSettings = createCalendarCalculation(configured, holidays, adjustments);
  const weekend = changedSettings.classifyDay('2026-09-26');
  assert.equal(weekend.restAmount, 1);

  holidays['2026-09-21'] = { kind: 'legal', name: '日期修正' };
  const changedHoliday = createCalendarCalculation(configured, holidays, adjustments);
  const holiday = changedHoliday.classifyDay('2026-09-21');
  assert.equal(holiday.pureLegalAmount, 1);
  delete holidays['2026-09-21'];
  adjustments.push({
    id: 'new-rest',
    associationType: 'none',
    ranges: [{ type: 'rest', startDate: '2026-09-21', endDate: '2026-09-21', startPeriod: 'pm', endPeriod: 'pm' }]
  });

  const changedAdjustment = createCalendarCalculation(configured, holidays, adjustments);
  const adjusted = changedAdjustment.classifyDay('2026-09-21');
  const official = getYearLegalBreakdown(2026, configured, holidays);
  assert.equal(adjusted.restAmount, 0.5);
  assert.equal(official.pure.length, 0);
};

test('原地修改规则、日期安排和调班后，新渲染不复用旧缓存且年度明细不混入个人调班', testFreshCalculation);

test('锚点日期会归一化到周一', () => {
  assert.equal(startOfWeek('2026-09-20'), '2026-09-14');
});

test('月历默认从周日开始并支持切换起始日', () => {
  assert.equal(buildMonthGrid(2026, 9)[0], '2026-08-30');
  assert.equal(buildMonthGrid(2026, 9, 0)[0], '2026-08-31');
});

test('默认大小休按周六间隔规则交替且支持起始周之前的日期', () => {
  assert.equal(getWeekType('2026-09-14', settings), 'big');
  assert.equal(getWeekType('2026-09-21', settings), 'small');
  assert.equal(getWeekType('2026-09-07', settings), 'small');
});

test('大休周六休息，小休周六上班', () => {
  assert.equal(classifyDay('2026-09-19', settings, {}).category, 'schedule-rest');
  assert.equal(classifyDay('2026-09-26', settings, {}).category, 'regular-work');
});

test('周六周日可分别配置半天和重复间隔', () => {
  const customSettings = sanitizeSettings({
    ...DEFAULT_SETTINGS,
    weekendRules: {
      5: { restPeriod: 'am', repeatIntervalWeeks: 1 },
      6: { restPeriod: 'pm', repeatIntervalWeeks: 0 }
    }
  });
  const activeSaturday = classifyDay('2026-09-19', customSettings, {});
  assert.equal(activeSaturday.restAmount, 0.5);
  assert.equal(activeSaturday.periods.am.category, 'schedule-rest');
  assert.equal(activeSaturday.periods.pm.category, 'regular-work');
  assert.equal(classifyDay('2026-09-26', customSettings, {}).restAmount, 0);
  assert.equal(classifyDay('2026-09-27', customSettings, {}).restAmount, 0.5);
});

test('连休只标识最终状态下连续三天及以上的全天休息', () => {
  const doubleRestSettings = sanitizeSettings({
    ...DEFAULT_SETTINGS,
    weekendRules: {
      5: { restPeriod: 'full', repeatIntervalWeeks: 0 },
      6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
    }
  });
  assert.deepEqual(getConsecutiveRestState('2026-09-19', doubleRestSettings, {}), {
    isConsecutive: false,
    hasPrevious: false,
    hasNext: false
  });

  const threeDayHolidays = {
    '2026-09-18': { kind: 'legal', name: '测试假期' }
  };
  assert.deepEqual(getConsecutiveRestState('2026-09-18', doubleRestSettings, threeDayHolidays), {
    isConsecutive: true,
    hasPrevious: false,
    hasNext: true
  });
  assert.deepEqual(getConsecutiveRestState('2026-09-19', doubleRestSettings, threeDayHolidays), {
    isConsecutive: true,
    hasPrevious: true,
    hasNext: true
  });
  assert.deepEqual(getConsecutiveRestState('2026-09-20', doubleRestSettings, threeDayHolidays), {
    isConsecutive: true,
    hasPrevious: true,
    hasNext: false
  });
  assert.deepEqual(getConsecutiveRestState('2026-09-27', settings, {}), {
    isConsecutive: false,
    hasPrevious: false,
    hasNext: false
  });

  const manualWork = [{
    type: 'work',
    startDate: '2026-09-20',
    startPeriod: 'am',
    endDate: '2026-09-20',
    endPeriod: 'pm'
  }];
  assert.deepEqual(getConsecutiveRestState(
    '2026-09-19',
    doubleRestSettings,
    threeDayHolidays,
    manualWork
  ), {
    isConsecutive: false,
    hasPrevious: false,
    hasNext: false
  });
});

test('旧版大小休设置会迁移为周六周日独立规则', () => {
  const migrated = sanitizeSettings({
    anchorMonday: '2026-09-14',
    anchorWeekType: 'big',
    bigRestDays: [5, 6],
    smallRestDays: [6]
  });
  assert.deepEqual(migrated.weekendRules, {
    5: { restPeriod: 'full', repeatIntervalWeeks: 1 },
    6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
  });
});

test('纯假期作为标签并将原工作结果改为休息', () => {
  const holidays = { '2026-09-25': { kind: 'legal', name: '中秋节' } };
  const result = classifyDay('2026-09-25', settings, holidays);
  assert.equal(result.isPureLegal, true);
  assert.equal(result.category, 'schedule-rest');
  assert.equal(result.isRest, true);
  assert.deepEqual(result.officialLabels, ['放假']);
});

test('手工维护的纯假期按整天显示且不拆分半天', () => {
  const holidays = { '2026-09-27': { kind: 'legal', name: '示例假日' } };
  const result = classifyDay('2026-09-27', settings, holidays);
  assert.equal(result.category, 'schedule-rest');
  assert.equal(result.holiday.name, '示例假日');
  assert.equal(result.pureLegalAmount, 1);
  assert.equal(result.isPureLegal, true);
});

test('调休不计入放假', () => {
  const holidays = { '2026-09-24': { kind: 'off', name: '调休' } };
  const result = classifyDay('2026-09-24', settings, holidays);
  assert.equal(result.category, 'regular-work');
  assert.deepEqual(result.officialLabels, ['法定调休']);
  assert.equal(result.isPureLegal, false);
});

test('法定补班只作为标签且不覆盖原休息结果', () => {
  const holidays = { '2026-09-20': { kind: 'work', name: '法定补班' } };
  const result = classifyDay('2026-09-20', settings, holidays);
  assert.equal(result.category, 'schedule-rest');
  assert.equal(result.visualCategory, 'schedule-rest');
  assert.deepEqual(result.officialLabels, ['法定补班']);
  assert.equal(result.isRest, true);
});

test('人工调休和补班覆盖日历最终半天结果', () => {
  const adjustments = [
    {
      id: 'rest-pm',
      type: 'rest',
      startDate: '2026-09-14',
      startPeriod: 'pm',
      endDate: '2026-09-14',
      endPeriod: 'pm'
    },
    {
      id: 'work-am',
      type: 'work',
      startDate: '2026-09-20',
      startPeriod: 'am',
      endDate: '2026-09-20',
      endPeriod: 'am'
    }
  ];
  const weekday = classifyDay('2026-09-14', settings, {}, adjustments);
  assert.equal(weekday.periods.am.category, 'regular-work');
  assert.equal(weekday.periods.pm.category, 'manual-rest');
  assert.equal(weekday.periods.pm.manualAdjustmentId, 'rest-pm');
  assert.equal(weekday.restAmount, 0.5);

  const weekend = classifyDay('2026-09-20', settings, {}, adjustments);
  assert.equal(weekend.periods.am.category, 'manual-work');
  assert.equal(weekend.periods.pm.category, 'schedule-rest');
  assert.equal(weekend.periods.am.manualAdjustmentId, 'work-am');
  assert.equal(weekend.restAmount, 0.5);
});

test('人工处理不移除放假和法定补班来源标签', () => {
  const restHoliday = classifyDay(
    '2026-09-25',
    settings,
    { '2026-09-25': { kind: 'legal', name: '中秋节' } },
    [{ type: 'work', startDate: '2026-09-25', startPeriod: 'am', endDate: '2026-09-25', endPeriod: 'am' }]
  );
  assert.deepEqual(restHoliday.officialLabels, ['放假']);
  assert.equal(restHoliday.periods.am.category, 'manual-work');

  const officialWork = classifyDay(
    '2026-09-20',
    settings,
    { '2026-09-20': { kind: 'work', name: '法定补班' } },
    [{ type: 'work', startDate: '2026-09-20', startPeriod: 'pm', endDate: '2026-09-20', endPeriod: 'pm' }]
  );
  assert.deepEqual(officialWork.officialLabels, ['法定补班']);
  assert.equal(officialWork.periods.pm.category, 'manual-work');
});

test('官方建议不影响人工调休和补班的可计算时段', () => {
  const holidays = {
    '2026-09-18': { kind: 'off', name: '法定调休' },
    '2026-09-20': { kind: 'work', name: '法定补班' }
  };
  assert.equal(calculateAdjustmentDays({
    type: 'rest', startDate: '2026-09-18', startPeriod: 'am', endDate: '2026-09-18', endPeriod: 'pm'
  }, settings, holidays), 1);
  assert.equal(calculateAdjustmentDays({
    type: 'work', startDate: '2026-09-20', startPeriod: 'am', endDate: '2026-09-20', endPeriod: 'pm'
  }, settings, holidays), 1);
});

test('纯假期参与人工补班的可计算时段', () => {
  const holidays = { '2026-09-18': { kind: 'legal', name: '示例假期' } };
  assert.equal(calculateAdjustmentDays({
    type: 'work', startDate: '2026-09-18', startPeriod: 'am', endDate: '2026-09-18', endPeriod: 'pm'
  }, settings, holidays), 1);
  assert.equal(calculateAdjustmentDays({
    type: 'rest', startDate: '2026-09-18', startPeriod: 'am', endDate: '2026-09-18', endPeriod: 'pm'
  }, settings, holidays), 0);
});

test('月休息统计使用人工处理后的最终结果', () => {
  const adjustments = [{
    type: 'rest',
    startDate: '2026-09-14',
    startPeriod: 'am',
    endDate: '2026-09-14',
    endPeriod: 'am'
  }];
  const baseline = getMonthSummary(2026, 9, settings, {});
  const resolved = getMonthSummary(2026, 9, settings, {}, adjustments);
  assert.equal(resolved.totalRest, baseline.totalRest + 0.5);
});

test('月统计按半天汇总放假与法定补班', () => {
  const holidays = {
    '2026-09-20': { kind: 'work', name: '法定补班' },
    '2026-09-25': { kind: 'legal', name: '中秋节' },
    '2026-09-26': { kind: 'off', name: '中秋连休' },
    '2026-09-27': { kind: 'off', name: '中秋连休' }
  };
  const summary = getMonthSummary(2026, 9, settings, holidays);
  assert.equal(summary.pureLegal, 1);
  assert.equal(summary.adjustedWork, 1);
});

test('导入数据会剔除无效日期和类型', () => {
  const result = sanitizeHolidays({
    '2026-01-01': { kind: 'legal', name: '元旦' },
    '2026-13-40': { kind: 'legal', name: '错误日期' },
    '2026-01-02': { kind: 'unknown', name: '错误类型' }
  });
  assert.deepEqual(result, { '2026-01-01': { kind: 'legal', name: '元旦' } });
});

test('旧版调休名称会自动迁移', () => {
  const result = sanitizeHolidays({
    '2026-01-03': { kind: 'off', name: '元旦补假' },
    '2026-01-04': { kind: 'work', name: '元旦调休上班' },
    '2026-01-05': { kind: 'work', name: '元旦法定调休' }
  });
  assert.deepEqual(result, {
    '2026-01-03': { kind: 'off', name: '元旦调休' },
    '2026-01-04': { kind: 'work', name: '元旦法定补班' },
    '2026-01-05': { kind: 'work', name: '元旦法定补班' }
  });
});

test('调休只累计范围内正常上班的半天', () => {
  const record = {
    type: 'rest',
    startDate: '2026-09-18',
    startPeriod: 'pm',
    endDate: '2026-09-20',
    endPeriod: 'pm'
  };
  assert.equal(calculateAdjustmentDays(record, settings, {}), 0.5);
});

test('补班只累计范围内原本休息的半天', () => {
  const record = {
    type: 'work',
    startDate: '2026-09-18',
    startPeriod: 'pm',
    endDate: '2026-09-20',
    endPeriod: 'pm'
  };
  assert.equal(calculateAdjustmentDays(record, settings, {}), 2);
});

test('同一天支持上午或下午 0.5 天粒度并拒绝倒序范围', () => {
  const record = {
    type: 'rest',
    startDate: '2026-09-14',
    startPeriod: 'am',
    endDate: '2026-09-14',
    endPeriod: 'am'
  };
  assert.equal(calculateAdjustmentDays(record, settings, {}), 0.5);
  record.endPeriod = 'pm';
  assert.equal(calculateAdjustmentDays(record, settings, {}), 1);
  record.startPeriod = 'pm';
  record.endPeriod = 'am';
  assert.equal(calculateAdjustmentDays(record, settings, {}), 0);
});

test('已调班的有效半天不允许重复调班且编辑时排除自身', () => {
  const existing = [{
    id: 'rest-1',
    type: 'rest',
    startDate: '2026-09-14',
    startPeriod: 'am',
    endDate: '2026-09-14',
    endPeriod: 'am'
  }];
  assert.equal(hasAdjustmentOverlap({
    id: '',
    type: 'rest',
    startDate: '2026-09-14',
    startPeriod: 'am',
    endDate: '2026-09-14',
    endPeriod: 'pm'
  }, existing, settings, {}), true);
  assert.equal(hasAdjustmentOverlap({
    id: '',
    type: 'rest',
    startDate: '2026-09-14',
    startPeriod: 'pm',
    endDate: '2026-09-14',
    endPeriod: 'pm'
  }, existing, settings, {}), false);
  assert.equal(hasAdjustmentOverlap({
    ...existing[0],
    endPeriod: 'pm'
  }, existing, settings, {}), false);
});

test('记录范围内未实际调班的时段仍可使用', () => {
  const existing = [{
    id: 'rest-1',
    type: 'rest',
    startDate: '2026-09-18',
    startPeriod: 'pm',
    endDate: '2026-09-20',
    endPeriod: 'pm'
  }];
  const weekendWork = {
    id: '',
    type: 'work',
    startDate: '2026-09-20',
    startPeriod: 'am',
    endDate: '2026-09-20',
    endPeriod: 'am'
  };
  assert.equal(hasAdjustmentOverlap(weekendWork, existing, settings, {}), false);
});

test('只有关联类型为需要的调班参与余额互抵', () => {
  const rest = { type: 'rest', startDate: '2026-09-14', startPeriod: 'am',
    endDate: '2026-09-14', endPeriod: 'pm' };
  const work = { type: 'work', startDate: '2026-09-20', startPeriod: 'am',
    endDate: '2026-09-20', endPeriod: 'am' };
  const records = [
    { associationType: 'required', ranges: [rest] },
    { associationType: 'required', ranges: [work] },
    { associationType: 'none', ranges: [rest] },
    { associationType: 'none', ranges: [work] }
  ];
  assert.deepEqual(getAdjustmentSummary(records, settings, {}), {
    restTotal: 2, workTotal: 1, restRemaining: 0.5, workRemaining: 0
  });
  assert.deepEqual(getAdjustmentSummary(records.slice(2), settings, {}), {
    restTotal: 1, workTotal: 0.5, restRemaining: 0, workRemaining: 0
  });
});

test('新调班结构剔除无效范围且不迁移旧单段记录', () => {
  const result = sanitizeAdjustmentRecords([{
    id: 'new', associationType: 'required', ranges: [
      { type: 'work', startDate: '2026-09-20', startPeriod: 'pm',
        endDate: '2026-09-20', endPeriod: 'pm' },
      { type: 'rest', startDate: '2026-09-15', startPeriod: 'pm',
        endDate: '2026-09-15', endPeriod: 'am' }
    ], note: '项目支持', createdAt: 100
  }, {
    id: 'old', type: 'rest', startDate: '2026-09-14', startPeriod: 'am',
    endDate: '2026-09-14', endPeriod: 'pm'
  }]);
  assert.deepEqual(result, [{
    id: 'new', associationType: 'required', ranges: [{ type: 'work',
      startDate: '2026-09-20', startPeriod: 'pm', endDate: '2026-09-20', endPeriod: 'pm' }],
    note: '项目支持', createdAt: 100
  }]);
});

test('通用调班记录同时存多段调休和补班并按半天分类', () => {
  const operation = sanitizeAdjustmentRecords([{
    id: 'paired', associationType: 'required', note: '联动', createdAt: 100,
    ranges: [
      { type: 'rest', startDate: '2026-09-14', startPeriod: 'am', endDate: '2026-09-14', endPeriod: 'am' },
      { type: 'rest', startDate: '2026-09-15', startPeriod: 'pm', endDate: '2026-09-15', endPeriod: 'pm' },
      { type: 'work', startDate: '2026-09-20', startPeriod: 'am', endDate: '2026-09-20', endPeriod: 'am' }
    ]
  }])[0];
  assert.equal(operation.ranges.length, 3);
  assert.equal(calculateAdjustmentDays(operation, settings, {}), 1.5);
  assert.deepEqual(getAdjustmentSummary([operation], settings, {}), {
    restTotal: 1, workTotal: 0.5, restRemaining: 0.5, workRemaining: 0
  });
  assert.equal(classifyDay('2026-09-14', settings, {}, [operation]).periods.am.manualAdjustmentId, 'paired');
  assert.equal(classifyDay('2026-09-20', settings, {}, [operation]).periods.am.manualAdjustment, 'work');
  assert.equal(sanitizeAdjustmentRecords([{ associationType: 'required', ranges: [operation.ranges[0]] }])[0]
    .associationType, 'required');
});

test('同次调班连续调休范围合成一条，补班仍独立展示', () => {
  const operation = { id: 'paired', associationType: 'required', note: '联动', createdAt: 100,
    ranges: [
      { type: 'rest', startDate: '2026-09-28', startPeriod: 'am',
        endDate: '2026-09-29', endPeriod: 'am' },
      { type: 'work', startDate: '2026-09-19', startPeriod: 'am',
        endDate: '2026-09-20', endPeriod: 'pm' },
      { type: 'rest', startDate: '2026-09-29', startPeriod: 'pm',
        endDate: '2026-09-30', endPeriod: 'pm' }
    ] };
  const [normalized] = sanitizeAdjustmentRecords([operation]);
  assert.deepEqual(normalized.ranges, [
    { type: 'rest', startDate: '2026-09-28', startPeriod: 'am',
      endDate: '2026-09-30', endPeriod: 'pm' },
    operation.ranges[1]
  ]);
  assert.deepEqual(getAdjustmentSummary([normalized], settings, {}), {
    restTotal: 3, workTotal: 2, restRemaining: 1, workRemaining: 0
  });
  assert.equal(classifyDay('2026-09-29', settings, {}, [normalized]).periods.pm.manualAdjustment, 'rest');
  assert.equal(sanitizeAdjustmentRecords([{ ...operation, ranges: [
    operation.ranges[0], { ...operation.ranges[2], startDate: '2026-10-01', endDate: '2026-10-01' }
  ] }])[0].ranges.length, 2);
});

test('通用调班不允许内部重叠，编辑自身不冲突', () => {
  const first = { type: 'rest', startDate: '2026-09-14', startPeriod: 'am',
    endDate: '2026-09-14', endPeriod: 'pm' };
  const operation = { id: 'same', associationType: 'required', ranges: [first,
    { ...first, startPeriod: 'pm' }] };
  assert.equal(hasAdjustmentOverlap(operation, [operation], settings, {}), true);
  operation.ranges.pop();
  assert.equal(hasAdjustmentOverlap(operation, [operation], settings, {}), false);
});

test('关联日期占用已有范围时仅并入所选半天，其余自动分段保留', () => {
  const old = { id: 'old', associationType: 'none', note: '原记录', createdAt: 10,
    ranges: [{ type: 'rest', startDate: '2026-09-14', startPeriod: 'am',
      endDate: '2026-09-18', endPeriod: 'pm' }] };
  const selected = { id: 'new', associationType: 'required', ranges: [
    { type: 'rest', startDate: '2026-09-16', startPeriod: 'am',
      endDate: '2026-09-17', endPeriod: 'pm' }
  ] };
  const merged = mergeAssociatedAdjustment(selected, [old], settings, {});
  assert.deepEqual(merged.mergedIds, ['old']);
  assert.deepEqual(merged.remaining.map((item) => item.ranges[0]), [
    { type: 'rest', startDate: '2026-09-14', startPeriod: 'am',
      endDate: '2026-09-15', endPeriod: 'pm' },
    { type: 'rest', startDate: '2026-09-18', startPeriod: 'am',
      endDate: '2026-09-18', endPeriod: 'pm' }
  ]);
  assert.equal(getAdjustmentSummary([selected, ...merged.remaining], settings, {}).restTotal, 5);
  assert.equal(mergeAssociatedAdjustment({ id: 'none', ranges: [
    { type: 'work', startDate: '2026-09-20', startPeriod: 'am',
      endDate: '2026-09-20', endPeriod: 'am' }
  ] }, [old], settings, {}).mergedIds.length, 0);
});

test('过期清理按整次操作执行，仍有今天或未来日期则保留', () => {
  const record = (id, ranges) => ({ id, associationType: 'required', ranges });
  const range = (date) => ({ type: 'rest', startDate: date, startPeriod: 'am',
    endDate: date, endPeriod: 'pm' });
  const records = [
    record('old', [range('2026-09-14')]),
    record('mixed', [range('2026-09-14'), range('2026-09-15')]),
    record('future', [range('2026-09-16')])
  ];
  assert.deepEqual(pruneExpiredAdjustments(records, '2026-09-15').map((item) => item.id),
    ['mixed', 'future']);
  assert.deepEqual(pruneExpiredAdjustments(records, '2026-09-17'), []);
});

test('内置 2026 数据包含 13 天法定额度和 6 个法定补班日', () => {
  const records = Object.values(BUILT_IN_HOLIDAYS);
  const blocks = [...new Map(
    records
      .filter((record) => record.kind === 'block')
      .map((record) => [record.startDay, record])
  ).values()];
  assert.equal(blocks.reduce((total, block) => total + block.legalDays, 0), 13);
  assert.equal(records.filter((record) => record.kind === 'work').length, 6);
});

test('内置安排保留 13 天放假', () => {
  const breakdown = getYearLegalBreakdown(2026, settings, BUILT_IN_HOLIDAYS);
  assert.equal(breakdown.pure.reduce((total, item) => total + item.days, 0), 13);
});

test('右侧纯假期明细只保留整天日期', () => {
  const partialWeekendSettings = sanitizeSettings({
    ...DEFAULT_SETTINGS,
    weekendRules: {
      5: { restPeriod: 'am', repeatIntervalWeeks: 0 },
      6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
    }
  });
  const breakdown = getYearLegalBreakdown(2026, partialWeekendSettings, BUILT_IN_HOLIDAYS);
  const nationalDayItems = breakdown.pure.filter((item) => item.name === '国庆节');
  assert.deepEqual(
    nationalDayItems.map(({ dateKey, days, period }) => ({ dateKey, days, period })),
    [
      { dateKey: '2026-10-01', days: 1, period: 'full' },
      { dateKey: '2026-10-02', days: 1, period: 'full' },
      { dateKey: '2026-10-05', days: 1, period: 'full' }
    ]
  );
  const octoberThird = classifyDay('2026-10-03', partialWeekendSettings, BUILT_IN_HOLIDAYS);
  assert.deepEqual(octoberThird.officialLabels, []);
  assert.equal(octoberThird.periods.am.sourceCategory, 'schedule-rest');
  assert.equal(octoberThird.periods.pm.sourceCategory, 'makeup-off');
  assert.equal(octoberThird.periods.am.category, 'schedule-rest');
  assert.equal(octoberThird.periods.pm.category, 'regular-work');
  assert.equal(octoberThird.restAmount, 0.5);

  const octoberFifth = classifyDay('2026-10-05', partialWeekendSettings, BUILT_IN_HOLIDAYS);
  assert.deepEqual(octoberFifth.officialLabels, ['放假']);
  assert.equal(octoberFifth.pureLegalAmount, 1);
  assert.equal(octoberFifth.restAmount, 1);

  const octoberTenth = classifyDay('2026-10-10', partialWeekendSettings, BUILT_IN_HOLIDAYS);
  assert.deepEqual(octoberTenth.officialLabels, ['法定补班']);
  assert.equal(octoberTenth.periods.am.category, 'schedule-rest');
  assert.equal(octoberTenth.periods.pm.category, 'regular-work');
});

test('国庆节纯假期改变实际结果，全天推荐显示法定调休标签', () => {
  const holiday = classifyDay('2026-10-05', settings, BUILT_IN_HOLIDAYS);
  assert.equal(holiday.category, 'schedule-rest');
  assert.deepEqual(holiday.officialLabels, ['放假']);
  assert.equal(classifyDay('2026-10-03', settings, BUILT_IN_HOLIDAYS).category, 'schedule-rest');
  const suggestedRest = classifyDay('2026-10-06', settings, BUILT_IN_HOLIDAYS);
  assert.equal(suggestedRest.category, 'regular-work');
  assert.deepEqual(suggestedRest.officialLabels, ['法定调休']);
});

test('节假日区间内的小休周六仍按上班显示', () => {
  const result = classifyDay('2026-09-26', settings, BUILT_IN_HOLIDAYS);
  assert.equal(result.weekType, 'small');
  assert.equal(result.category, 'regular-work');
  assert.equal(result.isRest, false);
});
