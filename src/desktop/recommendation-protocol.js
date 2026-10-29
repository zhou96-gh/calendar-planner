export const RECOMMENDATION_WINDOW = 'vacation-recommendations';

/**
 * 独立窗口只回传配置和方案标识，主窗口重新计算，不接受外部排班数据。
 */
export function isRecommendationAction(action) {
  if (!action || !Number.isSafeInteger(action.session) || action.session < 1
    || !Number.isSafeInteger(action.sequence) || action.sequence < 1) return false;

  if (action.kind === 'close') return true;

  if (action.kind === 'cancel') return typeof action.value === 'string' && action.value.length > 0 && action.value.length <= 80;

  if (action.kind === 'use' && !['earliest', 'longest', 'shortest-work'].includes(action.value)) return false;

  if (!['configure', 'use'].includes(action.kind)) return false;

  const values = action.values;

  if (!values) return false;

  return typeof values.maximum === 'string' && values.maximum.length <= 32
    && typeof values.leaveDays === 'string' && values.leaveDays.length <= 32
    && typeof values.workMaximum === 'string' && values.workMaximum.length <= 32
    && typeof values.crossMonth === 'boolean'
    && typeof values.maximumBadInput === 'boolean' && typeof values.workMaximumBadInput === 'boolean'
    && typeof values.leaveBadInput === 'boolean';
}
