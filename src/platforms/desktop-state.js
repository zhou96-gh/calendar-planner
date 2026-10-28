import { BUILT_IN_HOLIDAYS } from '../holiday/data.js';
import { isDateKey, sanitizeHolidays, sanitizeSettings } from '../holiday/core.js';
import { decodeCustomColorsImport, decodeState, encodeState } from '../holiday/storage.js';
import { getPalette } from '../holiday/appearance.js';

export const DESKTOP_VERSION = 12;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 拒绝损坏备份的容器和范围，避免清洗后把错误数据当成合法空快照。
 */
function validateRange(range) {
  if (!isRecord(range) || !['rest', 'work'].includes(range.type)
    || !isDateKey(range.startDate) || !isDateKey(range.endDate)
    || !['am', 'pm'].includes(range.startPeriod) || !['am', 'pm'].includes(range.endPeriod)
    || range.endDate < range.startDate
    || (range.startDate === range.endDate && range.startPeriod === 'pm' && range.endPeriod === 'am')) {
    throw new Error('调班日期范围格式不正确');
  }
}

/**
 * 桌面扩展只保存待办及挂件外观，不混入公共业务设置。
 */
export function sanitizeDesktop(value = {}) {
  const todos = value.todos ?? [];

  if (!Array.isArray(todos)) throw new Error('待办格式不正确');

  const ids = new Set();
  const normalized = todos.map((todo) => {
    if (!todo || typeof todo.id !== 'string' || !todo.id || ids.has(todo.id)
      || !isDateKey(todo.date) || typeof todo.text !== 'string' || !todo.text.trim()
      || typeof todo.done !== 'boolean' || !Number.isInteger(todo.createdAt) || todo.createdAt < 1) {
      throw new Error('待办记录格式不正确');
    }

    ids.add(todo.id);
    return { id: todo.id, date: todo.date, text: todo.text, done: todo.done, createdAt: todo.createdAt };
  });

  const appearance = value.appearance ?? value;
  const limits = {
    backgroundTransparency: [0, 100, 30],
    brightness: [70, 130, 100],
    fontSizeOffset: [0, 3, 0]
  };

  const configured = {};

  for (const [field, [minimum, maximum, fallback]] of Object.entries(limits)) {
    const input = appearance[field];
    configured[field] = Number.isInteger(input) ? Math.max(minimum, Math.min(maximum, input)) : fallback;
  }

  return { todos: normalized, appearance: configured };
}

/**
 * v12 是完整日期快照；只有显式导入旧 v11 备份才铺入旧版内置数据。
 */
export function decodeDesktopState(value, allowLegacy = false) {
  if (!value || (value.version !== DESKTOP_VERSION && !(allowLegacy && value.version === 11))
    || !isRecord(value.settings) || !Array.isArray(value.adjustments)
    || !Array.isArray(value.todos) || !isRecord(value.holidayCache) || !isRecord(value.holidayOverrides)) {
    throw new Error('不支持的桌面完整备份格式');
  }

  const legacy = value.version === 11;
  const holidays = legacy ? { ...BUILT_IN_HOLIDAYS } : {};

  for (const [year, records] of Object.entries(value.holidayCache)) {
    if (!/^\d{4}$/.test(year) || Number(year) < 1900 || Number(year) > 2200 || !isRecord(records)) {
      throw new Error('年度假期格式不正确');
    }

    const sanitized = sanitizeHolidays(records);
    const dates = Object.keys(records);

    if (Object.keys(sanitized).length !== dates.length || dates.some((dateKey) => !dateKey.startsWith(year + '-'))) {
      throw new Error('年度假期日期或记录格式不正确');
    }

    Object.assign(holidays, sanitized);
  }

  for (const [dateKey, correction] of Object.entries(value.holidayOverrides)) {
    if (!isDateKey(dateKey)) throw new Error('日期修正格式不正确');

    if (correction === null) {
      delete holidays[dateKey];
    } else {
      const single = { [dateKey]: correction };
      const sanitized = sanitizeHolidays(single);

      if (!sanitized[dateKey]) throw new Error('日期修正记录格式不正确');

      holidays[dateKey] = sanitized[dateKey];
    }
  }

  const operationIds = new Set();
  const adjustments = value.adjustments.map((record) => {
    if (!isRecord(record) || typeof record.id !== 'string' || !record.id
      || operationIds.has(record.id)
      || typeof record.note !== 'string' || !Number.isInteger(record.createdAt) || record.createdAt < 1) {
      throw new Error('调班记录格式不正确');
    }

    operationIds.add(record.id);
    const { type, startDate, startPeriod, endDate, endPeriod } = record;
    const primary = { type, startDate, startPeriod, endDate, endPeriod };

    if (typeof record.compensationRequired !== 'boolean' || !Array.isArray(record.counterRanges)) {
      throw new Error('调班记录格式不正确');
    }

    validateRange(primary);
    record.counterRanges.forEach(validateRange);

    return {
      id: record.id,
      ranges: [primary, ...record.counterRanges],
      associationType: record.compensationRequired ? 'required' : 'none',
      note: record.note,
      createdAt: record.createdAt
    };
  });

  const settings = value.settings;
  let colorSchemeId = settings.paletteScheme;

  if (legacy && colorSchemeId !== 'default' && colorSchemeId !== 'custom') colorSchemeId += '.json';

  const customColors = decodeCustomColorsImport(settings.customPalettes);
  const calendar = encodeState({
    settings: sanitizeSettings(settings),
    appearance: settings.theme,
    layoutDensity: settings.layoutDensity,
    colorSchemeId,
    customColors,
    holidays,
    loadedYears: Object.keys(value.holidayCache).map(Number),
    adjustments
  });

  const desktopInput = { todos: value.todos, appearance: settings };
  const desktop = sanitizeDesktop(desktopInput);
  return { calendar, desktop };
}

/**
 * 待办和外观在提交期间使用私有草稿，渲染与导出只读取已确认的扩展状态。
 */
export function createDesktopExtension(initial) {
  let committed = sanitizeDesktop(initial);
  let draft = null;

  return {
    getDesktop: () => committed,
    getWriteExtension: () => draft ?? committed,
    setDesktop: (value) => {
      if (!draft) throw new Error('桌面扩展必须通过公共提交队列保存');

      draft = sanitizeDesktop(value);
    },
    captureExtension: () => {
      draft = structuredClone(committed);
      return committed;
    },
    commitExtension: () => {
      if (draft) committed = draft;

      draft = null;
    },
    restoreExtension: () => { draft = null; }
  };
}

/**
 * 公共操作及完整日期快照无损转换为现有逐字段 SQLite DTO。
 */
export function encodeDesktopState(calendar, desktop, schemes) {
  const state = decodeState(calendar);
  const extension = sanitizeDesktop(desktop);
  const holidayCache = Object.fromEntries(state.loadedYears.map((year) => [year, {}]));
  const holidayOverrides = {};

  for (const [dateKey, holiday] of Object.entries(state.holidays)) {
    const year = Number(dateKey.slice(0, 4));

    if (Object.hasOwn(holidayCache, year)) {
      holidayCache[year][dateKey] = holiday;
    } else {
      holidayOverrides[dateKey] = holiday;
    }
  }

  const adjustments = state.adjustments.map((record) => {
    const [primary, ...counterRanges] = record.ranges;
    return {
      ...primary,
      id: record.id,
      compensationRequired: record.associationType === 'required',
      counterRanges,
      note: record.note,
      createdAt: record.createdAt
    };
  });

  const palettes = {
    light: getPalette('light', state, schemes),
    dark: getPalette('dark', state, schemes)
  };

  return {
    version: DESKTOP_VERSION,
    settings: {
      ...state.settings,
      ...extension.appearance,
      theme: state.appearance,
      layoutDensity: state.layoutDensity,
      paletteScheme: state.colorSchemeId,
      palettes,
      customPalettes: state.customColors
    },
    todos: extension.todos,
    adjustments,
    holidayCache,
    holidayOverrides
  };
}
