const records = {};

function add(date, kind, name) {
  records[date] = { kind, name };
}

function addHolidayBlock(startDay, endDay, name, legalDays, makeupDays) {
  const current = new Date(`${startDay}T00:00:00Z`);
  const end = new Date(`${endDay}T00:00:00Z`);

  while (current <= end) {
    const dateKey = current.toISOString().slice(0, 10);
    records[dateKey] = {
      kind: 'block',
      name,
      startDay,
      endDay,
      legalDays,
      makeupDays
    };

    current.setUTCDate(current.getUTCDate() + 1);
  }
}

addHolidayBlock('2026-01-01', '2026-01-03', '元旦', 1, 1);
add('2026-01-04', 'work', '元旦法定补班');

add('2026-02-14', 'work', '春节法定补班');
addHolidayBlock('2026-02-15', '2026-02-23', '春节', 4, 2);
records['2026-02-16'].name = '除夕';
add('2026-02-28', 'work', '春节法定补班');

addHolidayBlock('2026-04-04', '2026-04-06', '清明节', 1, 0);

addHolidayBlock('2026-05-01', '2026-05-05', '劳动节', 2, 1);
add('2026-05-09', 'work', '劳动节法定补班');

addHolidayBlock('2026-06-19', '2026-06-21', '端午节', 1, 0);

add('2026-09-20', 'work', '国庆节法定补班');
addHolidayBlock('2026-09-25', '2026-09-27', '中秋节', 1, 0);

addHolidayBlock('2026-10-01', '2026-10-07', '国庆节', 3, 2);
add('2026-10-10', 'work', '国庆节法定补班');

export const BUILT_IN_HOLIDAYS = Object.freeze(records);
