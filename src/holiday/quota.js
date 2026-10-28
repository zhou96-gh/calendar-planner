import { addDays, isBaseRestPeriod } from './core.js';
import { getLegalDayQuota } from './fetch.js';
import { getFestivalDates, prepareFestivalDates } from './festivals.js';

const quotaHolidaysCache = new Map();

/**
 * 在后台分批准备全年节日，再复用同步额度计算及缓存。
 */
export async function prepareQuotaHolidays(year, sourceYear, settings) {
  await prepareFestivalDates(year);
  return createQuotaHolidays(year, sourceYear, settings);
}

/**
 * 仅借用源年的法定额度，按本年节日及周末规则分配纯假期。
 */
export function createQuotaHolidays(year, sourceYear, settings) {
  const cacheKey = JSON.stringify([year, sourceYear, settings]);

  if (quotaHolidaysCache.has(cacheKey)) return quotaHolidaysCache.get(cacheKey);

  const festivalDates = getFestivalDates(year);
  const festivals = ['元旦', '春节', '清明节', '劳动节', '端午节', '中秋节', '国庆节'];
  const allocations = festivals.map((name) => {
    const days = getLegalDayQuota(name, sourceYear);
    const startDay = name === '春节' && days === 4 ? festivalDates['除夕'] : festivalDates[name];
    return { name, days, startDay };
  }).sort((left, right) => left.startDay.localeCompare(right.startDay));

  const holidays = {};
  allocations.forEach(({ name, days, startDay }) => {
    let dateKey = startDay;
    let remaining = days;

    while (remaining > 0) {
      const hasBaseRest = isBaseRestPeriod(dateKey, 'am', settings)
        || isBaseRestPeriod(dateKey, 'pm', settings);

      if (!hasBaseRest && !holidays[dateKey]) {
        holidays[dateKey] = { kind: 'legal', name };
        remaining -= 1;
      }

      dateKey = addDays(dateKey, 1);
    }
  });

  quotaHolidaysCache.set(cacheKey, holidays);
  return holidays;
}
