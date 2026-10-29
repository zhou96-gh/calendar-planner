import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchHolidayYear, HolidayDataUnavailableError, transformHolidayPayload } from '../src/holiday/fetch.js';
import { DEFAULT_SETTINGS, classifyDay } from '../src/holiday/core.js';

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

test('主数据源失败时会使用备用地址', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 503 };
    }

    return { ok: true, json: async () => payload };
  };

  const records = await fetchHolidayYear(2026, fakeFetch);
  assert.equal(calls, 2);
  assert.equal(records['2026-10-01'].kind, 'block');
});

test('错误年份数据会被拒绝', () => {
  assert.throws(() => transformHolidayPayload({ ...payload, year: 2025 }, 2026), /格式无效/);
});

const testEmptyYear = async () => {
  let calls = 0;
  const empty = { year: 2027, days: [] };
  const fakeFetch = async () => {
    calls += 1;

    if (calls === 1) return { ok: true, json: async () => empty };

    return { ok: false, status: 503 };
  };

  const getYear = () => fetchHolidayYear(2027, fakeFetch);
  await assert.rejects(getYear, HolidayDataUnavailableError);
};

test('主源确认空年度后，备用源故障不会掩盖暂无安排的状态', testEmptyYear);

const testMissingYear = async () => {
  const fakeFetch = async () => ({ ok: false, status: 404 });
  const getYear = () => fetchHolidayYear(2027, fakeFetch);
  await assert.rejects(getYear, HolidayDataUnavailableError);
};

test('年度文件 404 可识别为暂无官方安排', testMissingYear);

const testServiceFailure = async () => {
  const fakeFetch = async () => ({ ok: false, status: 503 });
  const getYear = () => fetchHolidayYear(2027, fakeFetch);
  const checkError = (error) => !(error instanceof HolidayDataUnavailableError) && error.message.includes('503');
  await assert.rejects(getYear, checkError);
};

test('服务器错误不被误判为暂无官方安排', testServiceFailure);

const testSlowPrimary = async () => {
  const attempts = [];
  let rejectPrimary;
  const primary = new Promise((resolve, reject) => { rejectPrimary = reject; });
  const fakeFetch = (url, options) => {
    attempts.push({ url, signal: options.signal });

    if (url.includes('raw.githubusercontent.com')) return primary;

    return Promise.resolve({ ok: true, json: async () => payload });
  };

  const records = await fetchHolidayYear(2026, fakeFetch);
  assert.equal(attempts.length, 2);
  assert.equal(records['2026-10-01'].kind, 'block');
  assert.equal(attempts[0].signal.aborted, true);
  rejectPrimary(new Error('慢源稍后失败'));
  await Promise.resolve();
};

const testStalledSources = async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  const never = new Promise(() => {});
  const fakeFetch = async (url, options) => {
    signals.push(options.signal);

    if (url.includes('raw.githubusercontent.com')) {
      return new Promise((_resolve, reject) => {
        const onAbort = () => reject(new Error('模拟请求被中止'));
        options.signal.addEventListener('abort', onAbort);
      });
    }

    return { ok: true, json: () => never };
  };

  const pending = fetchHolidayYear(2026, fakeFetch);
  const check = (error) => !(error instanceof HolidayDataUnavailableError) && error.message.includes('超时');
  const rejected = assert.rejects(pending, check);
  context.mock.timers.tick(5000);
  await rejected;
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
};

const testUnavailablePrimary = async () => {
  const fakeFetch = async (url) => {
    if (url.includes('raw.githubusercontent.com')) return { ok: false, status: 404 };

    return { ok: true, json: async () => payload };
  };

  const records = await fetchHolidayYear(2026, fakeFetch);
  assert.equal(records['2026-10-01'].kind, 'block');
};

test('主源一直等待时备用源可独立完成，结束后取消慢源且接住迟到失败', testSlowPrimary);
test('请求或响应解析一直等待时均会超时，并保持网络错误分类', testStalledSources);
test('单源404不能抢先覆盖另一数据源的有效年度安排', testUnavailablePrimary);
