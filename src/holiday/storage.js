import {
  DEFAULT_SETTINGS,
  addDays,
  isDateKey,
  parseDate,
  sanitizeAdjustmentRecords,
  sanitizeHolidays,
  sanitizeSettings
} from './core.js';
import { transformHolidayPayload } from './fetch.js';

export const STORAGE_VERSION = 7;
const APPEARANCE_MODES = new Set(['system', 'light', 'dark']);
const COLOR_SCHEME_IDS = new Set(['default', 'custom']);
export const CUSTOM_COLOR_TOKENS = [
  'page', 'surface', 'panel', 'panel-muted',
  'header', 'header-text', 'header-muted', 'text',
  'muted', 'faint', 'toc-bg',
  'border', 'border-strong', 'control', 'hover',
  'warm-hover', 'badge-bg', 'primary', 'primary-hover',
  'primary-text', 'error-strong',
  'rest-bg', 'holiday-bg', 'manual-rest-bg', 'manual-work-bg',
  'green', 'red', 'purple', 'gold',
  'stripe',
  'tag-work-bg', 'tag-suggestion-bg', 'tag-holiday-bg', 'preview-bg',
  'preview-error-bg', 'tag-neutral-bg'
];
const REQUIRED_ALPHA_COLOR_TOKENS = new Set(['toc-bg', 'stripe', 'tag-neutral-bg']);
export const ALPHA_COLOR_TOKENS = new Set([
  ...REQUIRED_ALPHA_COLOR_TOKENS, 'rest-bg', 'holiday-bg', 'manual-rest-bg', 'manual-work-bg'
]);

function sanitizeCustomColors(value) {
  const result = { light: {}, dark: {} };
  for (const mode of ['light', 'dark']) {
    const colors = value?.[mode];
    if (!colors || typeof colors !== 'object' || Array.isArray(colors)) {
      continue;
    }
    for (const token of CUSTOM_COLOR_TOKENS) {
      const pattern = REQUIRED_ALPHA_COLOR_TOKENS.has(token) ? /^#[0-9a-f]{8}$/i
        : ALPHA_COLOR_TOKENS.has(token) ? /^#[0-9a-f]{6}([0-9a-f]{2})?$/i : /^#[0-9a-f]{6}$/i;
      if (typeof colors[token] === 'string' && pattern.test(colors[token])) {
        result[mode][token] = colors[token].toLowerCase();
      }
    }
  }
  return result;
}

export function decodeCustomColorsImport(imported) {
  const colors = imported && typeof imported === 'object' && Object.hasOwn(imported, 'customColors')
    ? imported.customColors : imported;
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)
    || !['light', 'dark'].every((mode) => colors[mode] && typeof colors[mode] === 'object'
      && !Array.isArray(colors[mode]))) {
    throw new Error('配色方案需包含浅色和深色配置');
  }

  const result = sanitizeCustomColors(colors);
  for (const mode of ['light', 'dark']) {
    for (const token of CUSTOM_COLOR_TOKENS) {
      if (Object.hasOwn(colors[mode], token) && !Object.hasOwn(result[mode], token)) {
        throw new Error(`无效配色：${mode}.${token}`);
      }
    }
  }
  if (Object.keys(result.light).length + Object.keys(result.dark).length === 0
    && (Object.keys(colors.light).length || Object.keys(colors.dark).length)) {
    throw new Error('配色方案中没有可识别的颜色');
  }
  return result;
}

function sanitizeAppearance(value) {
  return APPEARANCE_MODES.has(value) ? value : 'system';
}

function sanitizeLayoutDensity(value) {
  return value === 'compact' ? 'compact' : 'spacious';
}

function sanitizeColorSchemeId(id) {
  return COLOR_SCHEME_IDS.has(id) || typeof id === 'string'
    && /^[a-z0-9][a-z0-9-]*\.json$/.test(id) ? id : 'default';
}

function sanitizeLoadedYears(years) {
  if (!Array.isArray(years)) {
    return [];
  }

  return [...new Set(years.filter((year) => Number.isInteger(year)
    && year >= 1900 && year <= 2200))].sort();
}

export function encodeState(state) {
  return {
    version: STORAGE_VERSION,
    settings: state.settings,
    appearance: sanitizeAppearance(state.appearance),
    layoutDensity: sanitizeLayoutDensity(state.layoutDensity),
    colorSchemeId: sanitizeColorSchemeId(state.colorSchemeId),
    customColors: sanitizeCustomColors(state.customColors),
    holidayData: encodeHolidays(state.holidays),
    loadedYears: state.loadedYears,
    adjustments: sanitizeAdjustmentRecords(state.adjustments)
  };
}

export function decodeState(stored) {
  if (stored?.version !== STORAGE_VERSION) {
    throw new Error('不支持的数据版本');
  }

  return {
    version: STORAGE_VERSION,
    settings: sanitizeSettings(stored.settings ?? DEFAULT_SETTINGS),
    appearance: sanitizeAppearance(stored.appearance),
    layoutDensity: sanitizeLayoutDensity(stored.layoutDensity),
    colorSchemeId: sanitizeColorSchemeId(stored.colorSchemeId),
    customColors: sanitizeCustomColors(stored.customColors),
    holidays: decodeHolidays(stored.holidayData),
    loadedYears: sanitizeLoadedYears(stored.loadedYears ?? [2026]),
    adjustments: sanitizeAdjustmentRecords(stored.adjustments)
  };
}

export { sanitizeLoadedYears };

/**
 * 只读取假期安排；完整旧备份中的设置、配色和调班不参与导入。
 */
export function decodeHolidayImport(imported) {
  if (imported?.year !== undefined && Array.isArray(imported.days)) {
    const year = Number(imported.year);

    if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error('假期年份无效');

    const holidays = transformHolidayPayload(imported, year);
    return { holidays, loadedYears: [year] };
  }

  if (imported?.version !== STORAGE_VERSION) throw new Error('不支持的数据版本');

  const holidays = decodeHolidays(imported.holidayData);
  const dateYears = Object.keys(holidays).map((dateKey) => Number(dateKey.slice(0, 4)));
  const declaredYears = imported.loadedYears ?? [];

  if (dateYears.length === 0) throw new Error('文件中没有有效的假期安排');

  if (!Array.isArray(declaredYears)) throw new Error('假期年份格式无效');

  const allYears = [...declaredYears, ...dateYears];
  const validYears = sanitizeLoadedYears(allYears);

  if (allYears.some((year) => !validYears.includes(year))) {
    throw new Error('假期数据必须包含 1900 至 2200 年的有效年份');
  }

  // 已载入年份可能没有剩余日期，不据此删除本地对应年份的安排。
  const loadedYears = sanitizeLoadedYears(dateYears);
  return { holidays, loadedYears };
}

/**
 * 按导入文件涉及的年份整体替换安排，保留其他年份和个人配置。
 */
export function replaceHolidayYears(state, imported) {
  const retainedHolidays = Object.entries(state.holidays).filter(([dateKey]) => {
    const year = Number(dateKey.slice(0, 4));
    return !imported.loadedYears.includes(year);
  });

  const holidays = { ...Object.fromEntries(retainedHolidays), ...imported.holidays };
  const years = [...state.loadedYears, ...imported.loadedYears];
  const loadedYears = sanitizeLoadedYears(years);
  return { ...state, holidays, loadedYears };
}

export function encodeHolidays(holidays) {
  const blocks = new Map();
  const days = {};

  Object.entries(holidays).forEach(([dateKey, holiday]) => {
    if (holiday.kind !== 'block') {
      days[dateKey] = holiday;
      return;
    }

    const key = JSON.stringify([
      holiday.startDay,
      holiday.endDay,
      holiday.name,
      holiday.legalDays,
      holiday.makeupDays
    ]);
    if (!blocks.has(key)) {
      blocks.set(key, { ...holiday, dates: [] });
    }
    blocks.get(key).dates.push(dateKey);
  });

  return {
    blocks: [...blocks.values()].map((block) => {
      const dates = block.dates.sort();
      const expectedDays = Math.round(
        (parseDate(block.endDay) - parseDate(block.startDay)) / (24 * 60 * 60 * 1000)
      ) + 1;
      const { kind, ...fields } = block;
      if (dates.length === expectedDays && dates[0] === block.startDay
        && dates.at(-1) === block.endDay) {
        const { dates: unusedDates, ...fullBlock } = fields;
        return fullBlock;
      }

      return fields;
    }),
    days
  };
}

export function decodeHolidays(data) {
  if (!data || !Array.isArray(data.blocks)
    || !data.days || typeof data.days !== 'object' || Array.isArray(data.days)) {
    throw new Error('节假日存储格式无效');
  }

  const holidays = {};
  data.blocks.forEach((block) => {
    if (!isDateKey(block.startDay) || !isDateKey(block.endDay)
      || block.endDay < block.startDay) {
      throw new Error('节假日区间无效');
    }

    const dates = [];
    if (block.dates === undefined) {
      let dateKey = block.startDay;
      while (dateKey <= block.endDay && dates.length <= 366) {
        dates.push(dateKey);
        dateKey = addDays(dateKey, 1);
      }
    } else if (Array.isArray(block.dates)) {
      dates.push(...block.dates);
    } else {
      throw new Error('节假日区间日期无效');
    }

    if (dates.length === 0 || dates.length > 366
      || dates.some((dateKey) => !isDateKey(dateKey)
        || dateKey < block.startDay || dateKey > block.endDay)) {
      throw new Error('节假日区间日期无效');
    }

    dates.forEach((dateKey) => {
      holidays[dateKey] = {
        kind: 'block',
        name: block.name,
        startDay: block.startDay,
        endDay: block.endDay,
        legalDays: block.legalDays,
        makeupDays: block.makeupDays
      };
    });
  });

  return sanitizeHolidays({ ...holidays, ...data.days });
}
