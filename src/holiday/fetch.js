import { addDays, isDateKey } from './core.js';

const HOLIDAY_SOURCES = [
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json',
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json'
];

/**
 * 年度安排尚未提供，与网络故障、服务异常及数据格式错误区分。
 */
export class HolidayDataUnavailableError extends Error {
  constructor(year) {
    super(`${year} 年暂无官方假期安排`);
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
 * 多源并发读取，首个有效年度胜出；单源超时不阻塞备用源，完成后取消其余请求。
 */
export async function fetchHolidayYear(year, fetchImplementation = fetch) {
  const yearValue = String(year);
  const controllers = [];
  const timers = [];

  const load = (source) => {
    const controller = new AbortController();
    controllers.push(controller);
    let timer;

    const deadline = new Promise((_resolve, reject) => {
      const onTimeout = () => {
        reject(new Error(`${year} 年假期数据请求超时`));
        controller.abort();
      };

      timer = setTimeout(onTimeout, 5000);
      timers.push(timer);
    });

    const request = async () => {
      const url = source.replace('{year}', yearValue);
      const options = { cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal };
      const response = await fetchImplementation(url, options);

      if (response.status === 404) throw new HolidayDataUnavailableError(year);

      if (!response.ok) throw new Error(`数据源返回 ${response.status}`);

      const payload = await response.json();
      return transformHolidayPayload(payload, year);
    };

    const pending = request();
    const attempts = [pending, deadline];
    return Promise.race(attempts).finally(() => clearTimeout(timer));
  };

  const requests = HOLIDAY_SOURCES.map(load);

  try {
    return await Promise.any(requests);
  } catch (error) {
    const unavailable = error.errors.find((item) => item instanceof HolidayDataUnavailableError);

    if (unavailable) throw unavailable;

    const lastError = error.errors.at(-1);
    throw new Error(lastError?.message || '节假日数据获取失败');
  } finally {
    timers.forEach((timer) => clearTimeout(timer));
    controllers.forEach((controller) => controller.abort());
  }
}
