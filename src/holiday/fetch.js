import { addDays, isDateKey } from './core.js';

const HOLIDAY_SOURCE = 'https://www.shuyz.com/githubfiles/china-holiday-calender/master/holidayAPI.json';

/**
 * 年度安排尚未提供，与网络故障、服务异常及数据格式错误区分。
 */
export class HolidayDataUnavailableError extends Error {
  constructor(year) {
    super(`${year} 年数据源暂未提供假期安排`);
    this.name = 'HolidayDataUnavailableError';
  }
}

export function getLegalDayQuota(name, year) {
  const quotas = [
    ['元旦', 1],
    ['春节', year >= 2025 ? 4 : 3],
    ['清明', 1],
    ['劳动', year >= 2025 ? 2 : 1],
    ['端午', 1],
    ['中秋', 1],
    ['国庆', 3]
  ];

  return quotas.reduce((total, [keyword, days]) => total + (name.includes(keyword) ? days : 0), 0);
}

function splitConsecutiveDates(dates) {
  return dates.sort().reduce((groups, dateKey) => {
    const group = groups.at(-1);
    if (!group || addDays(group.at(-1), 1) !== dateKey) {
      groups.push([dateKey]);
    } else {
      group.push(dateKey);
    }
    return groups;
  }, []);
}

export function transformHolidayPayload(payload, requestedYear) {
  if (Number(payload?.year) !== requestedYear || !Array.isArray(payload?.days)) {
    throw new Error('节假日数据格式无效');
  }

  const records = {};
  const offDatesByName = new Map();
  const workDaysByName = new Map();

  payload.days.forEach((day) => {
    if (!day || !isDateKey(day.date) || !day.date.startsWith(`${requestedYear}-`) || typeof day.name !== 'string') {
      return;
    }

    if (day.isOffDay === true) {
      const dates = offDatesByName.get(day.name) ?? [];
      dates.push(day.date);
      offDatesByName.set(day.name, dates);
      return;
    }

    if (day.isOffDay === false) {
      records[day.date] = { kind: 'work', name: `${day.name}法定补班` };
      workDaysByName.set(day.name, (workDaysByName.get(day.name) ?? 0) + 1);
    }
  });

  offDatesByName.forEach((dates, name) => {
    const groups = splitConsecutiveDates(dates);
    let remainingLegalDays = getLegalDayQuota(name, requestedYear);
    let remainingMakeupDays = workDaysByName.get(name) ?? 0;

    groups.forEach((group, index) => {
      const isLastGroup = index === groups.length - 1;
      const legalDays = Math.min(remainingLegalDays, group.length);
      const makeupDays = isLastGroup ? remainingMakeupDays : 0;
      const startDay = group[0];
      const endDay = group.at(-1);

      group.forEach((dateKey) => {
        records[dateKey] = { kind: 'block', name, startDay, endDay, legalDays, makeupDays };
      });

      remainingLegalDays -= legalDays;
      if (isLastGroup) {
        remainingMakeupDays = 0;
      }
    });
  });

  if (Object.keys(records).length === 0) {
    throw new HolidayDataUnavailableError(requestedYear);
  }

  return records;
}

/**
 * ShuYZ 按完整假期区间计算额度，仅保存请求年份的日期键，避免改写相邻年份。
 */
export function transformShuyzPayload(payload, requestedYear) {
  if (!payload?.Years || typeof payload.Years !== 'object' || Array.isArray(payload.Years)) {
    throw new Error('ShuYZ 节假日数据格式无效');
  }

  if (!Object.hasOwn(payload.Years, requestedYear)) throw new HolidayDataUnavailableError(requestedYear);

  const holidays = payload.Years[requestedYear];

  if (!Array.isArray(holidays)) throw new Error('ShuYZ 年度安排格式无效');

  if (holidays.length === 0) throw new HolidayDataUnavailableError(requestedYear);

  const records = {};
  const yearStart = `${requestedYear}-01-01`;
  const yearEnd = `${requestedYear}-12-31`;

  holidays.forEach((holiday) => {
    if (!holiday || typeof holiday.Name !== 'string' || !holiday.Name.trim()
      || !isDateKey(holiday.StartDate) || !isDateKey(holiday.EndDate)
      || !Number.isInteger(holiday.Duration) || holiday.Duration < 1 || holiday.Duration > 366
      || !Array.isArray(holiday.CompDays) || !holiday.CompDays.every(isDateKey)) {
      throw new Error('ShuYZ 假期区间格式无效');
    }

    const startDay = holiday.StartDate;
    const endDay = holiday.EndDate;
    const durationOffset = holiday.Duration - 1;
    const expectedEnd = addDays(startDay, durationOffset);

    if (endDay !== expectedEnd || endDay < yearStart || startDay > yearEnd) {
      throw new Error('ShuYZ 假期区间与年份不符');
    }

    const name = holiday.Name;
    const quota = getLegalDayQuota(name, requestedYear);
    const legalDays = Math.min(quota, holiday.Duration);
    const makeupDates = [...new Set(holiday.CompDays)];
    const makeupDays = makeupDates.length;
    const firstDay = startDay < yearStart ? yearStart : startDay;
    const lastDay = endDay > yearEnd ? yearEnd : endDay;

    for (let dateKey = firstDay; dateKey <= lastDay; dateKey = addDays(dateKey, 1)) {
      if (Object.hasOwn(records, dateKey)) throw new Error('ShuYZ 假期日期冲突');

      records[dateKey] = { kind: 'block', name, startDay, endDay, legalDays, makeupDays };
    }

    makeupDates.forEach((dateKey) => {
      if (dateKey < yearStart || dateKey > yearEnd) return;

      if (Object.hasOwn(records, dateKey)) throw new Error('ShuYZ 假期日期冲突');

      records[dateKey] = { kind: 'work', name: `${name}法定补班` };
    });
  });

  return records;
}

/**
 * 直连 ShuYZ 网站，覆盖请求与解析的超时，结束后取消未完成的网络操作。
 */
export async function fetchHolidayYear(year, fetchImplementation = fetch) {
  const controller = new AbortController();
  let timer;

  const deadline = new Promise((_resolve, reject) => {
    const onTimeout = () => {
      reject(new Error(`${year} 年假期数据请求超时`));
      controller.abort();
    };

    timer = setTimeout(onTimeout, 5000);
  });

  const request = async () => {
    const options = { cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal };
    const response = await fetchImplementation(HOLIDAY_SOURCE, options);

    if (!response.ok) throw new Error(`数据源返回 ${response.status}`);

    const payload = await response.json();
    return transformShuyzPayload(payload, year);
  };

  try {
    const attempts = [request(), deadline];
    return await Promise.race(attempts);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
