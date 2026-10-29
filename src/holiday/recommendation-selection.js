import { isDateKey } from './core.js';

/**
 * 推荐来源保存在操作 ID 中，两类记录共用前缀，兼容现有两端存储及备份。
 * 最长方案名加标准 UUID 和角色后缀不超过操作 ID 的 80 字符限制。
 */
export function getVacationRecordGroup(id) {
  const parts = id.split('|');

  if (parts.length !== 6 || parts[0] !== 'rec' || !isDateKey(parts[1]) || !isDateKey(parts[2])
    || parts[2] < parts[1] || !['earliest', 'longest', 'shortest-work'].includes(parts[3])
    || !parts[4] || !['m', 'l'].includes(parts[5])) return '';

  return parts.slice(0, 5).join('|');
}

export function getVacationSelection(adjustments, holiday) {
  const prefix = `rec|${holiday.dateKey}|${holiday.endDate}|`;
  const records = adjustments.filter((record) => record.id.startsWith(prefix) && getVacationRecordGroup(record.id));

  if (!records.length) return null;

  const latest = [...records].sort((a, b) => b.createdAt - a.createdAt)[0];
  const groupId = getVacationRecordGroup(latest.id);
  const planId = groupId.split('|')[3];
  const grouped = records.filter((record) => getVacationRecordGroup(record.id) === groupId);
  return { groupId, planId, records: grouped };
}

/**
 * 确认更换前校对旧方案，避免编辑期间的取消或其他修改被过期表单覆盖。
 */
export function getVacationReplacementRecords(adjustments, selection) {
  if (!selection) return adjustments;

  const current = getVacationSelection(adjustments, selection);
  const records = current?.records ?? [];
  const currentSnapshot = JSON.stringify(records);
  const previousSnapshot = JSON.stringify(selection.previousRecords);

  if (currentSnapshot !== previousSnapshot) throw new Error('已采用的方案发生变化，请重新打开推荐并选择');

  const ids = new Set(records.map((record) => record.id));
  return adjustments.filter((record) => !ids.has(record.id));
}
