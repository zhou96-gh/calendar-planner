import { BUILT_IN_HOLIDAYS } from './holiday/data.js';
import { fetchHolidayYear, HolidayDataUnavailableError } from './holiday/fetch.js';
import { formatLunarDate, getFestivalNames } from './holiday/festivals.js';
import { createQuotaHolidays, prepareQuotaHolidays } from './holiday/quota.js';
import { COLOR_DEFAULTS, getPalette } from './holiday/appearance.js';
import { getVacationAdjustmentLimit, hasCrossMonthCompensation, recommendVacations } from './holiday/recommendations.js';
import {
  getVacationRecordGroup, getVacationReplacementRecords, getVacationSelection
} from './holiday/recommendation-selection.js';
import {
  STORAGE_VERSION,
  CUSTOM_COLOR_TOKENS,
  decodeState,
  decodeCustomColorsImport,
  decodeHolidayImport,
  encodeHolidays,
  encodeState,
  replaceHolidayYears,
  sanitizeLoadedYears
} from './holiday/storage.js';
import {
  DEFAULT_SETTINGS,
  addDays,
  buildMonthGrid,
  calculateAdjustmentDays,
  classifyDay,
  createCalendarCalculation,
  getAdjustmentSummary,
  getAdjustmentRanges,
  getYearLegalBreakdown,
  hasAdjustmentOverlap,
  mergeAssociatedAdjustment,
  removeAdjustmentYear,
  sanitizeAdjustmentRecords,
  sanitizeSettings,
  startOfWeek
} from './holiday/core.js';

const STORAGE_KEY = 'holiday-planner-state-v7';
const LEGACY_STORAGE_KEYS = [
  'holiday-planner-state-v6',
  'holiday-planner-state-v5',
  'holiday-planner-state-v4',
  'holiday-planner-state-v3'
];
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const CATEGORY_LABELS = {
  'pure-legal': '休息',
  'makeup-off': '调休',
  'schedule-rest': '休息',
  'adjusted-work': '上班',
  'regular-work': '上班',
  'manual-rest': '调休',
  'manual-work': '补班'
};
const WEEKEND_PRESETS = {
  double: {
    5: { restPeriod: 'full', repeatIntervalWeeks: 0 },
    6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
  },
  single: {
    5: { restPeriod: 'none', repeatIntervalWeeks: 0 },
    6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
  },
  alternating: {
    5: { restPeriod: 'full', repeatIntervalWeeks: 1 },
    6: { restPeriod: 'full', repeatIntervalWeeks: 0 }
  }
};

const systemDarkMedia = window.matchMedia('(prefers-color-scheme: dark)');
const builtInColorSchemes = new Map();

const now = new Date();
let viewYear = now.getFullYear();
let viewMonth = now.getMonth() + 1;
let selectedDateKey = '';
let activeDateKey = toLocalDateKey(now);
let selectedAdjustmentId = '';
let editingAdjustmentId = '';
let selectedAdjustmentDateKey = '';
let selectedAdjustmentType = 'adjustment';
let associationType = 'none';
let activeAdjustmentRangeType = 'rest';
let rangeSequence = 0;
let toastTimer = null;
let storageReadError = null;
let state = loadState();
let colorEditMode = state.appearance === 'dark'
  || (state.appearance === 'system' && systemDarkMedia.matches) ? 'dark' : 'light';
const yearFetchStates = new Map();
const yearQuotaSources = new Map();
let calendarHolidays = state.holidays;
let renderedYear = null;
let previewColors = null;
let adjustmentSession = 0;
let recommendationDateKey = '';
let recommendationEndDate = '';
let vacationRecommendations = [];
let recommendationRequest = 0;
let recommendationLeaveRanges = [];
let recommendationSelection = null;

const elements = {
  monthTitle: document.querySelector('#month-title'),
  calendarNavigation: document.querySelector('#calendar-navigation'),
  calendarView: document.querySelector('#calendar-view'),
  calendarPanel: document.querySelector('.calendar-panel'),
  settingsView: document.querySelector('#settings-view'),
  appearanceMode: document.querySelector('#appearance-mode'),
  layoutDensity: document.querySelector('#layout-density'),
  colorScheme: document.querySelector('#color-scheme'),
  colorMode: document.querySelector('#color-mode'),
  colorGrid: document.querySelector('#color-grid'),
  colorPreview: document.querySelector('#color-preview'),
  resetCustomColors: document.querySelector('#reset-custom-colors'),
  colorImportFile: document.querySelector('#color-import-file'),
  summaryBand: document.querySelector('#summary-band'),
  settingsToggle: document.querySelector('#settings-toggle'),
  settingsFloatingBack: document.querySelector('#settings-floating-back'),
  calendarGrid: document.querySelector('#calendar-grid'),
  weekdayHeader: document.querySelector('#weekday-header'),
  weekStartsOn: document.querySelector('#week-starts-on'),
  anchorMonday: document.querySelector('#anchor-monday'),
  monthlyMaxAdjustmentDays: document.querySelector('#monthly-max-adjustment-days'),
  allowCrossMonthAdjustment: document.querySelector('#allow-cross-month-adjustment'),
  recommendationDialog: document.querySelector('#vacation-recommendation-dialog'),
  recommendationHoliday: document.querySelector('#vacation-recommendation-holiday'),
  recommendationMaximum: document.querySelector('#recommendation-maximum'),
  recommendationMaximumLabel: document.querySelector('#recommendation-maximum-label'),
  recommendationLeaveDays: document.querySelector('#recommendation-leave-days'),
  recommendationWorkMaximum: document.querySelector('#recommendation-work-maximum'),
  recommendationCrossMonth: document.querySelector('#recommendation-cross-month'),
  recommendationResults: document.querySelector('#vacation-recommendation-results'),
  summaryRest: document.querySelector('#summary-rest'),
  summaryPure: document.querySelector('#summary-pure'),
  summarySchedule: document.querySelector('#summary-schedule'),
  summaryRestBalance: document.querySelector('#summary-rest-balance'),
  summaryWorkBalance: document.querySelector('#summary-work-balance'),
  adjustmentRecordCount: document.querySelector('#adjustment-record-count'),
  adjustmentRecordList: document.querySelector('#adjustment-record-list'),
  resultYear: document.querySelector('#result-year'),
  yearPureCount: document.querySelector('#year-pure-count'),
  pureHolidayList: document.querySelector('#pure-holiday-list'),
  expiredHolidaySection: document.querySelector('#expired-holiday-section'),
  expiredHolidayCount: document.querySelector('#expired-holiday-count'),
  expiredHolidayList: document.querySelector('#expired-holiday-list'),
  selectedDateLabel: document.querySelector('#selected-date-label'),
  selectedDateLunar: document.querySelector('#selected-date-lunar'),
  selectedDayStatus: document.querySelector('#selected-day-status'),
  selectedFestivalCount: document.querySelector('#selected-festival-count'),
  selectedFestivalList: document.querySelector('#selected-festival-list'),
  dataStatus: document.querySelector('#data-status'),
  importFile: document.querySelector('#import-file'),
  resetYear: document.querySelector('#reset-year'),
  resetData: document.querySelector('#reset-data'),
  editDate: document.querySelector('#edit-date'),
  editKind: document.querySelector('#edit-kind'),
  editName: document.querySelector('#edit-name'),
  datePreview: document.querySelector('#date-preview'),
  adjustmentDialog: document.querySelector('#adjustment-dialog'),
  adjustmentPicker: document.querySelector('#adjustment-picker'),
  adjustmentPickerTitle: document.querySelector('#adjustment-picker-title'),
  adjustmentPickerList: document.querySelector('#adjustment-picker-list'),
  newAdjustment: document.querySelector('#new-adjustment'),
  adjustmentForm: document.querySelector('#adjustment-form'),
  adjustmentDialogTitle: document.querySelector('#adjustment-dialog-title'),
  adjustmentType: document.querySelector('#adjustment-type'),
  associationControl: document.querySelector('#counterpart-type'),
  restRangeSection: document.querySelector('#rest-range-section'),
  workRangeSection: document.querySelector('#work-range-section'),
  restRangeList: document.querySelector('#rest-range-list'),
  workRangeList: document.querySelector('#work-range-list'),
  rangeTemplate: document.querySelector('#adjustment-range-template'),
  adjustmentFields: document.querySelector('#adjustment-fields'),
  correctionFields: document.querySelector('#correction-fields'),
  adjustmentNote: document.querySelector('#adjustment-note'),
  adjustmentPreview: document.querySelector('#adjustment-preview'),
  recommendationLeavePreview: document.querySelector('#recommendation-leave-preview'),
  toast: document.querySelector('#toast')
};

function cloneBuiltInHolidays() {
  return JSON.parse(JSON.stringify(BUILT_IN_HOLIDAYS));
}

function storageRead(key) {
  return globalThis.calendarPlatform.storage.getItem(key);
}

function storageRemove(key) {
  return globalThis.calendarPlatform.storage.removeItem(key);
}

function storageSet(value) {
  return globalThis.calendarPlatform.storage.setItem(STORAGE_KEY, value);
}

function loadState() {
  try {
    const saved = storageRead(STORAGE_KEY);

    // 读取只恢复保存内容，历史调班记录不按当前日期自动删除。
    if (saved) return decodeState(saved);
  } catch (error) {
    storageReadError = error;
    console.warn('读取假期设置失败', error);
  } finally {
    // 旧数据清理不影响新版本设置读取，单个键失败后继续清理其余键。
    LEGACY_STORAGE_KEYS.forEach((key) => {
      try {
        storageRemove(key);
      } catch (error) {
        console.warn('清理旧版假期设置失败：' + key, error);
      }
    });
  }

  return {
    version: STORAGE_VERSION,
    settings: sanitizeSettings(DEFAULT_SETTINGS),
    appearance: 'system',
    layoutDensity: 'spacious',
    colorSchemeId: 'default',
    customColors: { light: {}, dark: {} },
    holidays: cloneBuiltInHolidays(),
    loadedYears: [2026],
    adjustments: []
  };
}

/**
 * 保存用户数据，读取失败时保护原存储，写入失败时阻断成功提示。
 */
function persist(value = state) {
  try {
    if (storageReadError) throw new Error('原数据读取失败，请重新打开插件后再保存');

    const snapshot = structuredClone(encodeState(value));
    return storageSet(snapshot)?.catch(reportPersistenceError);
  } catch (error) {
    return reportPersistenceError(error);
  }
}

/**
 * 同步宿主异常和异步 SQLite 异常使用同一失败提示。
 */
function reportPersistenceError(error) {
  console.error('保存假期数据失败', error);
  const reason = error.message || '存储不可用';
  const message = '保存失败：' + reason;
  showToast(message, true);
  throw error;
}

let stateCommitQueue = Promise.resolve();

/**
 * 串行准备独立状态快照，持久化确认后才发布，失败不会回滚其他已完成操作。
 */
function commitState(update) {
  const commit = async () => {
    const draft = structuredClone(state);
    const extension = globalThis.calendarPlatform.captureExtension?.();

    try {
      if (update(draft) === false) {
        globalThis.calendarPlatform.restoreExtension?.(extension);
        return false;
      }

      await persist(draft);
      globalThis.calendarPlatform.commitExtension?.();
      state = draft;
      globalThis.calendarPlatform.refreshRecommendations?.();
      return true;
    } catch (error) {
      globalThis.calendarPlatform.restoreExtension?.(extension);
      throw error;
    }
  };

  const pending = stateCommitQueue.then(commit);
  stateCommitQueue = pending.catch(() => {});
  return pending;
}

async function loadBuiltInColorSchemes() {
  let entries;
  if (window.readBuiltInColorSchemes) {
    entries = window.readBuiltInColorSchemes();
  } else {
    const indexResponse = await fetch(new URL('../themes/index.json', import.meta.url));
    if (!indexResponse.ok) {
      throw new Error('配色方案清单读取失败');
    }
    const { files } = await indexResponse.json();
    if (!Array.isArray(files) || files.some((file) => !/^[a-z0-9][a-z0-9-]*\.json$/.test(file))) {
      throw new Error('配色方案清单无效');
    }
    entries = await Promise.all(files.map(async (id) => {
      const response = await fetch(new URL('../themes/' + id, import.meta.url));
      if (!response.ok) {
        throw new Error('配色方案读取失败：' + id);
      }
      return { id, ...await response.json() };
    }));
  }

  for (const { id, name, light, dark } of entries) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*\.json$/.test(id)
      || typeof name !== 'string' || !name.trim()) {
      throw new Error('内置配色名称或文件名无效');
    }
    const colors = decodeCustomColorsImport({ light, dark });
    if (Object.keys(colors.light).length !== CUSTOM_COLOR_TOKENS.length
      || Object.keys(colors.dark).length !== CUSTOM_COLOR_TOKENS.length) {
      throw new Error('内置配色缺少颜色：' + name);
    }
    builtInColorSchemes.set(id, { name, colors });
  }

  elements.colorScheme.replaceChildren(
    new Option('默认配色', 'default'),
    ...[...builtInColorSchemes].map(([id, scheme]) => new Option(scheme.name, id)),
    new Option('自定义', 'custom')
  );
  if (state.colorSchemeId !== 'default' && state.colorSchemeId !== 'custom'
    && !builtInColorSchemes.has(state.colorSchemeId)) {
    await commitState((draft) => { draft.colorSchemeId = 'default'; });
  }
  applyColors();
  renderSettings();
}

function getColorValues(mode) {
  const current = previewColors ?? state;
  return getPalette(mode, current, builtInColorSchemes);
}

/**
 * 排版密度只更新外观，不重新计算日历业务数据。
 */
function applyLayoutDensity() {
  document.documentElement.dataset.layoutDensity = state.layoutDensity;
}

function applyColors() {
  const root = document.documentElement;
  root.dataset.theme = state.appearance;
  const mode = state.appearance === 'system'
    ? (systemDarkMedia.matches ? 'dark' : 'light') : state.appearance;
  const current = previewColors ?? state;
  const colors = current.colorSchemeId === 'custom'
    ? current.customColors[mode] : builtInColorSchemes.get(current.colorSchemeId)?.colors[mode] ?? {};
  CUSTOM_COLOR_TOKENS.forEach((token) => {
    if (colors[token]) {
      root.style.setProperty('--' + token, colors[token]);
    } else {
      root.style.removeProperty('--' + token);
    }
  });
  if (colors.primary && !colors['primary-hover']) {
    root.style.setProperty('--primary-hover', colors.primary);
  }
}

/**
 * 合并所有参考年份的额度结果，实际安排及日期修正始终优先。
 */
function buildCalendarHolidays(holidays) {
  const quotaHolidays = {};
  yearQuotaSources.forEach((sourceYear, year) => {
    const generated = createQuotaHolidays(year, sourceYear, state.settings);
    Object.assign(quotaHolidays, generated);
  });

  return { ...quotaHolidays, ...holidays };
}

function render(scope = 'all') {
  if (scope === 'navigation' && renderedYear !== viewYear) {
    yearFetchStates.forEach((fetchState, year) => {
      if (fetchState.status === 'error' && !fetchState.promise && !yearQuotaSources.has(year)) {
        yearFetchStates.delete(year);
      }
    });
  }

  calendarHolidays = buildCalendarHolidays(state.holidays);
  const calculation = createCalendarCalculation(state.settings, calendarHolidays, state.adjustments);

  if (scope !== 'navigation') {
    applyLayoutDensity();
    applyColors();
    renderSettings();
  }

  renderCalendar(calculation);
  renderSummary(calculation);
  renderAdjustmentRecords();
  renderSelectedDate(calculation);

  if (scope !== 'navigation' || renderedYear !== viewYear) {
    renderYearResult();
    renderedYear = viewYear;
  } else {
    renderYearDataStatus();
  }

  void ensureHolidayData(viewYear);
  void ensureHolidayData(viewYear + 1);
}

function setView(view) {
  const isSettings = view === 'settings';
  document.documentElement.classList.toggle('settings-open', isSettings);
  elements.calendarView.hidden = isSettings;
  elements.summaryBand.hidden = isSettings;
  elements.calendarNavigation.hidden = isSettings;
  elements.settingsView.hidden = !isSettings;
  elements.settingsFloatingBack.hidden = !isSettings;

  if (isSettings) elements.resetYear.value = String(viewYear);
}

/**
 * 宿主扩展挂载后统一初始化设置 Tab，切换只更新显示和键盘焦点。
 */
function initializeSettingsTabs() {
  const tablist = elements.settingsView.querySelector('[role="tablist"]');
  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  const panels = elements.settingsView.querySelectorAll('[role="tabpanel"]');

  /**
   * 同步选中状态及可见分区，不重建控件或提交设置。
   */
  function activate(tab) {
    for (const item of tabs) {
      const selected = item === tab;
      const selectedValue = String(selected);
      item.setAttribute('aria-selected', selectedValue);
      item.tabIndex = selected ? 0 : -1;
    }

    const panelId = tab.getAttribute('aria-controls');

    for (const panel of panels) {
      panel.hidden = panel.id !== panelId;
    }
  }

  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');

    if (tab) activate(tab);
  });

  tablist.addEventListener('keydown', (event) => {
    const current = tabs.indexOf(event.target.closest('[role="tab"]'));

    if (current < 0) return;

    let next;

    if (event.key === 'ArrowRight') {
      next = (current + 1) % tabs.length;
    } else if (event.key === 'ArrowLeft') {
      next = (current + tabs.length - 1) % tabs.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = tabs.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    activate(tabs[next]);
    tabs[next].focus();
  });

  activate(tabs[0]);
}

function renderColorPreview() {
  const colors = getColorValues(colorEditMode);
  CUSTOM_COLOR_TOKENS.forEach((token) => {
    elements.colorPreview.style.setProperty('--preview-' + token, colors[token]);
  });
}

function renderSettings() {
  elements.layoutDensity.querySelectorAll('button[data-value]').forEach((button) => {
    const active = button.dataset.value === state.layoutDensity;
    const pressed = String(active);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', pressed);
  });

  elements.colorScheme.value = state.colorSchemeId;
  const colors = getColorValues(colorEditMode);
  elements.appearanceMode.querySelectorAll('button[data-value]').forEach((button) => {
    const active = button.dataset.value === state.appearance;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  elements.colorMode.querySelectorAll('button[data-value]').forEach((button) => {
    const active = button.dataset.value === colorEditMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  elements.colorGrid.querySelectorAll('input[data-color-token]').forEach((input) => {
    const color = colors[input.dataset.colorToken];
    const row = input.closest('.color-row');
    input.value = color.slice(0, 7);
    row.querySelector(':scope > output').textContent = color.slice(0, 7).toUpperCase();
    const alpha = row.querySelector('input[data-alpha-token]');
    if (alpha) {
      alpha.value = color.length === 7 ? '0'
        : String(Math.round((1 - parseInt(color.slice(7), 16) / 255) * 100));
      alpha.nextElementSibling.textContent = alpha.value + '%';
    }
  });
  elements.resetCustomColors.disabled = state.colorSchemeId !== 'custom'
    || Object.keys(state.customColors[colorEditMode]).length === 0;
  renderColorPreview();
  elements.weekStartsOn.value = String(state.settings.weekStartsOn);
  elements.anchorMonday.value = state.settings.anchorMonday;
  elements.monthlyMaxAdjustmentDays.value = String(state.settings.monthlyMaxAdjustmentDays);
  elements.allowCrossMonthAdjustment.checked = state.settings.allowCrossMonthAdjustment;

  document.querySelectorAll('.weekend-period-row[data-weekend-day]').forEach((row) => {
    const weekday = row.dataset.weekendDay;
    const rule = state.settings.weekendRules[weekday];
    row.querySelectorAll('.weekend-period-control button').forEach((button) => {
      button.classList.toggle('active', button.dataset.value === rule.restPeriod);
    });
    row.querySelector('.weekend-repeat-interval').value = String(rule.repeatIntervalWeeks);
  });

  const preset = getWeekendPreset();
  document.querySelectorAll('#weekend-preset button').forEach((button) => {
    button.classList.toggle('active', button.dataset.value === preset);
  });

}

function getWeekendPreset() {
  const saturday = state.settings.weekendRules[5];
  const sunday = state.settings.weekendRules[6];
  const isDouble = saturday.restPeriod === 'full'
    && saturday.repeatIntervalWeeks === 0
    && sunday.restPeriod === 'full'
    && sunday.repeatIntervalWeeks === 0;
  if (isDouble) {
    return 'double';
  }

  const isSingle = saturday.restPeriod === 'none'
    && sunday.restPeriod === 'full'
    && sunday.repeatIntervalWeeks === 0;
  if (isSingle) {
    return 'single';
  }

  const isAlternating = saturday.restPeriod === 'full'
    && saturday.repeatIntervalWeeks === 1
    && sunday.restPeriod === 'full'
    && sunday.repeatIntervalWeeks === 0;
  return isAlternating ? 'alternating' : '';
}

function renderCalendar(calculation = createCalendarCalculation(state.settings, calendarHolidays, state.adjustments)) {
  elements.monthTitle.textContent = `${viewYear}年${viewMonth}月`;
  const weekdayLabels = [
    ...WEEKDAY_LABELS.slice(state.settings.weekStartsOn),
    ...WEEKDAY_LABELS.slice(0, state.settings.weekStartsOn)
  ];
  elements.weekdayHeader.replaceChildren(...weekdayLabels.map((label) => {
    const item = document.createElement('span');
    item.textContent = label;
    return item;
  }));
  elements.calendarGrid.replaceChildren();
  const currentMonthPrefix = `${viewYear}-${String(viewMonth).padStart(2, '0')}-`;
  const todayKey = toLocalDateKey(now);

  buildMonthGrid(viewYear, viewMonth, state.settings.weekStartsOn).forEach((dateKey) => {
    const day = calculation.classifyDay(dateKey);
    const visibleOfficialLabels = day.officialLabels.filter((label) => label === '放假');
    const consecutiveRest = calculation.getConsecutiveRestState(dateKey);
    const visualCategory = day.visualCategory ?? day.category;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `day-cell ${visualCategory}`;
    button.classList.toggle('has-adjustment', Boolean(day.manualAdjustment));
    button.classList.toggle('has-official-label', visibleOfficialLabels.length > 0);
    button.classList.toggle('official-holiday', day.officialLabels.some((label) => label.endsWith('放假')));
    button.classList.toggle('official-work', day.officialLabels.some((label) => label.endsWith('法定补班')));
    button.classList.toggle('partial-rest', day.restAmount === 0.5);
    button.classList.toggle('consecutive-rest', consecutiveRest.isConsecutive);
    button.classList.toggle(
      'consecutive-rest-start',
      consecutiveRest.isConsecutive && !consecutiveRest.hasPrevious
    );
    button.classList.toggle(
      'consecutive-rest-end',
      consecutiveRest.isConsecutive && !consecutiveRest.hasNext
    );
    button.classList.toggle('outside-month', !dateKey.startsWith(currentMonthPrefix));
    button.classList.toggle('today', dateKey === todayKey);
    button.classList.toggle('selected', dateKey === activeDateKey);
    button.setAttribute('aria-pressed', String(dateKey === activeDateKey));
    button.dataset.date = dateKey;
    const displayName = getFestivalNames(dateKey)[0] ?? '';
    const hasFestival = Boolean(displayName);
    button.classList.toggle('has-festival', hasFestival);
    const arrangement = calendarHolidays[dateKey];
    const hasHolidayArrangement = hasFestival && ['block', 'legal', 'off'].includes(arrangement?.kind);
    button.classList.toggle('festival-holiday', hasHolidayArrangement);
    const lunarDate = formatLunarDate(dateKey);
    const consecutiveRestText = consecutiveRest.isConsecutive ? ' 连休' : '';
    button.setAttribute(
      'aria-label',
      `${dateKey} 农历${lunarDate} ${displayName} ${getDayPeriodText(day)}${consecutiveRestText}`
    );

    const top = document.createElement('span');
    top.className = 'day-top';
    const dateLabels = document.createElement('span');
    dateLabels.className = 'day-date-labels';
    const number = document.createElement('strong');
    number.className = 'day-number';
    number.textContent = String(Number(dateKey.slice(8)));
    const lunar = document.createElement('small');
    lunar.className = 'day-lunar';
    lunar.textContent = lunarDate;
    const name = document.createElement('span');
    name.className = 'day-name';
    name.textContent = displayName;
    name.title = displayName;
    dateLabels.append(lunar);

    const tags = document.createElement('span');
    tags.className = 'day-tags';

    visibleOfficialLabels.forEach((label) => {
      const officialTag = document.createElement('small');
      officialTag.className = 'official-tag holiday';
      officialTag.textContent = label;
      tags.append(officialTag);
    });

    if (tags.childElementCount > 0) {
      dateLabels.append(tags);
    }

    const main = document.createElement('span');
    main.className = 'day-main';
    main.append(number, name);
    top.append(dateLabels, main);

    const status = document.createElement('span');
    status.className = 'day-period-status';
    status.setAttribute('aria-hidden', 'true');
    const periodItems = [['上午', day.periods.am.category], ['下午', day.periods.pm.category]];

    if (day.manualAdjustment) {
      periodItems.forEach(([periodLabel, category]) => {
        const item = document.createElement('small');
        item.className = `period-status-item ${category}`;
        item.title = `${periodLabel} ${CATEGORY_LABELS[category]}`;
        status.append(item);
      });
    }

    button.append(top, status);
    globalThis.calendarPlatform?.decorateDay?.(button, dateKey);
    elements.calendarGrid.append(button);
  });
}

function canMergeDayPeriods(day) {
  return day.periods.am.category === day.periods.pm.category
    && day.periods.am.sourceCategory === day.periods.pm.sourceCategory
    && day.periods.am.manualAdjustment === day.periods.pm.manualAdjustment;
}

function getDayPeriodText(day) {
  if (canMergeDayPeriods(day)) {
    return `全天 ${CATEGORY_LABELS[day.periods.am.category]}`;
  }

  return `上午 ${CATEGORY_LABELS[day.periods.am.category]} 下午 ${CATEGORY_LABELS[day.periods.pm.category]}`;
}

function renderSummary(calculation) {
  const summary = calculation.getMonthSummary(viewYear, viewMonth);
  const adjustmentSummary = getAdjustmentSummary(state.adjustments, state.settings, calendarHolidays);
  elements.summaryRest.textContent = formatDays(summary.totalRest);
  elements.summaryPure.textContent = formatDays(summary.pureLegal);
  elements.summarySchedule.textContent = formatDays(summary.scheduleRest);
  elements.summaryRestBalance.textContent = formatDays(adjustmentSummary.restRemaining);
  elements.summaryWorkBalance.textContent = formatDays(adjustmentSummary.workRemaining);
}

function renderAdjustmentRecords() {
  const monthStart = `${viewYear}-${String(viewMonth).padStart(2, '0')}-01`;
  const nextMonthYear = viewMonth === 12 ? viewYear + 1 : viewYear;
  const nextMonth = viewMonth === 12 ? 1 : viewMonth + 1;
  const nextMonthStart = `${nextMonthYear}-${String(nextMonth).padStart(2, '0')}-01`;
  const records = state.adjustments.flatMap((operation) => getAdjustmentRanges(operation)
    .filter((range) => range.endDate >= monthStart && range.startDate < nextMonthStart)
    .map((range) => ({ ...range, id: operation.id, note: operation.note, createdAt: operation.createdAt })))
    .sort((left, right) => right.createdAt - left.createdAt);
  elements.adjustmentRecordCount.textContent = `${records.length} 条`;
  elements.adjustmentRecordList.replaceChildren();
  if (records.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '本月暂无调休或补班记录';
    elements.adjustmentRecordList.append(empty);
    return;
  }

  records.forEach((record) => {
    const row = document.createElement('div');
    row.className = `adjustment-row ${record.type}`;
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'adjustment-main';
    edit.dataset.adjustmentId = record.id;
    edit.dataset.adjustmentType = record.type;
    const date = document.createElement('span');
    date.className = 'adjustment-date';
    date.textContent = formatAdjustmentRange(record);
    const type = document.createElement('strong');
    const typeLabel = record.type === 'rest' ? '调休' : '补班';
    type.textContent = record.note ? `${typeLabel} · ${record.note}` : typeLabel;
    const days = document.createElement('small');
    const total = calculateAdjustmentDays(record, state.settings, calendarHolidays);
    days.textContent = `${formatDays(total)} 天`;
    edit.title = `${date.textContent} · ${type.textContent} · ${days.textContent}`;
    edit.append(date, type, days);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'adjustment-delete';
    remove.dataset.deleteAdjustmentId = record.id;
    remove.title = '删除整次调班';
    remove.setAttribute('aria-label', '删除整次调班');
    remove.textContent = '×';
    row.append(edit, remove);
    elements.adjustmentRecordList.append(row);
  });
}

/**
 * 展示当前选中日期的完整节日列表，不改变用户的侧栏折叠状态。
 */
function renderSelectedDate(calculation = createCalendarCalculation(state.settings, calendarHolidays, state.adjustments)) {
  const options = { includeFolk: true };
  const names = getFestivalNames(activeDateKey, options);
  const day = calculation.classifyDay(activeDateKey);
  elements.selectedDateLabel.textContent = formatLongDate(activeDateKey);
  elements.selectedDateLunar.textContent = `农历 ${formatLunarDate(activeDateKey)}`;
  elements.selectedDayStatus.textContent = getDayPeriodText(day);
  elements.selectedFestivalCount.textContent = `${names.length} 个`;
  elements.selectedFestivalList.replaceChildren();
  globalThis.calendarPlatform?.updateSelection?.(activeDateKey);

  if (names.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = '当天没有节日';
    elements.selectedFestivalList.append(empty);
    return;
  }

  names.forEach((name) => {
    const item = document.createElement('li');
    item.className = 'festival-detail-item';
    item.textContent = name;
    elements.selectedFestivalList.append(item);
  });
}

function renderYearResult() {
  const breakdown = getYearLegalBreakdown(viewYear, state.settings, calendarHolidays);
  const todayKey = toLocalDateKey(now);
  const currentHolidays = breakdown.pure.filter((item) => item.dateKey >= todayKey);
  const expiredHolidays = breakdown.pure.filter((item) => item.dateKey < todayKey);
  elements.resultYear.textContent = viewYear;
  elements.yearPureCount.textContent = `${formatDays(sumItemDays(currentHolidays))} 天`;
  renderHolidayList(elements.pureHolidayList, currentHolidays, '本年暂无可用放假', breakdown.pure);
  elements.expiredHolidaySection.hidden = expiredHolidays.length === 0;
  elements.expiredHolidayCount.textContent = `${formatDays(sumItemDays(expiredHolidays))} 天`;
  renderHolidayList(elements.expiredHolidayList, expiredHolidays, '', breakdown.pure);
  renderYearDataStatus();
}

/**
 * 获取状态独立更新，同年导航无需重建年度假期列表。
 */
function renderYearDataStatus() {
  const fetchState = yearFetchStates.get(viewYear);
  const hasYearData = state.loadedYears.includes(viewYear) && hasHolidayData(viewYear);
  const quotaSourceYear = yearQuotaSources.get(viewYear);

  if (hasYearData) {
    elements.dataStatus.textContent = `已载入 ${viewYear} 年法定假期安排`;
  } else if (quotaSourceYear) {
    elements.dataStatus.textContent = `${viewYear} 年安排待补充，参考 ${quotaSourceYear} 年法定放假额度`;
  } else if (fetchState?.status === 'loading') {
    elements.dataStatus.textContent = `正在获取 ${viewYear} 年法定假期安排`;
  } else if (fetchState?.status === 'error') {
    elements.dataStatus.textContent = `${viewYear} 年法定假期安排待补充，节日已显示`;
  } else {
    elements.dataStatus.textContent = `正在检查 ${viewYear} 年法定假期安排`;
  }
}

function hasHolidayData(year) {
  return Object.keys(state.holidays).some((dateKey) => dateKey.startsWith(`${year}-`));
}

async function ensureHolidayData(year) {
  if (state.loadedYears.includes(year) && hasHolidayData(year)) return year;

  const fetchState = yearFetchStates.get(year);
  let availableYear;

  if (fetchState?.promise) {
    availableYear = await fetchState.promise;
  } else if (fetchState?.status === 'loading') {
    return;
  } else if (fetchState?.status === 'error') {
    availableYear = fetchState.fallbackYear;
  } else {
    const requestState = { status: 'loading' };
    yearFetchStates.set(year, requestState);
    requestState.promise = loadHolidayData(year, requestState);
    availableYear = await requestState.promise;
  }

  if (!availableYear && state.loadedYears.includes(year) && hasHolidayData(year)) return year;

  return availableYear;
}

/**
 * 更新当前年份或可见的跨年日期，后台其他年份不触发重绘。
 */
function refreshHolidayYear(year) {
  if (viewYear === year) {
    render();
    return;
  }

  const prefix = `${year}-`;
  const visibleDates = buildMonthGrid(viewYear, viewMonth, state.settings.weekStartsOn);

  if (activeDateKey.startsWith(prefix) || visibleDates.some((dateKey) => dateKey.startsWith(prefix))) {
    render('navigation');
  }
}

/**
 * 自动加载按实际年份保存；目标年份无安排时向前查找，逐年共用并发保护。
 */
async function loadHolidayData(year, requestState) {
  if (viewYear === year) {
    elements.dataStatus.textContent = `正在获取 ${year} 年法定假期安排`;
  }

  try {
    const fetchedHolidays = await fetchHolidayYear(year);

    // 导入或重置已替换该年数据时，丢弃先前自动获取的结果。
    if (yearFetchStates.get(year) !== requestState) return;

    await commitState((draft) => {
      if (yearFetchStates.get(year) !== requestState) return false;

      draft.holidays = { ...fetchedHolidays, ...draft.holidays };
      const years = [...draft.loadedYears, year];
      draft.loadedYears = sanitizeLoadedYears(years);
    });

    if (yearFetchStates.get(year) !== requestState) return;

    const loadedState = { status: 'loaded' };
    yearFetchStates.set(year, loadedState);
    yearQuotaSources.delete(year);
    refreshHolidayYear(year);

    if (viewYear === year) showToast(`${year} 年法定假期安排已更新`);

    return year;
  } catch (error) {
    if (yearFetchStates.get(year) !== requestState) return;

    requestState.status = 'error';
    requestState.message = error.message;

    if (error instanceof HolidayDataUnavailableError && year > 1900) {
      // 远期年份从下一年度起回查，避免逐年请求大量尚未到来的年份。
      const previousYear = Math.min(year - 1, now.getFullYear() + 1);
      const availableYear = await ensureHolidayData(previousYear);

      if (yearFetchStates.get(year) !== requestState) return;

      if (availableYear) {
        try {
          await prepareQuotaHolidays(year, availableYear, state.settings);
        } catch (preparationError) {
          if (yearFetchStates.get(year) !== requestState) return;

          requestState.message = preparationError.message;

          refreshHolidayYear(year);

          return;
        }

        if (yearFetchStates.get(year) !== requestState) return;

        yearQuotaSources.set(year, availableYear);
      }

      requestState.fallbackYear = availableYear;
    }

    refreshHolidayYear(year);

    return requestState.fallbackYear;
  } finally {
    delete requestState.promise;
  }
}

function renderHolidayList(container, items, emptyText, allItems = items) {
  container.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }

  const holidayGroups = new Map();
  items.forEach((item) => {
    const name = item.name || '放假';
    const group = holidayGroups.get(name) ?? [];
    group.push(item);
    holidayGroups.set(name, group);
  });

  holidayGroups.forEach((group, name) => {
    const sortedItems = [...group].sort((left, right) => left.dateKey.localeCompare(right.dateKey));
    const firstItem = sortedItems[0];
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'holiday-row';
    row.dataset.date = firstItem.dateKey;
    row.dataset.holidayEndDate = sortedItems.at(-1).dateKey;
    const date = document.createElement('span');
    date.className = 'holiday-date';
    date.textContent = formatHolidayDates(sortedItems);
    const holidayName = document.createElement('strong');
    holidayName.textContent = name;
    const week = document.createElement('small');
    week.textContent = `${formatDays(sumItemDays(sortedItems))} 天`;
    row.append(date, holidayName, week);
    const holidayDates = allItems.filter((item) => (item.name || '放假') === name).map((item) => item.dateKey).sort();
    const holiday = { dateKey: holidayDates[0], endDate: holidayDates.at(-1) };
    const selected = getVacationSelection(state.adjustments, holiday);

    if (selected) {
      const titles = { earliest: '最早放假', longest: '最长假期', 'shortest-work': '最短连续上班' };
      const plan = document.createElement('small');
      plan.className = 'holiday-recommendation';
      plan.textContent = titles[selected.planId];
      holidayName.append(plan);
    }

    container.append(row);
  });
}

/**
 * 推荐只使用弹窗局部参数；使用方案后仍由原调班表单确认保存。
 */
function openVacationRecommendations(dateKey, endDate) {
  recommendationDateKey = dateKey;
  recommendationEndDate = endDate;
  const day = classifyDay(dateKey, state.settings, calendarHolidays, state.adjustments);
  elements.recommendationHoliday.textContent = `${day.holiday?.name ?? '假期'} · ${dateKey}`;
  elements.recommendationMaximum.value = String(state.settings.monthlyMaxAdjustmentDays);
  elements.recommendationLeaveDays.value = '0';
  elements.recommendationWorkMaximum.value = '';
  elements.recommendationCrossMonth.checked = state.settings.allowCrossMonthAdjustment;
  const holiday = { dateKey, endDate };
  const selected = getVacationSelection(state.adjustments, holiday);

  if (selected) {
    let leaveDays = 0;

    selected.records.forEach((record) => {
      if (record.associationType === 'none') {
        leaveDays += calculateAdjustmentDays(record, state.settings, calendarHolidays);
      }
    });

    elements.recommendationLeaveDays.value = String(leaveDays);
    const compensation = { records: selected.records, settings: state.settings, holidays: calendarHolidays };

    if (hasCrossMonthCompensation(compensation)) {
      elements.recommendationCrossMonth.checked = true;
    }
  }

  if (globalThis.calendarPlatform?.openRecommendations) {
    globalThis.calendarPlatform.openRecommendations().catch(reportRecommendationWindowError);
  } else {
    elements.recommendationDialog.showModal();
  }

  void prepareVacationRecommendations();
}

function reportRecommendationWindowError(error) {
  const message = String(error.message || error);
  showToast(message, true);
}

/**
 * 跨年搜索复用年度加载；快速切换参数时丢弃过期结果。
 */
async function prepareVacationRecommendations() {
  const request = ++recommendationRequest;
  const year = Number(recommendationDateKey.slice(0, 4));
  const month = Number(recommendationDateKey.slice(5, 7));
  const years = [year];

  if (month === 1) years.push(year - 1);

  if (month === 12) years.push(year + 1);

  elements.recommendationResults.textContent = '正在生成推荐…';
  vacationRecommendations = [];
  const holiday = { dateKey: recommendationDateKey, endDate: recommendationEndDate };
  const selected = getVacationSelection(state.adjustments, holiday);
  renderVacationSelection(selected);

  try {
    await Promise.all(years.map((value) => ensureHolidayData(value)));

    if (request !== recommendationRequest
      || !(elements.recommendationDialog.open || globalThis.calendarPlatform?.recommendationsOpen)) return;

    calendarHolidays = buildCalendarHolidays(state.holidays);
    renderVacationRecommendations();
    const estimated = years.filter((value) => !state.loadedYears.includes(value));

    if (estimated.length) {
      const message = document.createElement('p');
      message.className = 'recommendation-help';
      message.textContent = `${estimated.join('、')} 年官方安排未载入，结果基于当前周末规则及可用推算数据。`;
      elements.recommendationResults.prepend(message);
    }
  } catch (error) {
    if (request !== recommendationRequest
      || !(elements.recommendationDialog.open || globalThis.calendarPlatform?.recommendationsOpen)) return;

    elements.recommendationResults.textContent = `生成失败：${error.message}`;
    const current = getVacationSelection(state.adjustments, holiday);
    renderVacationSelection(current);
  }
}

function formatRecommendationRange(range) {
  const startPeriod = range.startPeriod === 'am' ? '上午' : '下午';
  const endPeriod = range.endPeriod === 'am' ? '上午' : '下午';
  return `${range.startDate} ${startPeriod} — ${range.endDate} ${endPeriod}`;
}

/**
 * 推荐日期统一按月份及整天、上午、下午汇总，时段放在日号列表之后。
 */
function createRecommendationDateList(ranges, label = '') {
  const months = new Map();

  ranges.forEach((range) => {
    for (let dateKey = range.startDate; dateKey <= range.endDate; dateKey = addDays(dateKey, 1)) {
      let period = '';

      if (dateKey === range.startDate && range.startPeriod === 'pm') period = '下午';

      if (dateKey === range.endDate && range.endPeriod === 'am') period = '上午';

      const month = dateKey.slice(0, 7);
      const periods = months.get(month) ?? new Map();
      const dates = periods.get(period) ?? [];
      dates.push(Number(dateKey.slice(8)));
      periods.set(period, dates);
      months.set(month, periods);
    }
  });

  const list = document.createElement('ul');
  list.className = 'recommendation-range-list';
  const sortedMonths = [...months].sort(([left], [right]) => left.localeCompare(right));

  sortedMonths.forEach(([month, periods]) => {
    for (const period of ['', '上午', '下午']) {
      const dates = periods.get(period);

      if (!dates?.length) continue;

      const sortedDates = dates.sort((left, right) => left - right);
      const groups = [];

      sortedDates.forEach((day) => {
        const previous = groups.at(-1);

        if (!period && previous && day === previous.end + 1) {
          previous.end = day;
        } else {
          groups.push({ start: day, end: day });
        }
      });

      const dayLabels = groups.map(({ start, end }) => {
        if (start === end) return String(start);

        return `${start}-${end}`;
      }).join('、');

      const item = document.createElement('li');
      item.className = 'recommendation-date-label';
      let text = `${month}（${dayLabels}）${period}`;

      if (label) text = `${label} ${text}`;

      item.textContent = text;
      list.append(item);
    }
  });

  return list;
}

function renderVacationSelection(selected) {
  if (!selected) return;

  const status = document.createElement('div');
  status.className = 'recommendation-selection-status';
  const title = selected.records.find((record) => record.id.endsWith('|m'))?.note ?? '休假方案';
  const label = document.createElement('span');
  label.textContent = `已采用：${title}。可选择下方方案更换，或取消本次方案。`;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary-button';
  cancel.dataset.cancelRecommendation = selected.groupId;
  cancel.textContent = '取消方案';
  status.append(label, cancel);
  elements.recommendationResults.prepend(status);
}

function renderVacationRecommendations() {
  elements.recommendationResults.replaceChildren();
  const holiday = { dateKey: recommendationDateKey, endDate: recommendationEndDate };
  const selected = getVacationSelection(state.adjustments, holiday);
  const selectedIds = new Set(selected?.records.map((record) => record.id) ?? []);
  const adjustments = state.adjustments.filter((record) => !selectedIds.has(record.id));
  const leaveDays = elements.recommendationLeaveDays.valueAsNumber;

  if (!elements.recommendationLeaveDays.value || !elements.recommendationLeaveDays.checkValidity()
    || !Number.isSafeInteger(leaveDays * 2)) {
    elements.recommendationResults.textContent = '假期天数请输入非负数，以 0.5 天递增。';
    vacationRecommendations = [];
    renderVacationSelection(selected);
    return;
  }

  let maximumWorkDays = Infinity;

  if (elements.recommendationWorkMaximum.value) maximumWorkDays = elements.recommendationWorkMaximum.valueAsNumber;

  if (!elements.recommendationWorkMaximum.checkValidity()
    || maximumWorkDays !== Infinity && !Number.isSafeInteger(maximumWorkDays * 2)) {
    elements.recommendationResults.textContent = '连续上班上限至少 0.5 天，以 0.5 天递增，留空表示不限。';
    vacationRecommendations = [];
    renderVacationSelection(selected);
    return;
  }

  const context = {
    dateKey: recommendationDateKey, holidayEndDate: recommendationEndDate,
    settings: state.settings, holidays: calendarHolidays, adjustments, leaveDays, maximumWorkDays,
    allowCrossMonth: elements.recommendationCrossMonth.checked
  };

  const limit = getVacationAdjustmentLimit(context);
  elements.recommendationMaximum.max = String(limit);
  elements.recommendationMaximumLabel.textContent = `调休上限（最多 ${formatDays(limit)} 天）`;

  if (elements.recommendationMaximum.valueAsNumber > limit) elements.recommendationMaximum.value = String(limit);

  if (!elements.recommendationMaximum.value || !elements.recommendationMaximum.checkValidity()) {
    elements.recommendationResults.textContent = `调休天数请输入 0 至 ${formatDays(limit)} 天，支持半天。`;
    vacationRecommendations = [];
    renderVacationSelection(selected);
    return;
  }

  vacationRecommendations = recommendVacations({
    ...context, maximum: elements.recommendationMaximum.valueAsNumber
  });

  if (!vacationRecommendations.length) {
    elements.recommendationResults.textContent = '当前范围没有可用方案，可调整上限或允许跨月。';
    renderVacationSelection(selected);
    return;
  }

  const table = document.createElement('table');
  table.className = 'vacation-recommendation-table';
  table.setAttribute('aria-label', '休假推荐方案');

  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');

  ['方案', '休假', '调休', '补班', '统计', '操作'].forEach((label) => {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    headerRow.append(cell);
  });

  head.append(headerRow);
  const body = document.createElement('tbody');
  const displayedPlans = new Set();

  vacationRecommendations.forEach((plan) => {
    if (!plan.unavailable) {
      const schedule = { vacation: plan.vacation, ranges: plan.ranges, leaveRanges: plan.leaveRanges };
      const key = JSON.stringify(schedule);

      if (displayedPlans.has(key)) return;

      displayedPlans.add(key);
    }

    const row = document.createElement('tr');
    const heading = document.createElement('th');
    heading.scope = 'row';
    heading.textContent = plan.title;
    row.append(heading);

    if (plan.unavailable) {
      const message = document.createElement('td');
      message.colSpan = 5;
      message.textContent = '当前调休额度、上班上限或已有调班下没有可用方案。';
      row.append(message);
      body.append(row);
      return;
    }

    const vacation = document.createElement('td');
    const vacationDates = createRecommendationDateList([plan.vacation]);
    vacation.append(vacationDates);
    const adjustment = document.createElement('td');
    const restRanges = plan.ranges.filter((range) => range.type === 'rest');
    const workRanges = plan.ranges.filter((range) => range.type === 'work');
    const restDates = createRecommendationDateList(restRanges, '调休');
    const leaveDates = createRecommendationDateList(plan.leaveRanges, '假期');
    const makeup = document.createElement('td');
    const workDates = createRecommendationDateList(workRanges);

    const displayedRanges = [...plan.leaveRanges, ...plan.ranges];
    adjustment.append(leaveDates, restDates);
    makeup.append(workDates);
    const statistics = document.createElement('td');
    statistics.className = 'recommendation-statistics';
    const statisticItems = document.createElement('div');
    statisticItems.className = 'recommendation-statistic-items';
    const workDaysLabel = `${plan.longestWorkDays} 天`;
    const longestWork = Number.isFinite(plan.longestWorkDays) ? workDaysLabel : '无休息时段中断';
    const statisticLabels = [
      `休假 ${formatDays(plan.vacationDays)} 天`,
      `调休 ${formatDays(plan.adjustmentDays)} 天`,
      `补班 ${formatDays(plan.adjustmentDays)} 天`,
      `连班 ${longestWork}`
    ];

    if (plan.leaveDays > 0) {
      const leaveLabel = `假期 ${formatDays(plan.leaveDays)} 天`;
      statisticLabels.splice(2, 0, leaveLabel);
    }

    statisticLabels.forEach((label) => {
      const item = document.createElement('p');
      item.className = 'recommendation-day-count';
      item.textContent = label;
      statisticItems.append(item);
    });

    statistics.append(statisticItems);
    const action = document.createElement('td');

    if (displayedRanges.length) {
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'secondary-button';
      use.dataset.useRecommendation = plan.id;
      use.textContent = '应用';
      action.append(use);
    } else {
      action.textContent = '-';
    }

    row.append(vacation, adjustment, makeup, statistics, action);
    body.append(row);
  });

  table.append(head, body);
  const help = document.createElement('p');
  help.className = 'recommendation-help';
  const requestedMaximum = formatDays(elements.recommendationMaximum.valueAsNumber);
  const requestedLeave = formatDays(leaveDays);
  let allowanceDescription = `调休 ≤ ${requestedMaximum} 天`;

  if (leaveDays > 0) allowanceDescription += `；假期 ≤ ${requestedLeave} 天`;

  if (Number.isFinite(maximumWorkDays)) {
    const requestedWork = formatDays(maximumWorkDays);
    allowanceDescription += `；连班 ≤ ${requestedWork} 天`;
  } else {
    allowanceDescription += '；连班不限';
  }

  help.textContent = `本次：${allowanceDescription}。整天优先，半天补班优先上午；休息 ≥ 0.5 天 ⇒ 连班中断。`;
  elements.recommendationResults.append(table, help);
  renderVacationSelection(selected);
}

function sumItemDays(items) {
  return items.reduce((total, item) => total + item.days, 0);
}

function readRangeRow(row, type) {
  const fields = Object.fromEntries([...row.querySelectorAll('[data-range-field]')]
    .map((input) => [input.dataset.rangeField, input.value]));
  return { type, ...fields };
}

function appendRange(container, range = null) {
  const row = elements.rangeTemplate.content.firstElementChild.cloneNode(true);
  rangeSequence += 1;
  row.querySelectorAll('[data-range-field]').forEach((input) => {
    const field = input.dataset.rangeField;
    input.id = `adjustment-range-${rangeSequence}-${field}`;
    input.value = range?.[field] ?? (input.tagName === 'SELECT' ? 'am' : '');
  });
  container.append(row);
  return row;
}

function openAdjustmentDialog(type, record = null, dateKey = '', defaultPeriods = null) {
  adjustmentSession += 1;
  recommendationLeaveRanges = record?.leaveRanges ?? [];
  recommendationSelection = record?.recommendationSelection ?? null;
  selectedAdjustmentId = record?.id ?? '';
  editingAdjustmentId = selectedAdjustmentId;
  selectedAdjustmentDateKey = dateKey || getAdjustmentRanges(record)[0]?.startDate || toLocalDateKey(now);
  selectedAdjustmentType = type === 'correction' ? 'correction' : 'adjustment';
  activeAdjustmentRangeType = type === 'work' ? 'work' : type === 'rest' ? 'rest'
    : getAdjustmentRanges(record)[0]?.type ?? 'rest';
  associationType = record?.associationType ?? 'none';
  elements.restRangeList.replaceChildren();
  elements.workRangeList.replaceChildren();
  getAdjustmentRanges(record).forEach((range) => appendRange(
    range.type === 'rest' ? elements.restRangeList : elements.workRangeList, range
  ));
  if (!record && selectedAdjustmentType !== 'correction') {
    const defaultDate = dateKey || toLocalDateKey(now);
    const initialRange = { startDate: defaultDate, startPeriod: defaultPeriods?.start ?? 'am',
      endDate: defaultDate, endPeriod: defaultPeriods?.end ?? 'pm' };
    appendRange(type === 'work' ? elements.workRangeList : elements.restRangeList, initialRange);
  }
  elements.adjustmentNote.value = record?.note ?? '';
  if (selectedAdjustmentType === 'correction') {
    initializeDateCorrection(dateKey || toLocalDateKey(now));
  } else {
    selectedDateKey = '';
  }
  renderAdjustmentType();
  updateActiveDialogPreview();
  elements.adjustmentDialog.showModal();
}

function openNewAdjustmentForDate(dateKey, selectedPeriod = null) {
  const day = classifyDay(dateKey, state.settings, calendarHolidays, state.adjustments);
  const period = selectedPeriod ?? ['am', 'pm'].find((item) => !day.periods[item].manualAdjustment);
  const type = period ? (day.periods[period].isRest ? 'work' : 'rest') : 'rest';
  const periods = period ? { start: period, end: period } : { start: 'am', end: 'pm' };
  openAdjustmentDialog(type, null, dateKey, periods);
}

function openAdjustmentPicker(dateKey, records, day) {
  elements.adjustmentPicker.dataset.date = dateKey;
  elements.adjustmentPickerTitle.textContent = formatLongDate(dateKey);
  const entries = records.flatMap((operation) => getAdjustmentRanges(operation)
    .filter((range) => range.startDate <= dateKey && range.endDate >= dateKey)
    .map((range) => {
    const record = { ...range, id: operation.id, note: operation.note };
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `adjustment-picker-item ${record.type}`;
    button.dataset.pickAdjustmentId = record.id;
    button.dataset.pickAdjustmentType = record.type;
    const appliedPeriods = ['am', 'pm'].filter((period) => day.periods[period].manualAdjustmentId === record.id
      && day.periods[period].manualAdjustment === record.type);
    let periods = appliedPeriods;
    if (periods.length === 0) {
      periods = ['am', 'pm'].filter((period) => !(dateKey === record.startDate
        && period === 'am' && record.startPeriod === 'pm')
        && !(dateKey === record.endDate && period === 'pm' && record.endPeriod === 'am'));
    }
    const periodLabel = periods.length === 2 ? '全天' : periods[0] === 'am' ? '上午' : '下午';
    const title = document.createElement('strong');
    title.textContent = `${periodLabel} · 编辑调班（${record.type === 'rest' ? '调休' : '补班'}）`;
    const note = document.createElement('span');
    note.textContent = record.note || formatAdjustmentRange(record);
    button.append(title, note);
    return { button, period: periods[0] };
  }));

  ['am', 'pm'].forEach((period) => {
    if (day.periods[period].manualAdjustment) {
      return;
    }

    const type = day.periods[period].isRest ? 'work' : 'rest';
    const draft = {
      type, startDate: dateKey, startPeriod: period, endDate: dateKey, endPeriod: period
    };
    if (calculateAdjustmentDays(draft, state.settings, calendarHolidays) === 0
      || hasAdjustmentOverlap(draft, state.adjustments, state.settings, calendarHolidays)) {
      return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'adjustment-picker-item available';
    button.dataset.pickPeriod = period;
    const title = document.createElement('strong');
    title.textContent = `${period === 'am' ? '上午' : '下午'} · 发起调班（${type === 'rest' ? '调休' : '补班'}）`;
    const status = document.createElement('span');
    status.textContent = `当前${day.periods[period].isRest ? '休息' : '上班'} · 可调班 0.5 天`;
    button.append(title, status);
    entries.push({ button, period });
  });

  entries.sort((left, right) => left.period.localeCompare(right.period));
  elements.adjustmentPickerList.replaceChildren(...entries.map((entry) => entry.button));
  elements.adjustmentPicker.showModal();
}

function getDefaultAdjustmentForDate(dateKey) {
  const day = classifyDay(dateKey, state.settings, calendarHolidays, state.adjustments);
  const adjustedPeriod = ['am', 'pm'].find((period) => day.periods[period].manualAdjustment);
  if (adjustedPeriod) {
    const type = day.periods[adjustedPeriod].manualAdjustment;
    const recordId = day.periods[adjustedPeriod].manualAdjustmentId;
    const record = state.adjustments.find((item) => item.id === recordId) ?? null;
    const matchingPeriods = ['am', 'pm'].filter((period) => day.periods[period].manualAdjustment === type);
    return {
      type,
      record,
      periods: { start: matchingPeriods[0], end: matchingPeriods.at(-1) }
    };
  }

  const workingPeriods = ['am', 'pm'].filter((period) => !day.periods[period].isRest);
  if (workingPeriods.length > 0) {
    return {
      type: 'rest',
      periods: { start: workingPeriods[0], end: workingPeriods.at(-1) }
    };
  }

  return { type: 'work', periods: { start: 'am', end: 'pm' } };
}

function renderAdjustmentType() {
  const isCorrection = selectedAdjustmentType === 'correction';
  elements.adjustmentDialogTitle.textContent = isCorrection ? '修正日期'
    : selectedAdjustmentId ? '编辑调班' : '新增调班';
  const day = classifyDay(selectedAdjustmentDateKey, state.settings, calendarHolidays, state.adjustments);
  elements.newAdjustment.hidden = !selectedAdjustmentId || isCorrection
    || ['am', 'pm'].every((period) => day.periods[period].manualAdjustment);
  elements.adjustmentType.querySelectorAll('button').forEach((button) => {
    const selected = button.dataset.value === selectedAdjustmentType;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  elements.associationControl.querySelectorAll('input[type="radio"]').forEach((input) => {
    input.checked = input.value === associationType;
  });
  setDialogFieldsEnabled(elements.adjustmentFields, !isCorrection);
  setDialogFieldsEnabled(elements.correctionFields, isCorrection);
  const primarySection = activeAdjustmentRangeType === 'work'
    ? elements.workRangeSection : elements.restRangeSection;
  const counterpartSection = activeAdjustmentRangeType === 'work'
    ? elements.restRangeSection : elements.workRangeSection;
  counterpartSection.before(primarySection);
  setDialogFieldsEnabled(primarySection, !isCorrection);
  setDialogFieldsEnabled(counterpartSection, !isCorrection && associationType === 'required');
}

function setDialogFieldsEnabled(container, enabled) {
  container.hidden = !enabled;
  container.querySelectorAll('input, select, textarea').forEach((field) => {
    field.disabled = !enabled;
  });
}

function updateActiveDialogPreview() {
  if (selectedAdjustmentType === 'correction') {
    updateDatePreview();
    return;
  }
  updateAdjustmentPreview();
}

function getAdjustmentDraft() {
  const restRanges = [...elements.restRangeList.children].map((row) => readRangeRow(row, 'rest'));
  const workRanges = [...elements.workRangeList.children].map((row) => readRangeRow(row, 'work'));
  return {
    id: selectedAdjustmentId,
    associationType,
    ranges: associationType === 'none'
      ? activeAdjustmentRangeType === 'work' ? workRanges : restRanges
      : [...restRanges, ...workRanges],
    note: elements.adjustmentNote.value.trim()
  };
}

function hasValidAdjustmentRange(range) {
  if (!range.startDate || !range.endDate || range.endDate < range.startDate) {
    return false;
  }
  return range.startDate !== range.endDate
    || range.startPeriod === 'am'
    || range.endPeriod === 'pm';
}

function getAdjustmentValidation(record, leaveRanges = [], context = {}) {
  const { selection = null, adjustments = state.adjustments } = context;
  let records;

  try {
    records = getVacationReplacementRecords(adjustments, selection);
  } catch (error) {
    return error.message;
  }

  if (record.ranges.length === 0) {
    return '至少添加一个调休或补班日期';
  }
  const allRanges = [...record.ranges, ...leaveRanges];

  if (allRanges.some((range) => !hasValidAdjustmentRange(range))) {
    return '结束时间不能早于开始时间，且每个范围都需填日期';
  }

  const combined = { ...record, ranges: allRanges };
  const currentRecords = [combined];

  if (hasAdjustmentOverlap(combined, currentRecords, state.settings, calendarHolidays)) {
    return '本次调班有重复的半天';
  }

  if (selection && hasAdjustmentOverlap(combined, records, state.settings, calendarHolidays)) {
    return '推荐日期包含其他调班，请重新生成方案';
  }

  if (record.associationType === 'none'
    && hasAdjustmentOverlap(record, records, state.settings, calendarHolidays)) {
    return '所选范围包含已调班时段';
  }

  const leaveRecord = { ...record, ranges: leaveRanges };

  if (leaveRanges.length && hasAdjustmentOverlap(leaveRecord, records, state.settings, calendarHolidays)) {
    return '免补班假期包含已调班时段';
  }

  if (allRanges.some((range) => calculateAdjustmentDays(range, state.settings, calendarHolidays) === 0)) {
    return '有日期范围不包含可调班的半天';
  }

  return '';
}

function updateAdjustmentPreview() {
  const record = getAdjustmentDraft();
  const context = { selection: recommendationSelection };
  const error = getAdjustmentValidation(record, recommendationLeaveRanges, context);
  const replacing = Boolean(recommendationSelection?.previousRecords.length);
  elements.recommendationLeavePreview.hidden = !recommendationLeaveRanges.length && !replacing;
  const leaveLabels = recommendationLeaveRanges.map((range) => formatRecommendationRange(range));
  const replacementNote = replacing ? '保存后替换原推荐方案；关闭不保存则保留原方案。' : '';
  let leaveNote = '';

  if (leaveLabels.length) leaveNote = `假期（无需补班，将一并保存）：${leaveLabels.join('；')}`;

  elements.recommendationLeavePreview.textContent = replacementNote + leaveNote;

  if (error) {
    elements.adjustmentPreview.textContent = error;
    elements.adjustmentPreview.classList.add('invalid');
    return;
  }

  const currentRecords = [record];
  const summary = getAdjustmentSummary(currentRecords, state.settings, calendarHolidays);
  elements.adjustmentPreview.textContent = `本次调休 ${formatDays(summary.restTotal)} 天 · 补班 ${formatDays(summary.workTotal)} 天${record.associationType === 'required' && (!summary.restTotal || !summary.workTotal) ? ' · 关联日期可后续补充' : ''}`;
  elements.adjustmentPreview.classList.remove('invalid');
}

async function saveAdjustmentRecord() {
  const draft = getAdjustmentDraft();
  const leaveRanges = structuredClone(recommendationLeaveRanges);
  const selection = structuredClone(recommendationSelection);
  const context = { selection };
  const error = getAdjustmentValidation(draft, leaveRanges, context);
  if (error) {
    showToast(error, true);
    return false;
  }
  const operationId = selectedAdjustmentId;
  const rangeType = activeAdjustmentRangeType;
  await commitState((next) => {
    const validationContext = { selection, adjustments: next.adjustments };
    const validationError = getAdjustmentValidation(draft, leaveRanges, validationContext);

    if (validationError) throw new Error(validationError);

    const existing = next.adjustments.find((record) => record.id === operationId);
    const detachedRanges = draft.associationType === 'none'
      ? getAdjustmentRanges(existing).filter((range) => range.type !== rangeType) : [];

    let detached = null;

    if (detachedRanges.length) {
      detached = { ...existing, id: createAdjustmentId(), associationType: 'none', ranges: detachedRanges };
    }

    let recordId = operationId || createAdjustmentId();

    if (selection) recordId = `${selection.groupId}|m`;

    const record = {
      ...draft,
      id: recordId,
      createdAt: existing?.createdAt ?? Date.now()
    };

    const baseline = getVacationReplacementRecords(next.adjustments, selection);
    const original = baseline.filter((item) => item.id !== operationId);
    let reconciliation = { mergedIds: [], remaining: [] };

    if (record.associationType === 'required' && !selection) {
      reconciliation = mergeAssociatedAdjustment(record, original, next.settings, calendarHolidays);
    }

    const remaining = reconciliation.remaining.map((item) => ({ ...item, id: createAdjustmentId() }));
    const detachedRecords = detached ? [detached] : [];
    const leaveRecords = [];

    if (leaveRanges.length) {
      let leaveId = createAdjustmentId();

      if (selection) leaveId = `${selection.groupId}|l`;

      leaveRecords.push({ id: leaveId, associationType: 'none', ranges: leaveRanges,
        note: '假期（无需补班）', createdAt: record.createdAt });
    }

    next.adjustments = sanitizeAdjustmentRecords([
      ...original.filter((item) => !reconciliation.mergedIds.includes(item.id)),
      ...remaining, ...detachedRecords, record, ...leaveRecords
    ]);
  });

  render();
  showToast('调班操作已保存');
  return true;
}

function createAdjustmentId() {
  return window.crypto?.randomUUID?.() ?? `adjustment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 只撤回本假期已采用方案，调休、补班及免补班假期在同次提交中移除。
 */
async function cancelVacationRecommendation(groupId) {
  const holiday = { dateKey: recommendationDateKey, endDate: recommendationEndDate };
  const selected = getVacationSelection(state.adjustments, holiday);

  if (!selected || selected.groupId !== groupId) return false;

  const selection = { ...holiday, previousRecords: structuredClone(selected.records) };
  await commitState((next) => {
    next.adjustments = getVacationReplacementRecords(next.adjustments, selection);
  });

  render();
  renderVacationRecommendations();
  showToast('推荐方案已取消');
  return true;
}

function initializeDateCorrection(dateKey) {
  selectedDateKey = dateKey;
  const record = calendarHolidays[dateKey];
  const resolvedDay = classifyDay(dateKey, state.settings, calendarHolidays);
  const sourceCategories = Object.values(resolvedDay.periods).map((period) => period.sourceCategory);
  elements.editDate.value = dateKey;
  elements.editKind.value = record?.kind === 'block'
    ? sourceCategories.includes('pure-legal')
      ? 'legal'
      : sourceCategories.includes('adjusted-work')
        ? 'work'
        : sourceCategories.includes('makeup-off')
          ? 'off'
          : ''
    : record?.kind ?? '';
  elements.editName.value = record?.kind === 'block' ? resolvedDay.holiday?.name ?? '' : record?.name ?? '';
}

function updateDatePreview() {
  const dateKey = elements.editDate.value;
  if (!dateKey) {
    return;
  }

  const previewHolidays = { ...state.holidays };
  const kind = elements.editKind.value;
  if (kind) {
    previewHolidays[dateKey] = { kind, name: elements.editName.value };
  } else {
    delete previewHolidays[dateKey];
  }

  const holidays = buildCalendarHolidays(previewHolidays);
  const day = classifyDay(dateKey, state.settings, holidays);
  elements.datePreview.textContent = `${formatLongDate(dateKey)} · ${getDayPeriodText(day)}`;
}

async function saveDateEdit() {
  const dateKey = elements.editDate.value;
  const kind = elements.editKind.value;

  const originalDate = selectedDateKey;
  const name = elements.editName.value.trim();
  await commitState((draft) => {
    if (originalDate && originalDate !== dateKey) delete draft.holidays[originalDate];

    if (kind) {
      draft.holidays[dateKey] = { kind, name };
    } else {
      delete draft.holidays[dateKey];
    }
  });

  render();
  showToast('日期安排已保存');
}

function moveMonth(offset) {
  const date = new Date(Date.UTC(viewYear, viewMonth - 1 + offset, 1));
  viewYear = date.getUTCFullYear();
  viewMonth = date.getUTCMonth() + 1;
  render('navigation');
}

function exportData() {
  const exported = {
    version: STORAGE_VERSION,
    holidayData: encodeHolidays(state.holidays),
    loadedYears: state.loadedYears
  };

  const content = JSON.stringify(exported, null, 2);
  const blobParts = [content];
  const blobOptions = { type: 'application/json' };
  const blob = new Blob(blobParts, blobOptions);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = '法定假期安排.json';
  link.click();
  URL.revokeObjectURL(url);
  showToast('数据已导出');
}

async function importCustomColors(file) {
  try {
    const imported = JSON.parse(await file.text());
    const colors = decodeCustomColorsImport(imported);
    await commitState((draft) => {
      draft.customColors = colors;
      draft.colorSchemeId = 'custom';
    });
    applyColors();
    renderSettings();
    showToast('配色方案已导入');
  } catch (error) {
    showToast(error.message || '配色导入失败', true);
  } finally {
    elements.colorImportFile.value = '';
  }
}

async function importData(file) {
  let requestState;
  let importedYears = [];

  try {
    if (storageReadError) throw new Error('原数据读取失败，请重新打开插件后再导入假期安排');

    const content = JSON.parse(await file.text());
    const imported = decodeHolidayImport(content);
    requestState = { status: 'loading' };
    importedYears = imported.loadedYears;
    imported.loadedYears.forEach((year) => yearFetchStates.set(year, requestState));
    await commitState((draft) => {
      const replacement = replaceHolidayYears(draft, imported);
      Object.assign(draft, replacement);
    });

    const loadedState = { status: 'loaded' };
    imported.loadedYears.forEach((year) => {
      if (yearFetchStates.get(year) === requestState) yearFetchStates.set(year, loadedState);
    });
    imported.loadedYears.forEach((year) => yearQuotaSources.delete(year));
    render();
    showToast('假期安排已导入');
  } catch (error) {
    importedYears.forEach((year) => {
      if (yearFetchStates.get(year) === requestState) yearFetchStates.delete(year);
    });

    const message = error.message || '导入失败';
    showToast(message, true);
  } finally {
    elements.importFile.value = '';
  }
}

/**
 * 获取官方安排成功后，再一次性替换该年数据并清理个人调班。
 */
async function resetYearData() {
  const year = Number(elements.resetYear.value);

  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    showToast('请输入 1900 至 2200 年之间的年份', true);
    return;
  }

  if (storageReadError) {
    showToast('原数据读取失败，请重新打开插件后再重置', true);
    return;
  }

  const message = `重置 ${year} 年会重新获取官方安排，并删除该年的日期修正、个人调休和补班，继续吗？`;

  if (!window.confirm(message)) return;

  const previousFetchState = yearFetchStates.get(year);
  const requestState = { status: 'loading' };
  yearFetchStates.set(year, requestState);
  elements.resetData.disabled = true;

  try {
    const holidays = await fetchHolidayYear(year);

    if (yearFetchStates.get(year) !== requestState) return;

    const imported = { holidays, loadedYears: [year] };
    await commitState((draft) => {
      if (yearFetchStates.get(year) !== requestState) return false;

      const replacement = replaceHolidayYears(draft, imported);
      Object.assign(draft, replacement);
      draft.adjustments = removeAdjustmentYear(draft.adjustments, year);
    });

    if (yearFetchStates.get(year) !== requestState) return;

    const loadedState = { status: 'loaded' };
    yearFetchStates.set(year, loadedState);
    yearQuotaSources.delete(year);
    render();
    showToast(`${year} 年数据已重置`);
  } catch (error) {
    if (yearFetchStates.get(year) !== requestState) return;

    // 重置失败不丢失已完成的额度回退，也不恢复已作废的进行中请求。
    if (previousFetchState && !previousFetchState.promise && previousFetchState.status !== 'loading') {
      yearFetchStates.set(year, previousFetchState);
    } else {
      yearFetchStates.delete(year);
    }

    renderYearResult();
    const failureMessage = `重置失败，原数据已保留：${error.message}`;
    showToast(failureMessage, true);
  } finally {
    elements.resetData.disabled = false;
  }
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.classList.add('visible');
  toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 2200);
}

function toLocalDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDays(days) {
  return Number.isInteger(days) ? String(days) : days.toFixed(1);
}

function formatAdjustmentRange(record) {
  const periodLabels = { am: '上午', pm: '下午' };
  const formatDate = (dateKey) => {
    const [year, month, day] = dateKey.split('-');
    return `${year}/${Number(month)}/${Number(day)}`;
  };
  if (record.startDate === record.endDate) {
    const period = record.startPeriod === 'am' && record.endPeriod === 'pm'
      ? '全天'
      : periodLabels[record.startPeriod];
    return `${formatDate(record.startDate)} ${period}`;
  }

  return `${formatDate(record.startDate)} ${periodLabels[record.startPeriod]} - ${formatDate(record.endDate)} ${periodLabels[record.endPeriod]}`;
}

function formatHolidayDates(items) {
  let previousMonth = '';
  return items.map((item) => {
    const [, month, day] = item.dateKey.split('-');
    const monthLabel = month === previousMonth ? '' : `${Number(month)}月`;
    previousMonth = month;
    return `${monthLabel}${Number(day)}日`;
  }).join('、');
}

function formatLongDate(dateKey) {
  const [year, month, day] = dateKey.split('-');
  return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
}

/**
 * DOM 事件消费异步失败，表单保持打开，成功提示由保存后的业务步骤负责。
 */
function listenForSave(target, type, action) {
  target.addEventListener(type, (event) => {
    if (type === 'submit') event.preventDefault();

    const operation = Promise.resolve().then(() => action(event)).catch((error) => {
      console.error('日历操作失败', error);
      showToast(error.message || '操作失败', true);
    });

    event.calendarActions?.push(operation);
  });
}

document.querySelector('#calendar-prev-month').addEventListener('click', () => moveMonth(-1));
document.querySelector('#calendar-next-month').addEventListener('click', () => moveMonth(1));
document.querySelector('#today-button').addEventListener('click', () => {
  activeDateKey = toLocalDateKey(now);
  viewYear = now.getFullYear();
  viewMonth = now.getMonth() + 1;
  render('navigation');
});
elements.settingsToggle.addEventListener('click', () => {
  setView('settings');
  elements.settingsView.querySelector('[role="tab"][aria-selected="true"]').focus();
});

function returnToCalendar() {
  setView('calendar');
  elements.settingsToggle.focus();
}

elements.settingsFloatingBack.addEventListener('click', returnToCalendar);

elements.calendarGrid.addEventListener('click', (event) => {
  const day = event.target.closest('.day-cell');
  if (!day || event.button !== 0) {
    return;
  }

  const dateKey = day.dataset.date;
  activeDateKey = dateKey;
  if (Number(dateKey.slice(0, 4)) !== viewYear || Number(dateKey.slice(5, 7)) !== viewMonth) {
    viewYear = Number(dateKey.slice(0, 4));
    viewMonth = Number(dateKey.slice(5, 7));
    render('navigation');
    elements.calendarGrid.querySelector(`[data-date="${dateKey}"]`).focus();
    return;
  }

  const previous = elements.calendarGrid.querySelector('.day-cell.selected');
  if (previous) {
    previous.classList.remove('selected');
    previous.setAttribute('aria-pressed', 'false');
  }
  day.classList.add('selected');
  day.setAttribute('aria-pressed', 'true');
  renderSelectedDate();
});

/**
 * 两个平台的日期右键入口复用多记录选择和半天默认值。
 */
function openAdjustmentForDate(dateKey) {
  const records = state.adjustments.filter((record) => getAdjustmentRanges(record).some((range) =>
    range.startDate <= dateKey && range.endDate >= dateKey));
  const resolvedDay = classifyDay(dateKey, state.settings, calendarHolidays, state.adjustments);
  if (records.flatMap(getAdjustmentRanges).filter((range) => range.startDate <= dateKey
    && range.endDate >= dateKey).length > 1 || !canMergeDayPeriods(resolvedDay)) {
    openAdjustmentPicker(dateKey, records, resolvedDay);
  } else {
    const defaults = getDefaultAdjustmentForDate(dateKey);
    openAdjustmentDialog(defaults.type, defaults.record, dateKey, defaults.periods);
  }
}

elements.calendarGrid.addEventListener('contextmenu', (event) => {
  const day = event.target.closest('.day-cell');

  if (!day) return;

  event.preventDefault();
  const dateKey = day.dataset.date;
  activeDateKey = dateKey;
  renderCalendar();
  renderSelectedDate();
  openAdjustmentForDate(dateKey);
});

elements.adjustmentPicker.addEventListener('click', (event) => {
  if (event.target.closest('[data-picker-close]')) {
    elements.adjustmentPicker.close();
    return;
  }

  const dateKey = elements.adjustmentPicker.dataset.date;
  const selected = event.target.closest('[data-pick-adjustment-id]');
  if (selected) {
    const record = state.adjustments.find((item) => item.id === selected.dataset.pickAdjustmentId);
    if (record) {
      elements.adjustmentPicker.close();
      openAdjustmentDialog(selected.dataset.pickAdjustmentType, record, dateKey);
    }
    return;
  }

  const available = event.target.closest('[data-pick-period]');
  if (available) {
    elements.adjustmentPicker.close();
    openNewAdjustmentForDate(dateKey, available.dataset.pickPeriod);
    return;
  }

  if (event.target.closest('#picker-correction')) {
    elements.adjustmentPicker.close();
    openAdjustmentDialog('correction', null, dateKey);
  }
});

listenForSave(elements.calendarView, 'click', async (event) => {
  const deleteButton = event.target.closest('[data-delete-adjustment-id]');
  if (deleteButton) {
    const record = state.adjustments.find((item) => item.id === deleteButton.dataset.deleteAdjustmentId);
    const groupId = getVacationRecordGroup(record?.id ?? '');
    let message = '这会删除整次调班中的全部调休与补班日期，继续吗？';

    if (groupId) message = '这会取消整个推荐方案，包括调休、补班及免补班假期，继续吗？';

    if (record && window.confirm(message)) {
      await commitState((draft) => {
        draft.adjustments = draft.adjustments.filter((item) => item.id !== record.id
          && (!groupId || getVacationRecordGroup(item.id) !== groupId));
      });

      render();
      showToast('整次调班已删除');
    }
    return;
  }

  const adjustmentButton = event.target.closest('[data-adjustment-id]');
  if (adjustmentButton) {
    const record = state.adjustments.find((item) => item.id === adjustmentButton.dataset.adjustmentId);
    if (record) {
      openAdjustmentDialog(adjustmentButton.dataset.adjustmentType, record);
    }
    return;
  }

  const row = event.target.closest('.holiday-row');
  if (row) {
    const [year, month] = row.dataset.date.split('-').map(Number);
    activeDateKey = row.dataset.date;
    viewYear = year;
    viewMonth = month;
    render('navigation');
    openVacationRecommendations(row.dataset.date, row.dataset.holidayEndDate);
  }
});

listenForSave(elements.anchorMonday, 'change', async () => {
  if (!elements.anchorMonday.value) {
    renderSettings();
    return;
  }

  const anchorMonday = startOfWeek(elements.anchorMonday.value);
  await commitState((draft) => { draft.settings.anchorMonday = anchorMonday; });
  render();
});

listenForSave(elements.weekStartsOn, 'change', async () => {
  const weekStartsOn = Number(elements.weekStartsOn.value);
  await commitState((draft) => { draft.settings.weekStartsOn = weekStartsOn; });
  render();
});

const saveMonthlyMaximum = async () => {
  if (!elements.monthlyMaxAdjustmentDays.value || !elements.monthlyMaxAdjustmentDays.reportValidity()) return;

  const maximum = elements.monthlyMaxAdjustmentDays.valueAsNumber;
  await commitState((draft) => { draft.settings.monthlyMaxAdjustmentDays = maximum; });
  render();
};

listenForSave(elements.monthlyMaxAdjustmentDays, 'change', saveMonthlyMaximum);

const saveCrossMonthSetting = async () => {
  const allow = elements.allowCrossMonthAdjustment.checked;
  await commitState((draft) => { draft.settings.allowCrossMonthAdjustment = allow; });
  render();
};

listenForSave(elements.allowCrossMonthAdjustment, 'change', saveCrossMonthSetting);

elements.recommendationMaximum.addEventListener('input', prepareVacationRecommendations);
elements.recommendationLeaveDays.addEventListener('input', prepareVacationRecommendations);
elements.recommendationWorkMaximum.addEventListener('input', prepareVacationRecommendations);
elements.recommendationCrossMonth.addEventListener('change', prepareVacationRecommendations);

const useVacationRecommendation = (event) => {
  if (event.target.closest('[data-recommendation-close]')) elements.recommendationDialog.close();

  const use = event.target.closest('[data-use-recommendation]');

  if (!use) return;

  // 采用前重新计算，避免其他窗口提交调班后使用过期方案。
  renderVacationRecommendations();
  const plan = vacationRecommendations.find((item) => item.id === use.dataset.useRecommendation);

  if (!plan || plan.unavailable || !plan.ranges.length && !plan.leaveRanges.length) return;

  const record = { ranges: plan.ranges, leaveRanges: plan.leaveRanges, associationType: 'required', note: plan.title };
  const holiday = { dateKey: recommendationDateKey, endDate: recommendationEndDate };
  const selected = getVacationSelection(state.adjustments, holiday);
  const token = createAdjustmentId();
  const groupId = `rec|${holiday.dateKey}|${holiday.endDate}|${plan.id}|${token}`;
  record.recommendationSelection = { ...holiday, groupId,
    previousRecords: structuredClone(selected?.records ?? []) };

  if (!plan.ranges.length) {
    record.ranges = plan.leaveRanges;
    record.leaveRanges = [];
    record.associationType = 'none';
  }

  if (globalThis.calendarPlatform?.closeRecommendations) {
    globalThis.calendarPlatform.closeRecommendations().catch(reportRecommendationWindowError);
  }

  elements.recommendationDialog.close();
  openAdjustmentDialog('rest', record, recommendationDateKey);
};

elements.recommendationDialog.addEventListener('click', useVacationRecommendation);

const cancelSelectedVacation = async (event) => {
  const cancel = event.target.closest('[data-cancel-recommendation]');

  if (!cancel) return;

  const holiday = { dateKey: recommendationDateKey, endDate: recommendationEndDate };
  const selected = getVacationSelection(state.adjustments, holiday);

  if (selected?.groupId === cancel.dataset.cancelRecommendation) {
    await cancelVacationRecommendation(selected.groupId);
  }
};

listenForSave(elements.recommendationDialog, 'click', cancelSelectedVacation);

listenForSave(elements.appearanceMode, 'click', async (event) => {
  const button = event.target.closest('button[data-value]');
  if (!button || button.dataset.value === state.appearance) {
    return;
  }

  const appearance = button.dataset.value;
  await commitState((draft) => { draft.appearance = appearance; });
  applyColors();
  renderSettings();
});

listenForSave(elements.layoutDensity, 'click', async (event) => {
  const button = event.target.closest('button[data-value]');
  const layoutDensity = button?.dataset.value;

  if (!['compact', 'spacious'].includes(layoutDensity) || layoutDensity === state.layoutDensity) return;

  await commitState((draft) => { draft.layoutDensity = layoutDensity; });
  applyLayoutDensity();
  renderSettings();
});

listenForSave(elements.colorScheme, 'change', async () => {
  const id = elements.colorScheme.value;
  if (id !== 'default' && id !== 'custom' && !builtInColorSchemes.has(id)) {
    return;
  }
  await commitState((draft) => { draft.colorSchemeId = id; });
  applyColors();
  renderSettings();
});

systemDarkMedia.addEventListener('change', applyColors);

elements.colorMode.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-value]');
  if (!button || button.dataset.value === colorEditMode) {
    return;
  }
  colorEditMode = button.dataset.value;
  renderSettings();
});

elements.colorGrid.addEventListener('input', (event) => {
  const control = event.target.closest('input[data-color-token], input[data-alpha-token]');
  if (!control) {
    return;
  }
  previewColors = structuredClone(previewColors ?? state);

  if (previewColors.colorSchemeId !== 'custom') {
    const scheme = builtInColorSchemes.get(previewColors.colorSchemeId)?.colors;
    previewColors.customColors = scheme
      ? { light: { ...scheme.light }, dark: { ...scheme.dark } }
      : { light: {}, dark: {} };
    previewColors.colorSchemeId = 'custom';
    elements.colorScheme.value = 'custom';
  }
  const row = control.closest('.color-row');
  const input = row.querySelector('input[data-color-token]');
  const token = input.dataset.colorToken;
  const alpha = row.querySelector('input[data-alpha-token]');
  const color = input.value + (alpha
    ? Math.round((100 - Number(alpha.value)) / 100 * 255).toString(16).padStart(2, '0') : '');
  const defaultColor = COLOR_DEFAULTS[colorEditMode][token];
  if (color === defaultColor || (defaultColor.length === 7 && color === defaultColor + 'ff')) {
    delete previewColors.customColors[colorEditMode][token];
  } else {
    previewColors.customColors[colorEditMode][token] = color;
  }
  row.querySelector(':scope > output').textContent = input.value.toUpperCase();
  if (alpha) {
    alpha.nextElementSibling.textContent = alpha.value + '%';
  }
  elements.resetCustomColors.disabled = Object.keys(previewColors.customColors[colorEditMode]).length === 0;
  renderColorPreview();
  applyColors();
});
listenForSave(elements.colorGrid, 'change', async () => {
  const preview = previewColors;

  if (!preview) return;

  const colors = structuredClone(preview.customColors);

  try {
    await commitState((draft) => {
      draft.customColors = colors;
      draft.colorSchemeId = preview.colorSchemeId;
    });
  } finally {
    if (previewColors === preview) {
      previewColors = null;
      applyColors();
      renderSettings();
    }
  }
});

document.querySelector('#import-custom-colors').addEventListener('click', () => elements.colorImportFile.click());
elements.colorImportFile.addEventListener('change', () => {
  const [file] = elements.colorImportFile.files;
  if (file) {
    void importCustomColors(file);
  }
});

listenForSave(elements.resetCustomColors, 'click', async () => {
  const mode = colorEditMode;
  await commitState((draft) => { draft.customColors[mode] = {}; });
  applyColors();
  renderSettings();
});

const weekendPreset = document.querySelector('#weekend-preset');
listenForSave(weekendPreset, 'click', async (event) => {
  const button = event.target.closest('button[data-value]');
  const preset = WEEKEND_PRESETS[button?.dataset.value];
  if (!preset) {
    return;
  }

  await commitState((draft) => {
    draft.settings.weekendRules = { 5: { ...preset[5] }, 6: { ...preset[6] } };
  });

  render();
});

const settingsPanel = document.querySelector('.settings-panel');
listenForSave(settingsPanel, 'click', async (event) => {
  const button = event.target.closest('.weekend-period-control button[data-value]');
  if (!button) {
    return;
  }

  const row = button.closest('.weekend-period-row');
  const weekday = row.dataset.weekendDay;
  const restPeriod = button.dataset.value;
  await commitState((draft) => { draft.settings.weekendRules[weekday].restPeriod = restPeriod; });
  render();
});

listenForSave(settingsPanel, 'change', async (event) => {
  const input = event.target.closest('.weekend-repeat-interval');
  if (!input) {
    return;
  }

  const row = input.closest('.weekend-period-row');
  const weekday = row.dataset.weekendDay;
  const interval = Math.min(52, Math.max(0, Math.round(Number(input.value) || 0)));
  await commitState((draft) => { draft.settings.weekendRules[weekday].repeatIntervalWeeks = interval; });
  render();
});

document.querySelector('#import-data').addEventListener('click', () => elements.importFile.click());
elements.importFile.addEventListener('change', () => {
  const [file] = elements.importFile.files;
  if (file) {
    importData(file);
  }
});
document.querySelector('#export-data').addEventListener('click', exportData);
elements.resetYear.value = String(viewYear);
elements.resetData.addEventListener('click', resetYearData);

document.addEventListener('click', (event) => {
  const input = event.target.closest('input[type="date"]');
  if (!input || input.disabled || typeof input.showPicker !== 'function') {
    return;
  }
  try {
    input.showPicker();
  } catch {
    // The host may restrict native pickers; date text entry remains available.
  }
});

elements.editDate.addEventListener('change', updateDatePreview);
elements.editKind.addEventListener('change', updateDatePreview);
elements.editName.addEventListener('input', updateDatePreview);
elements.newAdjustment.addEventListener('click', () => {
  elements.adjustmentDialog.close();
  openNewAdjustmentForDate(selectedAdjustmentDateKey);
});
elements.adjustmentType.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-value]');
  if (!button || button.dataset.value === selectedAdjustmentType) {
    return;
  }
  if (button.dataset.value === 'correction') {
    selectedAdjustmentId = '';
    if (!selectedDateKey) {
      initializeDateCorrection(
        elements.adjustmentForm.querySelector('[data-range-field="startDate"]')?.value
          || selectedAdjustmentDateKey
      );
    }
  } else {
    selectedAdjustmentId = editingAdjustmentId;
  }
  selectedAdjustmentType = button.dataset.value;
  renderAdjustmentType();
  updateActiveDialogPreview();
});
elements.adjustmentType.addEventListener('keydown', (event) => {
  const tabs = [...elements.adjustmentType.querySelectorAll('[role="tab"]')];
  const active = tabs.findIndex((tab) => tab.dataset.value === selectedAdjustmentType);
  let next = active;
  if (event.key === 'ArrowRight') {
    next = (active + 1) % tabs.length;
  } else if (event.key === 'ArrowLeft') {
    next = (active - 1 + tabs.length) % tabs.length;
  } else if (event.key === 'Home') {
    next = 0;
  } else if (event.key === 'End') {
    next = tabs.length - 1;
  } else {
    return;
  }
  event.preventDefault();
  tabs[next].click();
  tabs[next].focus();
});
document.querySelector('#add-rest-range').addEventListener('click', () => {
  appendRange(elements.restRangeList);
  updateAdjustmentPreview();
});
document.querySelector('#add-work-range').addEventListener('click', () => {
  appendRange(elements.workRangeList);
  updateAdjustmentPreview();
});
elements.adjustmentFields.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-range]');
  if (button) {
    button.closest('.adjustment-range-row').remove();
    updateAdjustmentPreview();
  }
});
elements.adjustmentFields.addEventListener('change', (event) => {
  if (event.target.name === 'association-type') {
    associationType = event.target.value;
    renderAdjustmentType();
  }

  const field = event.target.dataset.rangeField;

  if (field === 'startDate' || field === 'endDate') {
    const row = event.target.closest('.adjustment-range-row');
    const startDate = row.querySelector('[data-range-field="startDate"]');
    const endDate = row.querySelector('[data-range-field="endDate"]');

    if (startDate.value && endDate.value && endDate.value < startDate.value) {
      if (field === 'startDate') {
        endDate.value = startDate.value;
        row.querySelector('[data-range-field="endPeriod"]').value = 'pm';
      } else {
        startDate.value = endDate.value;
        row.querySelector('[data-range-field="startPeriod"]').value = 'am';
      }
    }
  }

  updateAdjustmentPreview();
});
elements.adjustmentNote.addEventListener('input', updateAdjustmentPreview);
elements.adjustmentForm.addEventListener('click', (event) => {
  if (event.target.closest('[data-dialog-close]')) {
    elements.adjustmentDialog.close();
  }
});
elements.adjustmentDialog.addEventListener('click', (event) => {
  if (event.target !== elements.adjustmentDialog) {
    return;
  }
  const { left, right, top, bottom } = elements.adjustmentDialog.getBoundingClientRect();
  if (event.clientX < left || event.clientX >= right
    || event.clientY < top || event.clientY >= bottom) {
    elements.adjustmentDialog.close();
  }
});
listenForSave(elements.adjustmentForm, 'submit', async (event) => {
  event.preventDefault();
  const session = adjustmentSession;

  if (selectedAdjustmentType === 'correction') {
    await saveDateEdit();

    if (adjustmentSession === session) elements.adjustmentDialog.close();

    return;
  }

  const saved = await saveAdjustmentRecord();

  if (saved && adjustmentSession === session) {
    elements.adjustmentDialog.close();
  }
});

globalThis.calendarPlatform.onEnter?.(() => {
  viewYear = new Date().getFullYear();
  viewMonth = new Date().getMonth() + 1;
  setView('calendar');
  render('navigation');
});

window.addEventListener('online', () => {
  [viewYear, viewYear + 1].forEach((year) => {
    if (yearFetchStates.get(year)?.status !== 'error') return;

    yearFetchStates.delete(year);
    void ensureHolidayData(year);
  });
});

const application = {
  getState: () => encodeState(state),
  getSelectedDate: () => activeDateKey,
  notify: showToast,
  whenIdle: () => stateCommitQueue,
  refreshRecommendations: prepareVacationRecommendations,
  cancelRecommendation: cancelVacationRecommendation,
  render,
  commit: async (update) => {
    await commitState(update);
    render();
  },
  replaceState: async (encoded, updateExtension) => {
    const replacement = decodeState(encoded);
    yearFetchStates.clear();
    await commitState((draft) => {
      Object.assign(draft, replacement);
      updateExtension();
    });

    yearQuotaSources.clear();
    render();
  },
  selectDate: (dateKey) => {
    activeDateKey = dateKey;
    render('navigation');
  },
  openAdjustment: openAdjustmentForDate,
  openCorrection: (dateKey) => openAdjustmentDialog('correction', null, dateKey)
};

await globalThis.calendarPlatform.mount?.(application);
initializeSettingsTabs();
setView('calendar');
render();

if (globalThis.calendarPlatform.kind !== 'desktop' && typeof window.ResizeObserver === 'function') {
  const root = document.documentElement;
  const measuredHeights = new Map();

  const layoutObserver = new window.ResizeObserver((entries) => {
    for (const entry of entries) {
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;

      if (height <= 0 || measuredHeights.get(entry.target) === height) continue;

      measuredHeights.set(entry.target, height);
      const property = entry.target === elements.summaryBand ? '--summary-height' : '--calendar-panel-height';
      const cssHeight = `${height}px`;
      root.style.setProperty(property, cssHeight);
    }
  });

  layoutObserver.observe(elements.summaryBand);
  layoutObserver.observe(elements.calendarPanel);
}

void loadBuiltInColorSchemes().catch((error) => {
  console.error('内置配色读取失败', error);
  showToast('内置配色读取失败', true);
});
