import { addDays, calculateAdjustmentDays, classifyDay, getAdjustmentRanges, isDateKey, parseDate } from './core.js';

function countSlotsByMonth(slots) {
  const counts = new Map();

  slots.forEach((slot) => {
    const count = (counts.get(slot.month) ?? 0) + 1;
    counts.set(slot.month, count);
  });

  return counts;
}

function monthIndex(month) {
  const [year, value] = month.split('-').map(Number);
  return year * 12 + value;
}

/**
 * 只比较需要补班的记录，月份间存在可抵消的正负余额才需要跨月匹配。
 * 单纯欠补班或欠调休不视为跨月。
 */
export function hasCrossMonthCompensation(context) {
  const { records, settings, holidays } = context;
  const balances = new Map();

  records.filter((record) => record.associationType === 'required').forEach((record) => {
    getAdjustmentRanges(record).forEach((range) => {
      for (let dateKey = range.startDate; dateKey <= range.endDate; dateKey = addDays(dateKey, 1)) {
        const startPeriod = dateKey === range.startDate ? range.startPeriod : 'am';
        const endPeriod = dateKey === range.endDate ? range.endPeriod : 'pm';
        const day = { ...range, startDate: dateKey, endDate: dateKey, startPeriod, endPeriod };
        let amount = calculateAdjustmentDays(day, settings, holidays);

        if (range.type === 'work') amount = -amount;

        const month = dateKey.slice(0, 7);
        const balance = (balances.get(month) ?? 0) + amount;
        balances.set(month, balance);
      }
    });
  });

  const values = [...balances.values()];
  return values.some((balance) => balance > 0) && values.some((balance) => balance < 0);
}

/**
 * 将连续半天合并为已有调班表单支持的范围。
 */
function toRanges(slots, type) {
  const ranges = [];

  slots.forEach((slot) => {
    const previous = ranges.at(-1);
    let nextDate = '';

    if (previous) nextDate = addDays(previous.endDate, 1);

    if (previous && (previous.endDate === slot.dateKey && previous.endPeriod === 'am'
      || nextDate === slot.dateKey && previous.endPeriod === 'pm' && slot.period === 'am')) {
      previous.endDate = slot.dateKey;
      previous.endPeriod = slot.period;
    } else {
      ranges.push({ type, startDate: slot.dateKey, startPeriod: slot.period,
        endDate: slot.dateKey, endPeriod: slot.period });
    }
  });

  return ranges;
}

/**
 * 在每月配对上下界内选择等量补班，缩短最长连续上班及长工作段。
 * 工作按半天累计，任一休息时段均中断连续上班。
 */
function optimizeWorkDays(days, vacation, constraints) {
  const { boundary, maximumWorkDays, allowHalfDays, bounds } = constraints;
  const required = vacation.requiredWorkSlots;
  const maximumWorkSlots = maximumWorkDays * 2;

  if (!allowHalfDays && required % 2 !== 0) return null;

  let baselineStreak = boundary.before;
  let baselineMaximum = boundary.before;

  // 原有工作段已超限时，新增补班无法改善，直接排除而不展开组合。
  for (const day of days) {
    for (const slot of day.slots) {
      if (!slot.isRest && (slot.index < vacation.start || slot.index > vacation.end)) {
        baselineStreak += 1;
        baselineMaximum = Math.max(baselineMaximum, baselineStreak);
      } else {
        baselineStreak = 0;
      }
    }
  }

  baselineMaximum = Math.max(baselineMaximum, baselineStreak + boundary.after);

  if (baselineMaximum > maximumWorkSlots) return null;

  let states = new Map([
    ['0:0:0', { used: 0, monthUsed: 0, streak: boundary.before,
      halfDays: 0, afternoonHalfDays: 0, maximum: boundary.before, penalty: 0, slots: [] }]
  ]);

  for (const [index, day] of days.entries()) {
    const month = day.slots[0].month;
    const limit = bounds.get(month) ?? { minimum: 0, maximum: 0 };
    const monthEnd = days[index + 1]?.slots[0].month !== month;
    const available = day.slots.filter((slot) => slot.isRest && !slot.protected && limit.maximum > 0
      && (slot.index < vacation.start || slot.index > vacation.end));
    const choices = [[]];

    if (allowHalfDays) available.forEach((slot) => choices.push([slot]));

    if (available.length === 2) choices.push(available);

    const next = new Map();

    for (const state of states.values()) {
      for (const slots of choices) {
        const used = state.used + slots.length;
        const monthUsed = state.monthUsed + slots.length;

        if (used > required || monthUsed > limit.maximum || monthEnd && monthUsed < limit.minimum) continue;

        let streak = state.streak;
        let maximum = state.maximum;
        let penalty = state.penalty;

        day.slots.forEach((slot) => {
          if (slots.includes(slot) || !slot.isRest
            && (slot.index < vacation.start || slot.index > vacation.end)) {
            streak += 1;
            maximum = Math.max(maximum, streak);
            penalty += streak * streak;
          } else {
            streak = 0;
          }
        });

        if (maximum > maximumWorkSlots) continue;

        const remainingMonthUsed = monthEnd ? 0 : monthUsed;
        const key = `${used}:${remainingMonthUsed}:${streak}`;
        const previous = next.get(key);
        const halfDays = state.halfDays + Number(slots.length === 1);
        const afternoonHalfDays = state.afternoonHalfDays + Number(slots.length === 1 && slots[0].period === 'pm');
        let previousOrder = 1;

        if (previous) {
          previousOrder = previous.halfDays - halfDays || previous.afternoonHalfDays - afternoonHalfDays
            || previous.maximum - maximum || previous.penalty - penalty;
        }

        if (previousOrder <= 0) continue;

        const result = { used, monthUsed: remainingMonthUsed, streak, halfDays, afternoonHalfDays, maximum,
          penalty, slots: [...state.slots, ...slots] };
        next.set(key, result);
      }
    }

    states = next;

    if (!states.size) return null;
  }

  return [...states.values()].filter((state) => state.used === required).map((state) => {
    const endingStreak = state.streak + boundary.after;
    const maximum = Math.max(state.maximum, endingStreak) / 2;
    return { ...state, maximum };
  }).filter((state) => state.maximum <= maximumWorkDays)
    .sort((left, right) => left.halfDays - right.halfDays || left.afternoonHalfDays - right.afternoonHalfDays
      || left.maximum - right.maximum || left.penalty - right.penalty)[0];
}

/**
 * 每月补班对应本月调休；跨月匹配只在一个相邻月份边界转移额度。
 */
function createWorkWindow(vacation, availableByMonth, transfer = null) {
  const months = new Set([...vacation.restByMonth.keys(), ...availableByMonth.keys()]);
  const bounds = new Map();
  let minimumTotal = 0;
  let maximumTotal = 0;

  for (const month of months) {
    let minimum = 0;
    let maximum = vacation.restByMonth.get(month) ?? 0;

    if (transfer?.source === month) maximum -= transfer.amount;

    if (transfer?.destination === month) {
      minimum = transfer.amount;
      maximum += transfer.amount;
    }

    const capacity = availableByMonth.get(month) ?? 0;
    maximum = Math.min(maximum, capacity);

    if (minimum > maximum) return null;

    minimumTotal += minimum;
    maximumTotal += maximum;
    const limit = { minimum, maximum };
    bounds.set(month, limit);
  }

  if (vacation.requiredWorkSlots < minimumTotal || vacation.requiredWorkSlots > maximumTotal) return null;

  return { bounds, transfer };
}

function getWorkWindows(vacation, options) {
  const { allowCrossMonth, allowHalfDays } = options;
  const available = vacation.available;
  const dateCounts = new Map();

  if (!allowHalfDays) {
    available.forEach((slot) => {
      const count = (dateCounts.get(slot.dateKey) ?? 0) + 1;
      dateCounts.set(slot.dateKey, count);
    });
  }

  const eligible = available.filter((slot) => allowHalfDays || dateCounts.get(slot.dateKey) === 2);
  const availableByMonth = countSlotsByMonth(eligible);
  const windows = [];
  const local = createWorkWindow(vacation, availableByMonth);

  if (local) windows.push(local);

  if (!allowCrossMonth || !vacation.requiredWorkSlots) return windows;

  const adjacent = [];
  const step = allowHalfDays ? 1 : 2;

  for (const [source, count] of vacation.restByMonth) {
    const sourceIndex = monthIndex(source);
    const sourceSlots = vacation.rest.filter((slot) => slot.month === source);
    const first = sourceSlots[0].index;
    const last = sourceSlots.at(-1).index;

    for (const [destination, capacity] of availableByMonth) {
      const destinationIndex = monthIndex(destination);
      const monthDistance = Math.abs(destinationIndex - sourceIndex);

      if (monthDistance !== 1) continue;

      let distance = Infinity;

      eligible.filter((slot) => slot.month === destination).forEach((slot) => {
        const before = first - slot.index;
        const after = slot.index - last;
        const separation = Math.max(before, after, 0);
        distance = Math.min(distance, separation);
      });

      const required = vacation.requiredWorkSlots;
      const maximum = Math.min(count, capacity, required);

      for (let amount = step; amount <= maximum; amount += step) {
        const transfer = { source, destination, amount, distance };
        const window = createWorkWindow(vacation, availableByMonth, transfer);

        if (window) adjacent.push(window);
      }
    }
  }

  adjacent.sort((a, b) => a.transfer.distance - b.transfer.distance || a.transfer.amount - b.transfer.amount);
  windows.push(...adjacent);
  return windows;
}

/**
 * 根据每月实际补班及跨月转移量分配免补班假期，避免把免费额度用错月份。
 */
function allocateRest(vacation, work, transfer) {
  const requiredByMonth = countSlotsByMonth(work.slots);

  if (transfer) {
    const sourceCount = (requiredByMonth.get(transfer.source) ?? 0) + transfer.amount;
    const destinationCount = (requiredByMonth.get(transfer.destination) ?? 0) - transfer.amount;
    requiredByMonth.set(transfer.source, sourceCount);
    requiredByMonth.set(transfer.destination, destinationCount);
  }

  const leaveByMonth = new Map();

  vacation.restByMonth.forEach((count, month) => {
    const leave = count - (requiredByMonth.get(month) ?? 0);
    leaveByMonth.set(month, leave);
  });

  const leaveRest = [];
  const swapRest = [];

  vacation.rest.forEach((slot) => {
    const remaining = leaveByMonth.get(slot.month);

    if (remaining > 0) {
      leaveRest.push(slot);
      const next = remaining - 1;
      leaveByMonth.set(slot.month, next);
    } else {
      swapRest.push(slot);
    }
  });

  return { ...work, leaveRest, swapRest };
}

function chooseWorkDays(days, vacation, constraints) {
  const { boundary, maximumWorkDays, allowHalfDays, workContext } = constraints;
  const options = { ...workContext, allowHalfDays };
  const windows = getWorkWindows(vacation, options);

  for (const window of windows) {
    const limits = { boundary, maximumWorkDays, allowHalfDays: false, bounds: window.bounds };
    let work = optimizeWorkDays(days, vacation, limits);

    if (!work && allowHalfDays) {
      const halfDayLimits = { ...limits, allowHalfDays: true };
      work = optimizeWorkDays(days, vacation, halfDayLimits);
    }

    if (work) return allocateRest(vacation, work, window.transfer);
  }

  return null;
}

/**
 * 休假始终可延伸至前后相邻月，跨月开关约束调休与补班的月份配对。
 * 已有调班只保护日期；法定假期与已有个人调班不用于补班。
 * 只补齐原本上班的缺口，新增调休日可由周末、法定及已有休假隔开。
 */
function createRecommendationContext(options) {
  const { dateKey, settings, holidays, adjustments = [], allowCrossMonth = false } = options;

  if (!isDateKey(dateKey)) return null;

  const selected = classifyDay(dateKey, settings, holidays, adjustments);

  if (!selected.isPureLegal) return null;

  const date = parseDate(dateKey);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const firstMonthIndex = month - 1;
  const nextMonthIndex = month + 2;
  const firstMonth = new Date(Date.UTC(year, firstMonthIndex, 1));
  const nextMonth = new Date(Date.UTC(year, nextMonthIndex, 1));
  const startDate = firstMonth.toISOString().slice(0, 10);
  const followingMonthStart = nextMonth.toISOString().slice(0, 10);
  const endDate = addDays(followingMonthStart, -1);
  const days = [];
  const slots = [];

  for (let current = startDate; current <= endDate; current = addDays(current, 1)) {
    const day = classifyDay(current, settings, holidays, adjustments);
    const monthKey = current.slice(0, 7);
    const daySlots = ['am', 'pm'].map((period) => {
      const value = day.periods[period];
      const slot = { dateKey: current, month: monthKey, period, index: slots.length, isRest: value.isRest,
        protected: value.isPureLegal || Boolean(value.manualAdjustment) };
      slots.push(slot);
      return slot;
    });

    days.push({ slots: daySlots });
  }

  const anchor = slots.findIndex((slot) => slot.dateKey === dateKey);
  let legalStart = anchor;
  let legalEnd = anchor + 1;
  const name = selected.holiday.name;
  const finalLegalDate = options.holidayEndDate ?? dateKey;

  if (!isDateKey(finalLegalDate) || finalLegalDate < dateKey || finalLegalDate > endDate) return null;

  const finalLegalIndex = slots.findIndex((slot) => slot.dateKey === finalLegalDate && slot.period === 'pm');
  legalEnd = Math.max(legalEnd, finalLegalIndex);

  // 以同名连续法定日期为核心，前后周末由候选范围自然吸收。
  while (legalStart >= 2) {
    const previousDate = slots[legalStart - 2].dateKey;
    const previous = classifyDay(previousDate, settings, holidays, adjustments);

    if (!previous.isPureLegal || previous.holiday.name !== name) break;

    legalStart -= 2;
  }

  while (legalEnd + 2 < slots.length) {
    const nextDate = slots[legalEnd + 1].dateKey;
    const next = classifyDay(nextDate, settings, holidays, adjustments);

    if (!next.isPureLegal || next.holiday.name !== name) break;

    legalEnd += 2;
  }

  const workContext = { allowCrossMonth };
  return { settings, holidays, adjustments, startDate, endDate, days, slots,
    legalStart, legalEnd, workContext };
}

/**
 * 按可补班时段、月份配对及最长上班上限计算本次新增调休容量。
 */
export function getVacationAdjustmentLimit(options) {
  const context = createRecommendationContext(options);

  if (!context) return 0;

  const { maximumWorkDays = Infinity } = options;

  if (maximumWorkDays !== Infinity
    && (!Number.isFinite(maximumWorkDays) || !Number.isSafeInteger(maximumWorkDays * 2)
      || maximumWorkDays < 0.5)) return 0;

  let leaveDays = options.leaveDays ?? 0;

  if (!Number.isFinite(leaveDays) || leaveDays < 0 || !Number.isSafeInteger(leaveDays * 2)) leaveDays = 0;

  const allowance = { maximum: 31, leaveDays };
  const candidates = createVacationCandidates(context, allowance);
  const limits = { ...allowance, allowHalfDays: true };
  const ranked = candidates.map((candidate) => prepareVacation(candidate, limits)).filter(Boolean)
    .sort((a, b) => b.requiredWorkSlots - a.requiredWorkSlots);
  const scope = { ...context.workContext, allowHalfDays: true };
  let boundary;

  if (maximumWorkDays !== Infinity) boundary = getWorkBoundary(context);

  for (const candidate of ranked) {
    const windows = getWorkWindows(candidate, scope);

    if (!windows.length) continue;

    if (maximumWorkDays === Infinity) return candidate.requiredWorkSlots / 2;

    const constraints = { boundary, maximumWorkDays, allowHalfDays: true, workContext: context.workContext };
    const work = chooseWorkDays(context.days, candidate, constraints);

    if (work) return candidate.requiredWorkSlots / 2;
  }

  return 0;
}

function getWorkBoundary(context) {
  const { settings, holidays, adjustments, startDate, endDate } = context;
  const boundary = { before: 0, after: 0 };
  const adjustmentDates = adjustments.flatMap((record) => getAdjustmentRanges(record))
    .flatMap((range) => [range.startDate, range.endDate]);
  const knownDates = [
    startDate,
    endDate,
    ...Object.keys(holidays),
    ...adjustmentDates
  ].sort();
  const earliestKnown = knownDates[0];
  const latestKnown = knownDates.at(-1);
  const lowerBoundary = addDays(earliestKnown, -371);
  const upperBoundary = addDays(latestKnown, 371);

  for (const [direction, edge, key] of [[-1, startDate, 'before'], [1, endDate, 'after']]) {
    const reversePeriods = ['pm', 'am'];
    const forwardPeriods = ['am', 'pm'];
    const periods = direction < 0 ? reversePeriods : forwardPeriods;

    for (let outsideDate = addDays(edge, direction); ; outsideDate = addDays(outsideDate, direction)) {
      const day = classifyDay(outsideDate, settings, holidays, adjustments);
      let hasRest = false;

      for (const period of periods) {
        if (day.periods[period].isRest) {
          hasRest = true;
          break;
        }

        boundary[key] += 1;
      }

      if (hasRest) break;

      // 已知安排外完整覆盖最长周末周期仍无休息时段，则工作段没有有限边界。
      if (outsideDate <= lowerBoundary || outsideDate >= upperBoundary) {
        boundary[key] = Infinity;
        break;
      }
    }
  }

  return boundary;
}

/**
 * 免补班额度先扣除，计算本候选需要配对的补班总量。
 */
function prepareVacation(candidate, limits) {
  const { maximum, leaveDays, allowHalfDays } = limits;
  const step = allowHalfDays ? 1 : 2;
  const allowance = Math.floor(leaveDays * 2 / step) * step;
  const availableLeave = Math.min(allowance, candidate.rest.length);
  const availableSwap = Math.floor(maximum * 2 / step) * step;
  const requiredWorkSlots = candidate.rest.length - availableLeave;

  if (requiredWorkSlots > availableSwap) return null;

  return { ...candidate, requiredWorkSlots };
}

function createVacationCandidates(context, limits) {
  const { slots, legalStart, legalEnd } = context;
  const { maximum, leaveDays } = limits;
  const candidates = [];

  for (let start = legalStart; start >= 0; start -= 1) {
    const before = slots.slice(start, legalStart).filter((slot) => !slot.isRest);

    if (before.some((slot) => slot.protected)) break;

    for (let end = legalEnd; end < slots.length; end += 1) {
      const endOffset = end + 1;
      const rest = slots.slice(start, endOffset).filter((slot) => !slot.isRest);

      if (rest.some((slot) => slot.protected)) break;

      const neededWork = rest.length - leaveDays * 2;

      if (neededWork > maximum * 2) continue;

      const available = slots.filter((slot) => slot.isRest && !slot.protected
        && (slot.index < start || slot.index > end));

      const restByMonth = countSlotsByMonth(rest);
      candidates.push({ start, end, rest, length: end - start + 1, available, restByMonth });
    }
  }

  return candidates;
}

export function recommendVacations(options) {
  const { maximum, maximumWorkDays = Infinity, leaveDays = 0 } = options;

  if (!Number.isFinite(maximum) || maximum < 0 || maximum > 31 || !Number.isInteger(maximum * 2)
    || !Number.isFinite(leaveDays) || leaveDays < 0 || !Number.isSafeInteger(leaveDays * 2)) return [];

  if (maximumWorkDays !== Infinity
    && (!Number.isFinite(maximumWorkDays) || !Number.isSafeInteger(maximumWorkDays * 2)
      || maximumWorkDays < 0.5)) return [];

  const context = createRecommendationContext(options);

  if (!context) return [];

  const { slots, days, workContext } = context;
  const boundary = getWorkBoundary(context);
  const allowance = { maximum, leaveDays };
  const candidates = createVacationCandidates(context, allowance);

  const strategies = [
    { id: 'earliest', title: '最早放假', compare: (a, b) => a.start - b.start || b.length - a.length },
    { id: 'longest', title: '最长假期', compare: (a, b) => b.length - a.length },
    {
      id: 'shortest-work', title: '最短连续上班', prioritizeWork: true,
      rank: (a, b) => a.requiredWorkSlots - b.requiredWorkSlots || b.length - a.length,
      compare: (a, b) => b.length - a.length || a.requiredWorkSlots - b.requiredWorkSlots
    }
  ];
  const workCache = new Map();
  const fullDayCandidates = candidates.filter((candidate) => candidate.rest.every((slot, index) =>
    index % 2 === 1 || slot.period === 'am' && candidate.rest[index + 1]?.dateKey === slot.dateKey));
  const modes = [];

  if (Number.isInteger(maximum) && Number.isInteger(leaveDays)) {
    modes.push({ candidates: fullDayCandidates, allowHalfDays: false });
  }

  modes.push({ candidates, allowHalfDays: true });

  return strategies.map((strategy) => {
    const rank = strategy.rank ?? strategy.compare;
    let best = null;

    for (const mode of modes) {
      const limits = { maximum, leaveDays, allowHalfDays: mode.allowHalfDays };
      const configured = mode.candidates.map((candidate) => prepareVacation(candidate, limits)).filter(Boolean);
      const ranked = configured.sort(rank);
      let hasAdjustment = false;
      best = null;

      for (const candidate of ranked) {
        if (!strategy.prioritizeWork && best && strategy.compare(candidate, best) > 0) break;

        const key = `${mode.allowHalfDays}:${candidate.start}:${candidate.end}`;
        let work = workCache.get(key);

        if (!workCache.has(key)) {
          const constraints = { boundary, maximumWorkDays, allowHalfDays: mode.allowHalfDays, workContext };
          work = chooseWorkDays(days, candidate, constraints);

          workCache.set(key, work);
        }

        if (!work) continue;

        if (candidate.rest.length) hasAdjustment = true;

        if (strategy.prioritizeWork) {
          let vacationOrder = -1;

          if (best) vacationOrder = strategy.compare(candidate, best);

          if (!best || work.maximum < best.work.maximum
            || work.maximum === best.work.maximum && (vacationOrder < 0
              || vacationOrder === 0 && work.penalty < best.work.penalty)) {
            best = { ...candidate, work };
          }
        } else if (!best || work.maximum < best.work.maximum
          || work.maximum === best.work.maximum && work.penalty < best.work.penalty) {
          best = { ...candidate, work };
        }
      }

      // 整数额度优先整天休假；小数额度直接按半天搜索，零调班仍可保留。
      if (mode.allowHalfDays || hasAdjustment) break;
    }

    if (!best) return { id: strategy.id, title: strategy.title, unavailable: true };

    const vacationEndOffset = best.end + 1;
    const vacationSlots = slots.slice(best.start, vacationEndOffset);
    const restRanges = toRanges(best.work.swapRest, 'rest');
    const workRanges = toRanges(best.work.slots, 'work');
    const leaveRanges = toRanges(best.work.leaveRest, 'rest');

    return {
      id: strategy.id, title: strategy.title,
      vacation: toRanges(vacationSlots, 'rest')[0], vacationDays: best.length / 2,
      adjustmentDays: best.work.swapRest.length / 2, leaveDays: best.work.leaveRest.length / 2,
      longestWorkDays: best.work.maximum, leaveRanges,
      ranges: [...restRanges, ...workRanges]
    };
  });
}
