import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, addDays, calculateAdjustmentDays, classifyDay, hasAdjustmentOverlap, sanitizeSettings
} from '../src/holiday/core.js';
import { getVacationAdjustmentLimit, recommendVacations } from '../src/holiday/recommendations.js';
import { createQuotaHolidays } from '../src/holiday/quota.js';
import { decodeState, encodeState } from '../src/holiday/storage.js';
import { decodeDesktopState, encodeDesktopState, sanitizeDesktop } from '../src/platforms/desktop-state.js';

const settings = sanitizeSettings({
  weekendRules: {
    5: { restPeriod: 'full', repeatIntervalWeeks: 0 },
    6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
  }
});

/**
 * 只生成纯内存排班，不访问宿主、网络或数据库。
 */
function fixture(overrides = {}) {
  return { dateKey: '2026-10-14', settings,
    holidays: { '2026-10-14': { kind: 'legal', name: '测试假期' } },
    adjustments: [], maximum: 4, ...overrides };
}

function record(ranges) {
  return { id: 'existing', associationType: 'required', note: '', createdAt: 1, ranges };
}

function range(type, dateKey, period = 'full') {
  const startPeriod = period === 'pm' ? 'pm' : 'am';
  const endPeriod = period === 'am' ? 'am' : 'pm';
  return { type, startDate: dateKey, startPeriod, endDate: dateKey, endPeriod };
}

function assertWorkMonthScope(options, plan) {
  const balances = new Map();

  plan.ranges.forEach((item) => {
    for (let dateKey = item.startDate; dateKey <= item.endDate; dateKey = addDays(dateKey, 1)) {
      const startPeriod = dateKey === item.startDate ? item.startPeriod : 'am';
      const endPeriod = dateKey === item.endDate ? item.endPeriod : 'pm';
      const single = { ...item, startDate: dateKey, endDate: dateKey, startPeriod, endPeriod };
      let amount = calculateAdjustmentDays(single, options.settings, options.holidays);

      if (item.type === 'work') amount = -amount;

      const month = dateKey.slice(0, 7);
      const balance = (balances.get(month) ?? 0) + amount;
      balances.set(month, balance);
    }
  });

  const foreign = [...balances].filter(([, amount]) => amount !== 0);

  if (!options.allowCrossMonth) {
    assert.equal(foreign.length, 0);
    return;
  }

  if (!foreign.length) return;

  assert.equal(foreign.length, 2);
  const indices = foreign.map(([month]) => {
    const [year, value] = month.split('-').map(Number);
    return year * 12 + value;
  });

  const distance = Math.abs(indices[0] - indices[1]);
  const balance = foreign[0][1] + foreign[1][1];
  assert.equal(distance, 1);
  assert.equal(balance, 0);
}

/**
 * 独立按最终日期状态核对连续上班，包含前后月份。
 */
function longestWorkingRun(options, ranges) {
  const extra = record(ranges);
  const adjustments = [...options.adjustments, extra];
  let streak = 0;
  let maximum = 0;

  for (let dateKey = '2026-08-01'; dateKey <= '2026-12-31'; dateKey = addDays(dateKey, 1)) {
    const day = classifyDay(dateKey, options.settings, options.holidays, adjustments);

    for (const period of ['am', 'pm']) {
      const nextStreak = streak + 0.5;
      streak = day.periods[period].isRest ? 0 : nextStreak;
      maximum = Math.max(maximum, streak);
    }
  }

  return maximum;
}

const testSettings = () => {
  const defaults = sanitizeSettings();
  assert.equal(DEFAULT_SETTINGS.monthlyMaxAdjustmentDays, 4);
  assert.equal(defaults.allowCrossMonthAdjustment, false);

  for (const invalid of [-1, 32, 0.1, '4', null]) {
    const normalized = sanitizeSettings({ monthlyMaxAdjustmentDays: invalid });
    assert.equal(normalized.monthlyMaxAdjustmentDays, 4);
  }

  const custom = sanitizeSettings({ monthlyMaxAdjustmentDays: 2.5, allowCrossMonthAdjustment: true });
  const calendar = encodeState({ settings: custom, holidays: {}, loadedYears: [], adjustments: [] });
  const extension = sanitizeDesktop();
  const schemes = new Map();
  const desktop = encodeDesktopState(calendar, extension, schemes);
  const restored = decodeDesktopState(desktop);
  const restoredState = decodeState(restored.calendar);
  assert.deepEqual(restoredState.settings, custom);
  delete desktop.settings.monthlyMaxAdjustmentDays;
  delete desktop.settings.allowCrossMonthAdjustment;
  const previous = decodeDesktopState(desktop);
  const previousState = decodeState(previous.calendar);
  assert.equal(previousState.settings.monthlyMaxAdjustmentDays, 4);
  assert.equal(previousState.settings.allowCrossMonthAdjustment, false);
};

const testRecommendationPlans = () => {
  const options = fixture();
  const original = structuredClone(options);
  const plans = recommendVacations(options);
  const ids = plans.map((plan) => plan.id);
  const expectedIds = ['earliest', 'longest', 'shortest-work'];
  assert.deepEqual(ids, expectedIds);

  for (const plan of plans) {
    assert.equal(plan.unavailable, undefined);
    assert.ok(plan.adjustmentDays <= 4);
    const rest = plan.ranges.filter((item) => item.type === 'rest');
    const work = plan.ranges.filter((item) => item.type === 'work');
    const restRecord = record(rest);
    const workRecord = record(work);
    const combined = record(plan.ranges);
    const restDays = calculateAdjustmentDays(restRecord, settings, options.holidays);
    const workDays = calculateAdjustmentDays(workRecord, settings, options.holidays);
    const emptyRecords = [];
    const overlapping = hasAdjustmentOverlap(combined, emptyRecords, settings, options.holidays);
    assert.equal(restDays, plan.adjustmentDays);
    assert.equal(workDays, plan.adjustmentDays);
    assert.equal(overlapping, false);

    for (const item of work) {
      assert.ok(item.startDate.startsWith('2026-10-'));
      assert.ok(item.endDate.startsWith('2026-10-'));
    }

    const finalAdjustments = [combined];

    for (let dateKey = plan.vacation.startDate; dateKey <= plan.vacation.endDate; dateKey = addDays(dateKey, 1)) {
      const day = classifyDay(dateKey, settings, options.holidays, finalAdjustments);

      if (dateKey !== plan.vacation.startDate || plan.vacation.startPeriod === 'am') assert.ok(day.periods.am.isRest);

      if (dateKey !== plan.vacation.endDate || plan.vacation.endPeriod === 'pm') assert.ok(day.periods.pm.isRest);
    }

    const longestWork = longestWorkingRun(options, plan.ranges);
    assert.equal(plan.longestWorkDays, longestWork);
  }

  assert.ok(plans[0].vacation.startDate <= plans[1].vacation.startDate);
  assert.ok(plans[1].vacationDays >= plans[0].vacationDays);
  assert.ok(plans[2].longestWorkDays <= plans[0].longestWorkDays);
  assert.ok(plans[2].longestWorkDays <= plans[1].longestWorkDays);
  assert.deepEqual(options, original);
};

const testExistingAdjustments = () => {
  const existing = range('rest', '2026-10-02');
  const options = fixture({ maximum: 1.5, adjustments: [record([existing])] });
  const plans = recommendVacations(options);

  for (const plan of plans) {
    assert.ok(plan.adjustmentDays <= options.maximum);
    const proposed = { ...record(plan.ranges), id: 'new' };
    const overlapping = hasAdjustmentOverlap(proposed, options.adjustments, settings, options.holidays);
    assert.equal(overlapping, false);
    const finalAdjustments = [...options.adjustments, proposed];
    const legal = classifyDay(options.dateKey, settings, options.holidays, finalAdjustments);
    assert.equal(legal.restAmount, 1);
  }

  assert.ok(plans.slice(0, 2).every((plan) => plan.adjustmentDays === 1.5));
  const additional = fixture({ maximum: 1, adjustments: options.adjustments });
  const additionalPlans = recommendVacations(additional);
  assert.ok(additionalPlans.slice(0, 2).every((plan) => plan.adjustmentDays === 1));
};

const testCrossMonth = () => {
  const options = fixture({ dateKey: '2027-01-01', maximum: 1,
    holidays: { '2027-01-01': { kind: 'legal', name: '元旦' } } });
  const sameMonth = recommendVacations(options);
  assert.equal(sameMonth[0].vacation.startDate, '2026-12-31');

  for (const plan of sameMonth) assertWorkMonthScope(options, plan);

  const priorMonthWork = sameMonth[0].ranges.filter((item) => item.type === 'work');
  assert.ok(priorMonthWork.every((item) => item.startDate.startsWith('2026-12')));

  const crossOptions = { ...options, allowCrossMonth: true };
  const crossMonth = recommendVacations(crossOptions);

  for (const plan of crossMonth) {
    assertWorkMonthScope(crossOptions, plan);
    const totals = { rest: 0, work: 0 };

    for (const item of plan.ranges) {
      const days = calculateAdjustmentDays(item, settings, options.holidays);
      totals[item.type] += days;
    }

    assert.equal(totals.rest, totals.work);
    assert.ok(totals.rest <= options.maximum);
  }
};

const testHalfDays = () => {
  const halfSettings = sanitizeSettings({ weekendRules: {
    5: { restPeriod: 'am', repeatIntervalWeeks: 0 },
    6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
  } });
  const options = fixture({ settings: halfSettings, maximum: 0.5 });
  const plans = recommendVacations(options);

  for (const plan of plans) {
    assert.equal(plan.adjustmentDays, 0.5);
    const proposed = record(plan.ranges);
    const emptyRecords = [];
    const overlapping = hasAdjustmentOverlap(proposed, emptyRecords, halfSettings, options.holidays);
    assert.equal(overlapping, false);
  }

  const zero = fixture({ maximum: 0 });
  const zeroPlans = recommendVacations(zero);
  assert.ok(zeroPlans.every((plan) => plan.ranges.length === 0));
};

const testScatteredLegalDates = () => {
  const holidays = {
    '2026-10-01': { kind: 'legal', name: '国庆节' },
    '2026-10-02': { kind: 'legal', name: '国庆节' },
    '2026-10-05': { kind: 'legal', name: '国庆节' }
  };

  const options = fixture({ dateKey: '2026-10-01', holidayEndDate: '2026-10-05', holidays });
  const plans = recommendVacations(options);

  for (const plan of plans) {
    assert.ok(plan.vacation.startDate <= '2026-10-01');
    assert.ok(plan.vacation.endDate >= '2026-10-05');
  }
};

const testShortestWorkRun = () => {
  const options = fixture({ maximum: 1 });
  const plan = recommendVacations(options)[1];
  const rest = plan.ranges.filter((item) => item.type === 'rest');
  const available = [];

  for (let dateKey = '2026-10-01'; dateKey <= '2026-10-31'; dateKey = addDays(dateKey, 1)) {
    const day = classifyDay(dateKey, settings, options.holidays);

    if (dateKey >= plan.vacation.startDate && dateKey <= plan.vacation.endDate) continue;

    if (day.restAmount === 1 && !day.isPureLegal) available.push(range('work', dateKey));
  }

  let optimum = Infinity;

  available.forEach((work) => {
    const ranges = [...rest, work];
    const maximum = longestWorkingRun(options, ranges);
    optimum = Math.min(optimum, maximum);
  });

  assert.equal(plan.longestWorkDays, optimum);
};

const testInvalidOptions = () => {
  const empty = [];

  for (const maximum of [-1, 32, 0.1, NaN]) {
    const options = fixture({ maximum });
    const plans = recommendVacations(options);
    assert.deepEqual(plans, empty);
  }

  for (const leaveDays of [-1, 0.1, NaN, Infinity, null, '2']) {
    const options = fixture({ leaveDays });
    const plans = recommendVacations(options);
    assert.deepEqual(plans, empty);
  }

  const invalidDate = fixture({ dateKey: 'invalid' });
  const regularDate = fixture({ dateKey: '2026-10-15' });
  const invalidPlans = recommendVacations(invalidDate);
  const regularPlans = recommendVacations(regularDate);
  assert.deepEqual(invalidPlans, empty);
  assert.deepEqual(regularPlans, empty);
};

/**
 * 单休月最多新增一天，独立穷举六个休假区间及全部等量补班组合。
 */
const testGloballyShortestWorkRun = () => {
  const singleRestSettings = sanitizeSettings({ weekendRules: {
    5: { restPeriod: 'none', repeatIntervalWeeks: 0 },
    6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
  } });

  const options = fixture({ settings: singleRestSettings, maximum: 1 });
  const plan = recommendVacations(options)[2];
  const workSlots = ['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25']
    .flatMap((dateKey) => ['am', 'pm'].map((period) => range('work', dateKey, period)));
  let optimum = Infinity;

  for (let before = 0; before <= 2; before += 1) {
    for (let after = 0; before + after <= 2; after += 1) {
      const rest = [];

      if (before === 1) rest.push(range('rest', '2026-10-13', 'pm'));

      if (before === 2) rest.push(range('rest', '2026-10-13'));

      if (after === 1) rest.push(range('rest', '2026-10-15', 'am'));

      if (after === 2) rest.push(range('rest', '2026-10-15'));

      const required = before + after;
      const combinations = [];

      if (required === 0) combinations.push([]);

      if (required === 1) workSlots.forEach((slot) => combinations.push([slot]));

      if (required === 2) {
        for (let first = 0; first < workSlots.length; first += 1) {
          for (let second = first + 1; second < workSlots.length; second += 1) {
            combinations.push([workSlots[first], workSlots[second]]);
          }
        }
      }

      combinations.forEach((work) => {
        const ranges = [...rest, ...work];
        const longest = longestWorkingRun(options, ranges);
        optimum = Math.min(optimum, longest);
      });
    }
  }

  assert.equal(optimum, 6);
  assert.equal(plan.title, '最短连续上班');
  assert.equal(plan.longestWorkDays, optimum);
  assert.equal(plan.adjustmentDays, 0);
  assert.equal(plan.ranges.length, 0);
  assert.equal(plan.vacation.startDate, '2026-10-14');
  assert.equal(plan.vacation.endDate, '2026-10-14');
};

const testShortestWorkTie = () => {
  const options = fixture({ maximum: 1 });
  const plan = recommendVacations(options)[2];
  assert.equal(plan.longestWorkDays, 5);
  assert.equal(plan.vacationDays, 2);
  assert.equal(plan.adjustmentDays, 1);
};

const testCrossMonthMaximum = () => {
  const options = fixture({ maximum: 31, allowCrossMonth: true });
  const plans = recommendVacations(options);
  assert.equal(plans[2].longestWorkDays, 5);
  assert.ok(plans[2].longestWorkDays <= plans[0].longestWorkDays);
  assert.ok(plans[2].longestWorkDays <= plans[1].longestWorkDays);

  for (const plan of plans) assertWorkMonthScope(options, plan);
};

const testWorkMaximum = () => {
  const singleRestSettings = sanitizeSettings({ weekendRules: {
    5: { restPeriod: 'none', repeatIntervalWeeks: 0 },
    6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
  } });

  const options = fixture({ settings: singleRestSettings, maximum: 1, maximumWorkDays: 6 });
  const plans = recommendVacations(options);

  for (const plan of plans) {
    assert.equal(plan.unavailable, undefined);
    assert.equal(plan.longestWorkDays, 6);
  }

  assert.ok(plans.some((plan) => plan.ranges.some((item) => item.startPeriod === 'pm' || item.endPeriod === 'am')));
  const impossible = recommendVacations({ ...options, maximumWorkDays: 5 });
  assert.ok(impossible.every((plan) => plan.unavailable));
  const existing = range('work', '2026-10-04', 'am');
  const halfDayOptions = { ...options, maximumWorkDays: 6.5, adjustments: [record([existing])] };
  const halfDay = recommendVacations(halfDayOptions);
  assert.ok(halfDay.every((plan) => !plan.unavailable && plan.longestWorkDays === 6.5));
  const lowerLimit = recommendVacations({ ...halfDayOptions, maximumWorkDays: 6 });
  assert.ok(lowerLimit.every((plan) => plan.unavailable));
};

const testWorkMaximumBoundary = () => {
  const existing = range('work', '2026-09-27', 'pm');
  const options = fixture({ maximum: 1, maximumWorkDays: 5, adjustments: [record([existing])] });
  const impossible = recommendVacations(options);
  assert.ok(impossible.every((plan) => plan.unavailable));
  const possible = recommendVacations({ ...options, maximumWorkDays: 5.5 });
  assert.ok(possible.every((plan) => !plan.unavailable && plan.longestWorkDays === 5.5));
  const crossMonth = fixture({ maximum: 4, maximumWorkDays: 5, allowCrossMonth: true });
  const crossMonthPlans = recommendVacations(crossMonth);
  assert.ok(crossMonthPlans.every((plan) => !plan.unavailable && plan.longestWorkDays <= 5));
};

const testInvalidWorkMaximum = () => {
  const empty = [];

  for (const maximumWorkDays of [0, -1, 0.25, NaN, null, '6']) {
    const options = fixture({ maximumWorkDays });
    const plans = recommendVacations(options);
    assert.deepEqual(plans, empty);
  }
};

const testWholeDayPreference = () => {
  const options = fixture({ maximum: 1 });
  const plans = recommendVacations(options);
  assert.equal(plans[0].adjustmentDays, 1);
  assert.equal(plans[1].adjustmentDays, 1);

  for (const plan of plans) {
    assert.ok(plan.ranges.every((item) => item.startPeriod === 'am' && item.endPeriod === 'pm'));
  }
};

const testFractionalAllowance = () => {
  const cases = [
    { maximum: 1.5, leaveDays: 0 },
    { maximum: 4.5, leaveDays: 0 },
    { maximum: 0, leaveDays: 0.5 },
    { maximum: 1, leaveDays: 0.5 },
    { maximum: 1.5, leaveDays: 0.5 }
  ];

  for (const allowance of cases) {
    const options = fixture(allowance);
    const plans = recommendVacations(options);

    for (const plan of plans.slice(0, 2)) {
      assert.ok(!plan.unavailable);
      assert.equal(plan.adjustmentDays, allowance.maximum);
      assert.equal(plan.leaveDays, allowance.leaveDays);
      const work = plan.ranges.filter((item) => item.type === 'work');
      const workRecord = record(work);
      const makeup = calculateAdjustmentDays(workRecord, settings, options.holidays);
      assert.equal(makeup, allowance.maximum);
      const halfDays = work.reduce((count, item) => count + Number(item.startPeriod === 'pm')
        + Number(item.endPeriod === 'am'), 0);
      const expectedHalfDays = Number(!Number.isInteger(allowance.maximum));
      assert.equal(halfDays, expectedHalfDays);
      assert.ok(work.every((item) => item.startPeriod === 'am'));
      assertWorkMonthScope(options, plan);
      const ranges = [...plan.ranges, ...plan.leaveRanges];
      const longest = longestWorkingRun(options, ranges);
      assert.equal(plan.longestWorkDays, longest);
    }
  }
};

const testWholeDayMakeupPriority = () => {
  const options = fixture({ maximum: 4 });
  const plan = recommendVacations(options)[1];
  assert.equal(plan.vacationDays, 9);
  assert.equal(plan.adjustmentDays, 4);
  assert.equal(plan.longestWorkDays, 12);
  const work = plan.ranges.filter((item) => item.type === 'work');
  assert.ok(work.every((item) => item.startPeriod === 'am' && item.endPeriod === 'pm'));
  const workRecord = record(work);
  const makeup = calculateAdjustmentDays(workRecord, settings, options.holidays);
  assert.equal(makeup, 4);
  const longest = longestWorkingRun(options, plan.ranges);
  assert.equal(longest, 12);
  assertWorkMonthScope(options, plan);
  const rest = plan.ranges.filter((item) => item.type === 'rest');
  const available = [];

  for (let dateKey = '2026-10-01'; dateKey <= '2026-10-31'; dateKey = addDays(dateKey, 1)) {
    if (dateKey >= plan.vacation.startDate && dateKey <= plan.vacation.endDate) continue;

    const day = classifyDay(dateKey, settings, options.holidays);

    if (day.restAmount === 1 && !day.isPureLegal) available.push(dateKey);
  }

  // 独立穷举固定休假区间外所有等量补班组合，比较整天和半天的最优结果。
  const halfSlots = available.flatMap((dateKey) => ['am', 'pm'].map((period) => range('work', dateKey, period)));
  let fullOptimum = Infinity;
  let halfOptimum = Infinity;

  for (let mask = 0; mask < 2 ** halfSlots.length; mask += 1) {
    const selected = halfSlots.filter((_slot, index) => mask & 2 ** index);

    if (selected.length !== 8) continue;

    const ranges = [...rest, ...selected];
    const maximum = longestWorkingRun(options, ranges);
    halfOptimum = Math.min(halfOptimum, maximum);
    const fullDays = available.every((_dateKey, index) => {
      const morning = Boolean(mask & 2 ** (index * 2));
      const afternoon = Boolean(mask & 2 ** (index * 2 + 1));
      return morning === afternoon;
    });

    if (fullDays) fullOptimum = Math.min(fullOptimum, maximum);
  }

  assert.equal(fullOptimum, 12);
  assert.equal(fullOptimum, plan.longestWorkDays);
  assert.equal(halfOptimum, 6.5);
};

const testHalfDayMakeupFallback = () => {
  const available = ['2026-10-17'];
  const options = restrictedWorkFixture('2026-10-14', available);
  options.maximum = 0.5;
  options.allowCrossMonth = false;
  options.adjustments = [record([range('work', '2026-10-17', 'am')])];
  const plans = recommendVacations(options);

  for (const plan of plans.slice(0, 2)) {
    assert.equal(plan.adjustmentDays, 0.5);
    const work = plan.ranges.filter((item) => item.type === 'work');
    assert.equal(work.length, 1);
    assert.equal(work[0].startDate, '2026-10-17');
    assert.equal(work[0].startPeriod, 'pm');
    assert.equal(work[0].endPeriod, 'pm');
    assertWorkMonthScope(options, plan);
  }
};

const testHalfDayWorkStreak = () => {
  const morning = range('work', '2026-10-03', 'am');
  const options = fixture({ maximum: 0, maximumWorkDays: 5.5, adjustments: [record([morning])] });
  const morningPlans = recommendVacations(options);
  assert.ok(morningPlans.every((plan) => !plan.unavailable && plan.longestWorkDays === 5.5));
  const afternoon = range('work', '2026-10-03', 'pm');
  const afternoonOptions = { ...options, maximumWorkDays: 5, adjustments: [record([afternoon])] };
  const afternoonPlans = recommendVacations(afternoonOptions);
  assert.ok(afternoonPlans.every((plan) => !plan.unavailable && plan.longestWorkDays === 5));
};

const testMoreThanFour = () => {
  const amounts = [];

  for (const maximum of [4, 5, 6]) {
    const options = fixture({ maximum });
    const plan = recommendVacations(options)[0];
    amounts.push(plan.adjustmentDays);
  }

  const expected = [4, 5, 6];
  assert.deepEqual(amounts, expected);
};

const testLeaveAllowance = () => {
  const options = fixture({ maximum: 0, leaveDays: 2 });
  const plans = recommendVacations(options);

  for (const plan of plans) {
    assert.equal(plan.adjustmentDays, 0);
    assert.equal(plan.ranges.length, 0);
    assert.equal(plan.leaveDays, 2);
    assert.ok(plan.leaveRanges.length > 0);
  }

  const mixed = fixture({ maximum: 1, leaveDays: 2 });
  const mixedPlan = recommendVacations(mixed)[0];
  assert.equal(mixedPlan.leaveDays, 2);
  assert.equal(mixedPlan.adjustmentDays, 1);
  const work = mixedPlan.ranges.filter((item) => item.type === 'work');
  const workRecord = record(work);
  const workDays = calculateAdjustmentDays(workRecord, settings, mixed.holidays);
  assert.equal(workDays, 1);
};

const testCapacityLimit = () => {
  const singleRest = sanitizeSettings({ weekendRules: {
    5: { restPeriod: 'none', repeatIntervalWeeks: 0 },
    6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
  } });

  const options = fixture({ settings: singleRest });
  const limit = getVacationAdjustmentLimit(options);
  assert.equal(limit, 4);
  const crossMonthLimit = getVacationAdjustmentLimit({ ...options, allowCrossMonth: true });
  assert.equal(crossMonthLimit, 8);
  const used = range('rest', '2026-10-02');
  const charged = getVacationAdjustmentLimit({ ...options, adjustments: [record([used])] });
  assert.equal(charged, 4);
  const free = { ...record([used]), associationType: 'none' };
  const uncharged = getVacationAdjustmentLimit({ ...options, adjustments: [free] });
  assert.equal(uncharged, 4);
  const existingWork = range('work', '2026-10-04');
  const occupied = { ...options, adjustments: [record([used, existingWork])] };
  const reduced = getVacationAdjustmentLimit(occupied);
  assert.equal(reduced, 3);
  const crossMonthReduced = getVacationAdjustmentLimit({ ...occupied, allowCrossMonth: true });
  assert.equal(crossMonthReduced, 7);
};

const testCapacityWorkMaximum = () => {
  const settings = sanitizeSettings();
  const holidays = createQuotaHolidays(2027, 2026, settings);
  const options = { dateKey: '2027-02-05', holidayEndDate: '2027-02-10', settings,
    holidays, adjustments: [], leaveDays: 0, allowCrossMonth: false };
  const unlimited = getVacationAdjustmentLimit(options);
  assert.equal(unlimited, 10);
  const cases = [
    { maximumWorkDays: 6, expected: 2 },
    { maximumWorkDays: 6.5, expected: 2.5 },
    { maximumWorkDays: 0.5, expected: 0 }
  ];

  for (const { maximumWorkDays, expected } of cases) {
    const context = { ...options, maximumWorkDays };
    const capacity = getVacationAdjustmentLimit(context);
    assert.equal(capacity, expected);
    const configured = { ...context, maximum: capacity };
    const plans = recommendVacations(configured);

    for (const plan of plans) {
      if (maximumWorkDays === 0.5) {
        assert.ok(plan.unavailable);
        continue;
      }

      assert.ok(!plan.unavailable);
      assert.ok(plan.longestWorkDays <= maximumWorkDays);
      assert.ok(plan.adjustmentDays <= capacity);
      assertWorkMonthScope(context, plan);
    }
  }

  for (const maximumWorkDays of [0, -1, 0.25, NaN, null, '6']) {
    const invalid = { ...options, maximumWorkDays };
    const capacity = getVacationAdjustmentLimit(invalid);
    assert.equal(capacity, 0);
  }
};

const testLeaveAllocation = () => {
  const existing = record([range('rest', '2026-09-30')]);
  const cases = [
    fixture({ maximum: 0, leaveDays: 0.5 }),
    fixture({ maximum: 1.5, leaveDays: 0.5 }),
    fixture({ maximum: 1, leaveDays: 2, allowCrossMonth: true, adjustments: [existing],
      dateKey: '2026-10-01', holidays: { '2026-10-01': { kind: 'legal', name: '测试假期' } } })
  ];

  for (const options of cases) {
    const plans = recommendVacations(options);

    for (const plan of plans) {
      assert.ok(!plan.unavailable);
      assertWorkMonthScope(options, plan);
      assert.ok(plan.leaveDays <= options.leaveDays);
      const totals = { rest: 0, work: 0 };

      plan.ranges.forEach((item) => {
        totals[item.type] += calculateAdjustmentDays(item, settings, options.holidays);
      });

      assert.equal(totals.rest, totals.work);
      assert.equal(totals.rest, plan.adjustmentDays);
      assert.ok(totals.rest <= options.maximum);
      const leaveRecord = record(plan.leaveRanges);
      const free = calculateAdjustmentDays(leaveRecord, settings, options.holidays);
      assert.equal(free, plan.leaveDays);
      const combined = { ...record([...plan.ranges, ...plan.leaveRanges]), id: 'new' };
      const current = [combined, ...options.adjustments];
      const overlapping = hasAdjustmentOverlap(combined, current, settings, options.holidays);
      assert.equal(overlapping, false);

      for (let dateKey = '2026-09-01'; dateKey <= '2026-11-30'; dateKey = addDays(dateKey, 1)) {
        const finalDay = classifyDay(dateKey, settings, options.holidays, current);

        for (const period of ['am', 'pm']) {
          if (dateKey >= plan.vacation.startDate && dateKey <= plan.vacation.endDate
            && (dateKey !== plan.vacation.startDate || period >= plan.vacation.startPeriod)
            && (dateKey !== plan.vacation.endDate || period <= plan.vacation.endPeriod)) {
            assert.ok(finalDay.periods[period].isRest);
          }
        }
      }

      const totalAdded = totals.rest + free;
      const totalAllowance = options.maximum + options.leaveDays;
      assert.ok(totalAdded <= totalAllowance);
      const ranges = [...plan.ranges, ...plan.leaveRanges];
      const longest = longestWorkingRun(options, ranges);
      const details = JSON.stringify({ maximum: options.maximum, leaveDays: options.leaveDays,
        allowCrossMonth: options.allowCrossMonth, plan });
      assert.equal(plan.longestWorkDays, longest, details);
    }
  }

  const halfPlan = recommendVacations(cases[0])[0];
  assert.equal(halfPlan.leaveDays, 0.5);
};

/**
 * 其余周末作为受保护的法定休息，隔离可补班日期，不访问实际排班存储。
 */
function restrictedWorkFixture(dateKey, availableDates) {
  const holidays = { [dateKey]: { kind: 'legal', name: '测试假期' } };
  const emptyHolidays = {};

  for (let current = '2026-09-01'; current <= '2026-11-30'; current = addDays(current, 1)) {
    const day = classifyDay(current, settings, emptyHolidays);

    if (day.restAmount === 1 && !availableDates.includes(current)) {
      holidays[current] = { kind: 'legal', name: '保护休息' };
    }
  }

  return fixture({ dateKey, holidays, maximum: 3, allowCrossMonth: true });
}

const testOneAdjacentMonth = () => {
  const dates = ['2026-09-27', '2026-10-10', '2026-11-01'];
  const early = restrictedWorkFixture('2026-10-14', dates);
  const late = restrictedWorkFixture('2026-10-20', dates);
  const cases = [
    { options: early, expectedMonths: ['2026-09', '2026-11'] },
    { options: late, expectedMonths: ['2026-11', '2026-11'] }
  ];

  for (const { options, expectedMonths } of cases) {
    const capacity = getVacationAdjustmentLimit(options);
    assert.equal(capacity, 2);
    const plans = recommendVacations(options);

    for (const plan of plans) assertWorkMonthScope(options, plan);

    for (const [index, plan] of plans.slice(0, 2).entries()) {
      assert.equal(plan.adjustmentDays, 2);
      const work = plan.ranges.filter((item) => item.type === 'work');
      const foreign = work.filter((item) => !item.startDate.startsWith('2026-10'));
      const expected = expectedMonths[index];
      assert.ok(foreign.length > 0);
      assert.ok(foreign.every((item) => item.startDate.startsWith(expected)));
      assert.ok(work.some((item) => item.startDate.startsWith('2026-10')));
    }

    const local = { ...options, allowCrossMonth: false };
    const localPlans = recommendVacations(local);

    for (const plan of localPlans) {
      assert.ok(plan.adjustmentDays <= 1);
      assertWorkMonthScope(local, plan);
    }
  }
};

const testLocalMonthPreference = () => {
  const options = fixture({ maximum: 1, allowCrossMonth: true });
  const local = { ...options, allowCrossMonth: false };
  const plans = recommendVacations(options);

  for (const plan of plans) assertWorkMonthScope(local, plan);
};

const testNearbyMonthFallback = () => {
  const dates = ['2026-09-27', '2026-10-10', '2026-11-01'];
  const options = restrictedWorkFixture('2026-10-14', dates);
  delete options.holidays['2026-09-26'];
  const existing = range('work', '2026-09-26');
  options.adjustments = [record([existing])];
  options.maximumWorkDays = 6;
  const plans = recommendVacations(options);

  for (const plan of plans.slice(0, 2)) {
    assert.ok(!plan.unavailable);
    assert.equal(plan.adjustmentDays, 2);
    assert.ok(plan.longestWorkDays <= 6);
    const work = plan.ranges.filter((item) => item.type === 'work');
    assert.ok(work.some((item) => item.startDate.startsWith('2026-11')));
    assert.ok(work.every((item) => !item.startDate.startsWith('2026-09')));
    assertWorkMonthScope(options, plan);
  }
};

const testNearestMonthPrecision = () => {
  const halfSettings = sanitizeSettings({ weekendRules: {
    5: { restPeriod: 'am', repeatIntervalWeeks: 0 },
    6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
  } });

  const existing = [];
  const emptyHolidays = {};

  for (let dateKey = '2023-10-01'; dateKey <= '2023-10-31'; dateKey = addDays(dateKey, 1)) {
    const day = classifyDay(dateKey, halfSettings, emptyHolidays);

    if (day.restAmount === 1) existing.push(range('work', dateKey));

    if (day.restAmount === 0.5) existing.push(range('work', dateKey, 'am'));
  }

  const options = fixture({ dateKey: '2023-10-16', settings: halfSettings, maximum: 1,
    holidays: { '2023-10-16': { kind: 'legal', name: '测试假期' } },
    adjustments: [record(existing)], allowCrossMonth: true });
  const plans = recommendVacations(options);

  for (const plan of plans.slice(0, 2)) {
    assert.ok(!plan.unavailable);
    const work = plan.ranges.filter((item) => item.type === 'work');
    assert.equal(work.length, 1);
    assert.ok(work[0].startDate.startsWith('2023-11'));
    assert.equal(work[0].startPeriod, 'am');
    assert.equal(work[0].endPeriod, 'pm');
    assertWorkMonthScope(options, plan);
  }

  const dates = ['2026-09-27', '2026-11-01'];
  const half = restrictedWorkFixture('2026-10-14', dates);
  half.maximum = 0.5;
  half.holidays['2026-10-15'] = { kind: 'legal', name: '边界休息' };
  half.adjustments = [record([range('work', '2026-10-15')])];
  const halfPlans = recommendVacations(half);

  for (const plan of halfPlans.slice(0, 2)) {
    assert.equal(plan.adjustmentDays, 0.5);
    const work = plan.ranges.filter((item) => item.type === 'work');
    assert.ok(work.every((item) => item.startDate.startsWith('2026-09')));
    const proposed = record(work);
    const amount = calculateAdjustmentDays(proposed, settings, half.holidays);
    assert.equal(amount, 0.5);
    assertWorkMonthScope(half, plan);
  }
};

const testBridgeAvailableRest = () => {
  const holidays = {
    '2026-09-30': { kind: 'legal', name: '原休息日' },
    '2026-10-01': { kind: 'legal', name: '测试假期' },
    '2026-10-07': { kind: 'legal', name: '另一假期' },
    '2026-10-08': { kind: 'legal', name: '原休息日' }
  };

  const blocked = { ...record([range('work', '2026-09-30'), range('work', '2026-10-08')]),
    id: 'blocked', associationType: 'none' };
  const existingRest = { ...record([range('rest', '2026-10-05')]), id: 'available', associationType: 'none' };
  const base = fixture({ dateKey: '2026-10-01', holidays, adjustments: [blocked, existingRest], maximum: 2 });
  const mixed = { ...base, maximum: 1, leaveDays: 1 };

  for (const options of [base, mixed]) {
    const original = structuredClone(options);
    const plans = recommendVacations(options);

    for (const plan of plans.slice(0, 2)) {
      assert.equal(plan.vacation.startDate, '2026-10-01');
      assert.equal(plan.vacation.endDate, '2026-10-07');
      assert.equal(plan.vacationDays, 7);
      const addedRest = [...plan.ranges.filter((item) => item.type === 'rest'), ...plan.leaveRanges]
        .sort((a, b) => a.startDate.localeCompare(b.startDate));
      const dates = addedRest.map((item) => item.startDate);
      const expected = ['2026-10-02', '2026-10-06'];
      assert.deepEqual(dates, expected);
      assert.ok(addedRest.every((item) => item.endDate === item.startDate));
      const leaveDays = options.leaveDays ?? 0;
      assert.equal(plan.adjustmentDays, options.maximum);
      assert.equal(plan.leaveDays, leaveDays);
      const work = plan.ranges.filter((item) => item.type === 'work');
      const workRecord = record(work);
      const makeup = calculateAdjustmentDays(workRecord, settings, holidays);
      assert.equal(makeup, plan.adjustmentDays);
      assertWorkMonthScope(options, plan);
      const combined = { ...record([...plan.ranges, ...plan.leaveRanges]), id: 'proposed' };
      const current = [...options.adjustments, combined];
      const overlapping = hasAdjustmentOverlap(combined, current, settings, holidays);
      assert.equal(overlapping, false);

      for (let dateKey = '2026-10-01'; dateKey <= '2026-10-07'; dateKey = addDays(dateKey, 1)) {
        const day = classifyDay(dateKey, settings, holidays, current);
        assert.equal(day.restAmount, 1);
      }

      const ranges = [...plan.ranges, ...plan.leaveRanges];
      const longest = longestWorkingRun(options, ranges);
      assert.equal(plan.longestWorkDays, longest);
    }

    assert.deepEqual(options, original);
  }

  const withoutLeave = { ...mixed, leaveDays: 0 };
  const shorter = recommendVacations(withoutLeave)[1];
  assert.ok(shorter.vacationDays < 7);
};

const testTotalAllowanceAcrossMonths = () => {
  const holidays = {
    '2026-12-30': { kind: 'legal', name: '边界休息日' },
    '2027-01-01': { kind: 'legal', name: '元旦' },
    '2027-01-05': { kind: 'legal', name: '边界休息日' }
  };

  const blocked = { ...record([range('work', '2026-12-30'), range('work', '2027-01-05')]),
    id: 'blocked', associationType: 'none' };
  const base = fixture({ dateKey: '2027-01-01', holidays, adjustments: [blocked], maximum: 1 });
  const cases = [
    base,
    { ...base, allowCrossMonth: true },
    { ...base, leaveDays: 1 },
    { ...base, maximum: 2 },
    { ...base, maximum: 2, allowCrossMonth: true }
  ];

  for (const options of cases) {
    const original = structuredClone(options);
    const plans = recommendVacations(options);
    const leaveDays = options.leaveDays ?? 0;

    for (const plan of plans) {
      assert.ok(!plan.unavailable);
      assert.ok(plan.adjustmentDays <= options.maximum);
      assert.ok(plan.leaveDays <= leaveDays);
      const rest = [...plan.ranges.filter((item) => item.type === 'rest'), ...plan.leaveRanges];
      const work = plan.ranges.filter((item) => item.type === 'work');
      const restRecord = record(rest);
      const workRecord = record(work);
      const totalRest = calculateAdjustmentDays(restRecord, settings, holidays);
      const totalWork = calculateAdjustmentDays(workRecord, settings, holidays);
      const totalAllowance = options.maximum + leaveDays;
      assert.ok(totalRest <= totalAllowance);
      assert.equal(totalWork, plan.adjustmentDays);
      assertWorkMonthScope(options, plan);
    }

    for (const plan of plans.slice(0, 2)) {
      const expectedDays = options.maximum + leaveDays === 1 ? 4 : 5;
      assert.equal(plan.vacationDays, expectedDays);

      if (expectedDays === 5) {
        const rest = [...plan.ranges.filter((item) => item.type === 'rest'), ...plan.leaveRanges];
        const months = [...new Set(rest.map((item) => item.startDate.slice(0, 7)))].sort();
        const expected = ['2026-12', '2027-01'];
        assert.deepEqual(months, expected);
      }
    }

    assert.deepEqual(options, original);
  }
};

const testMonthlyAllowanceMatching = () => {
  const holidays = {
    '2026-12-30': { kind: 'legal', name: '边界休息' },
    '2027-01-01': { kind: 'legal', name: '元旦' },
    '2027-01-05': { kind: 'legal', name: '边界休息' }
  };

  const emptyHolidays = {};

  for (let dateKey = '2027-01-01'; dateKey <= '2027-01-31'; dateKey = addDays(dateKey, 1)) {
    const day = classifyDay(dateKey, settings, emptyHolidays);

    if (day.restAmount === 1) holidays[dateKey] = { kind: 'legal', name: '保护休息' };
  }

  const blocked = { ...record([range('work', '2026-12-30'), range('work', '2027-01-05')]),
    id: 'blocked', associationType: 'none' };
  const options = fixture({ dateKey: '2027-01-01', holidays, adjustments: [blocked], maximum: 1, leaveDays: 1 });
  const capacity = getVacationAdjustmentLimit(options);
  assert.ok(capacity >= 1);
  const plans = recommendVacations(options);

  for (const plan of plans.slice(0, 2)) {
    assert.equal(plan.vacationDays, 5);
    assert.equal(plan.adjustmentDays, 1);
    assert.equal(plan.leaveDays, 1);
    assert.equal(plan.leaveRanges[0].startDate, '2027-01-04');
    const rest = plan.ranges.filter((item) => item.type === 'rest');
    const work = plan.ranges.filter((item) => item.type === 'work');
    assert.equal(rest[0].startDate, '2026-12-31');
    assert.ok(work.every((item) => item.startDate.startsWith('2026-12')));
    assertWorkMonthScope(options, plan);
  }

  const localHalf = { ...options, maximum: 0.5, leaveDays: 0 };
  const halfPlans = recommendVacations(localHalf);

  for (const plan of halfPlans.slice(0, 2)) {
    assert.equal(plan.adjustmentDays, 0.5);
    assertWorkMonthScope(localHalf, plan);
  }

  const dates = ['2026-09-27', '2026-11-01'];
  const twoSides = restrictedWorkFixture('2026-10-14', dates);
  twoSides.maximum = 2;
  const oneSideCapacity = getVacationAdjustmentLimit(twoSides);
  assert.equal(oneSideCapacity, 1);
  const limited = recommendVacations(twoSides);

  for (const plan of limited.slice(0, 2)) {
    assert.equal(plan.adjustmentDays, 1);
    assertWorkMonthScope(twoSides, plan);
  }
};

test('推荐设置默认四天、不跨月，半天值及非默认跨月值可在两端备份往返', testSettings);
test('三种推荐保持调休补班等量、连续休假及现有表单兼容，不修改输入', testRecommendationPlans);
test('已有调休不扣本次新增额度，已有调班与法定休假不被占用', testExistingAdjustments);
test('关闭跨月按调休月份配平补班，跨年休假的新增调休按总额度计算', testCrossMonth);
test('半天周末与半天额度可推荐，零额度只保留原有休假', testHalfDays);
test('同组法定日期被周末隔开时，方案仍覆盖整组假期', testScatteredLegalDates);
test('补班选择达到所有可用整天组合中的最短连续工作段', testShortestWorkRun);
test('非法参数、非法日期和非假日不生成方案', testInvalidOptions);
test('第三方案在整天精度下最小化最长工作段，必要时不新增调班', testGloballyShortestWorkRun);
test('最短连续上班相同时优先更长假期', testShortestWorkTie);
test('跨月及最大上限时仍优先选择最短连续工作段', testCrossMonthMaximum);
test('三类方案均受最长上班上限约束，无合规方案时标记不可用', testWorkMaximum);
test('最长上班上限覆盖月边界连续工作段及跨月方案', testWorkMaximumBoundary);
test('最长上班上限拒绝非正半天倍数，省略仍沿用不限行为', testInvalidWorkMaximum);
test('整数额度且连续上班效果相同时优先整天调休和补班', testWholeDayPreference);
test('明确输入半天调休或免费假期额度时不舍去小数，补班仍等量配对', testFractionalAllowance);
test('有可用整天补班时保留整天，不为缩短连续上班主动拆成半天', testWholeDayMakeupPriority);
test('半天补班上午不可用时仍可选择下午，不覆盖已有安排', testHalfDayMakeupFallback);
test('连续工作按半天累计，半天休息会中断工作段', testHalfDayWorkStreak);
test('调休上限从4增加到5、6时按新值重新生成方案', testMoreThanFour);
test('免补班假期可单独使用，也可与需补班调休额度相加', testLeaveAllowance);
test('页面调休最大值只按可补班时段计算，不加回已有调休，已有补班占用日期', testCapacityLimit);
test('2027春节调休容量计入最长上班上限，支持半天容量并拒绝非法上限', testCapacityWorkMaximum);
test('半天与跨月假期分配保持连续休假、总额度及等量补班约束', testLeaveAllocation);
test('补班最多跨一个相邻月，容量不合并左右月份且优先最近的一侧', testOneAdjacentMonth);
test('同月已有合规配对时不额外借用相邻月份', testLocalMonthPreference);
test('最近相邻月违反上班上限时改用另一侧，仍不同时使用两侧月份', testNearbyMonthFallback);
test('最近月份按当前整天或半天精度的可补班日期计算', testNearestMonthPrecision);
test('调休日可分散在两处缺口，与周末、法定、已有及额外假期拼成一段连休', testBridgeAvailableRest);
test('调休上限为本次新增总额度，跨月跨年不重复计额，免补班假期继续额外叠加', testTotalAllowanceAcrossMonths);
test('同月匹配与法定假日月份无关，免费假期补足欠缺月份，半天配平且不能同时借两侧', testMonthlyAllowanceMatching);
