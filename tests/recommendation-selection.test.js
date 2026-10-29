import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings } from '../src/holiday/core.js';
import { decodeState, encodeState } from '../src/holiday/storage.js';
import { decodeDesktopState, encodeDesktopState, sanitizeDesktop } from '../src/platforms/desktop-state.js';
import {
  getVacationRecordGroup, getVacationReplacementRecords, getVacationSelection
} from '../src/holiday/recommendation-selection.js';

const holiday = { dateKey: '2026-10-14', endDate: '2026-10-14' };
const groupId = 'rec|2026-10-14|2026-10-14|shortest-work|12345678-1234-1234-1234-123456789012';
const rest = { type: 'rest', startDate: '2026-10-13', endDate: '2026-10-13', startPeriod: 'am', endPeriod: 'pm' };
const main = { id: `${groupId}|m`, ranges: [rest], associationType: 'required', note: '最短连续上班', createdAt: 1 };
const leave = { ...main, id: `${groupId}|l`, associationType: 'none', note: '假期（无需补班）' };

const testSelectionRoundTrip = () => {
  const calendar = encodeState({ settings: sanitizeSettings(), holidays: {}, loadedYears: [], adjustments: [main, leave] });
  const publicState = decodeState(calendar);
  const extension = sanitizeDesktop();
  const schemes = new Map();
  const desktop = encodeDesktopState(calendar, extension, schemes);
  const desktopState = decodeDesktopState(desktop);
  const restored = decodeState(desktopState.calendar);

  for (const state of [publicState, restored]) {
    const selected = getVacationSelection(state.adjustments, holiday);
    assert.equal(selected.groupId, groupId);
    assert.equal(selected.planId, 'shortest-work');
    assert.equal(selected.records.length, 2);
    const ids = selected.records.map((record) => record.id);
    const expected = [main.id, leave.id];
    assert.deepEqual(ids, expected);
    assert.ok(ids.every((id) => id.length <= 80));
  }
};

const testSelectionIdentity = () => {
  for (const id of ['manual', 'rec|bad|bad|earliest|id|m', `${groupId}|unknown`, `${groupId}|m|extra`]) {
    const group = getVacationRecordGroup(id);
    assert.equal(group, '');
  }

  const manual = { ...main, id: 'manual' };
  const other = { ...holiday, dateKey: '2026-10-15' };
  const manualRecords = [manual];
  const recommendedRecords = [main, leave];
  const unselected = getVacationSelection(manualRecords, holiday);
  const otherHoliday = getVacationSelection(recommendedRecords, other);
  assert.equal(unselected, null);
  assert.equal(otherHoliday, null);
};

const testReplacementSnapshot = () => {
  const manual = { ...main, id: 'manual' };
  const records = [manual, main, leave];
  const original = structuredClone(records);
  const selection = { ...holiday, previousRecords: [main, leave] };
  const remaining = getVacationReplacementRecords(records, selection);
  const expected = [manual];
  assert.deepEqual(remaining, expected);
  assert.deepEqual(records, original);
  const manualRecords = [manual];
  const cancelled = () => getVacationReplacementRecords(manualRecords, selection);
  assert.throws(cancelled, /发生变化/);
  const changedMain = { ...main, note: '已修改' };
  const changedRecords = [manual, changedMain, leave];
  const changed = () => getVacationReplacementRecords(changedRecords, selection);
  assert.throws(changed, /发生变化/);
  const empty = { ...holiday, previousRecords: [] };
  const superseded = () => getVacationReplacementRecords(records, empty);
  assert.throws(superseded, /发生变化/);
};

test('推荐分组ID符合80字符限制，公共及桌面备份往返后仍可整体识别', testSelectionRoundTrip);
test('普通调班不凭备注归入推荐，分组仅识别完整合法的来源ID', testSelectionIdentity);
test('替换仅移除原推荐组，旧方案改变或取消后拒绝过期替换', testReplacementSnapshot);
