import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchHolidayYear, HolidayDataUnavailableError, transformHolidayPayload, transformShuyzPayload } from '../src/holiday/fetch.js';
import { DEFAULT_SETTINGS, classifyDay } from '../src/holiday/core.js';
import { decodeHolidays, encodeHolidays } from '../src/holiday/storage.js';

const payload = {
  year: 2026,
  days: [
    ...Array.from({ length: 7 }, (_, index) => ({
      name: '国庆节',
      date: `2026-10-0${index + 1}`,
      isOffDay: true
    })),
    { name: '国庆节', date: '2026-09-20', isOffDay: false },
    { name: '国庆节', date: '2026-10-10', isOffDay: false }
  ]
};

test('远端年度数据会转换为法定区间和法定补班日', () => {
  const records = transformHolidayPayload(payload, 2026);
  assert.deepEqual(records['2026-09-20'], { kind: 'work', name: '国庆节法定补班' });
  assert.equal(records['2026-10-01'].kind, 'block');
  assert.equal(records['2026-10-01'].legalDays, 3);
  assert.equal(records['2026-10-01'].makeupDays, 2);
});

test('远端数据转换后继续遵守大小休显示规则', () => {
  const records = transformHolidayPayload(payload, 2026);
  const settings = {
    ...DEFAULT_SETTINGS,
    anchorMonday: '2026-09-14'
  };
  assert.equal(classifyDay('2026-10-03', settings, records).category, 'schedule-rest');
  const holiday = classifyDay('2026-10-05', settings, records);
  assert.equal(holiday.category, 'schedule-rest');
  assert.deepEqual(holiday.officialLabels, ['放假']);
  const suggestedRest = classifyDay('2026-10-06', settings, records);
  assert.equal(suggestedRest.category, 'regular-work');
  assert.deepEqual(suggestedRest.officialLabels, ['法定调休']);
});

test('错误年份数据会被拒绝', () => {
  assert.throws(() => transformHolidayPayload({ ...payload, year: 2025 }, 2026), /格式无效/);
});

const shuyzHoliday = {
  Name: '国庆节',
  StartDate: '2026-10-01',
  EndDate: '2026-10-07',
  Duration: 7,
  CompDays: ['2026-09-20', '2026-10-10']
};

const shuyzPayload = { Years: { 2026: [shuyzHoliday] } };

const testDirectSource = async () => {
  const attempts = [];
  const fakeFetch = async (url, options) => {
    attempts.push({ url, signal: options.signal });
    return { ok: true, json: async () => shuyzPayload };
  };

  const records = await fetchHolidayYear(2026, fakeFetch);
  const expected = transformHolidayPayload(payload, 2026);
  assert.deepEqual(records, expected);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].url, 'https://www.shuyz.com/githubfiles/china-holiday-calender/master/holidayAPI.json');
  assert.equal(attempts[0].signal.aborted, true);

  const configUrl = new URL('../src-tauri/tauri.conf.json', import.meta.url);
  const rawConfig = readFileSync(configUrl, 'utf8');
  const config = JSON.parse(rawConfig);
  const permittedSources = config.app.security.csp.split(' ');
  const origin = new URL(attempts[0].url).origin;
  assert.ok(permittedSources.includes(origin));
};

const testMissingYear = async () => {
  const inputs = [{ Years: {} }, { Years: { 2027: [] } }];

  for (const input of inputs) {
    const fakeFetch = async () => ({ ok: true, json: async () => input });
    const getYear = () => fetchHolidayYear(2027, fakeFetch);
    await assert.rejects(getYear, HolidayDataUnavailableError);
  }
};

const testSourceFailure = async () => {
  for (const status of [404, 503]) {
    const fakeFetch = async () => ({ ok: false, status });
    const getYear = () => fetchHolidayYear(2027, fakeFetch);
    const check = (error) => !(error instanceof HolidayDataUnavailableError) && error.message.includes(status);
    await assert.rejects(getYear, check);
  }
};

const testStalledSource = async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  const never = new Promise(() => {});

  for (const phase of ['request', 'json']) {
    const fakeFetch = async (_url, options) => {
      signals.push(options.signal);

      if (phase === 'request') return never;

      return { ok: true, json: () => never };
    };

    const pending = fetchHolidayYear(2026, fakeFetch);
    const check = (error) => !(error instanceof HolidayDataUnavailableError) && error.message.includes('超时');
    const rejected = assert.rejects(pending, check);
    context.mock.timers.tick(5000);
    await rejected;
  }

  const allAborted = signals.every((signal) => signal.aborted);
  assert.equal(signals.length, 2);
  assert.ok(allAborted);
};

const testCombinedHoliday = () => {
  const holiday = {
    Name: '国庆节、中秋节',
    StartDate: '2025-10-01',
    EndDate: '2025-10-08',
    Duration: 8,
    CompDays: ['2025-09-28', '2025-10-11']
  };

  const input = { Years: { 2025: [holiday] } };
  const records = transformShuyzPayload(input, 2025);
  assert.equal(records['2025-10-01'].legalDays, 4);
  assert.equal(records['2025-10-08'].makeupDays, 2);
  assert.equal(records['2025-10-11'].kind, 'work');
};

const testCrossYearHoliday = () => {
  const holiday = {
    Name: '元旦',
    StartDate: '2022-12-30',
    EndDate: '2023-01-02',
    Duration: 4,
    CompDays: ['2022-12-25', '2023-01-07']
  };

  const input = { Years: { 2023: [holiday] } };
  const records = transformShuyzPayload(input, 2023);
  const day = classifyDay('2023-01-02', DEFAULT_SETTINGS, records);
  const encoded = encodeHolidays(records);
  const restored = decodeHolidays(encoded);
  assert.equal(records['2022-12-30'], undefined);
  assert.equal(records['2022-12-25'], undefined);
  assert.equal(records['2023-01-01'].startDay, '2022-12-30');
  assert.equal(records['2023-01-01'].makeupDays, 2);
  assert.equal(records['2023-01-07'].kind, 'work');
  assert.equal(day.isPureLegal, false);
  assert.deepEqual(restored, records);
};

const testInvalidSource = () => {
  const inputs = [
    {},
    { Years: [] },
    { Years: { 2026: {} } },
    { Years: { 2026: [{ ...shuyzHoliday, Duration: 1 }] } },
    { Years: { 2026: [{ ...shuyzHoliday, StartDate: '2026-02-30' }] } },
    { Years: { 2026: [{ ...shuyzHoliday, CompDays: ['invalid'] }] } },
    { Years: { 2026: [null] } },
    { Years: { 2025: [shuyzHoliday] } },
    { Years: { 2026: [shuyzHoliday, shuyzHoliday] } }
  ];

  inputs.forEach((input) => {
    const year = Object.hasOwn(input.Years ?? {}, 2025) ? 2025 : 2026;
    const read = () => transformShuyzPayload(input, year);
    const check = (error) => !(error instanceof HolidayDataUnavailableError);
    assert.throws(read, check);
  });
};

test('在线仅请求 ShuYZ 网站直连地址，并转换为原有年度存储契约', testDirectSource);
test('ShuYZ 缺失或空年度可识别为数据源暂无安排', testMissingYear);
test('全年集合文件 404 和服务异常不能冒充年度未收录', testSourceFailure);
test('请求或 JSON 解析卡住均会超时并中止请求', testStalledSource);
test('合并假期保留同一段区间，并合计各节日法定额度', testCombinedHoliday);
test('跨年假期保留完整跨度及补班数量，只保存本年日期且不重复分配法定额度', testCrossYearHoliday);
test('畸形集合、区间、日期及冲突数据不会作为有效年度保存', testInvalidSource);
