import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { BUILT_IN_HOLIDAYS } from '../src/holiday/data.js';
import { DEFAULT_SETTINGS } from '../src/holiday/core.js';
import {
  STORAGE_VERSION,
  CUSTOM_COLOR_TOKENS,
  decodeState,
  decodeCustomColorsImport,
  decodeHolidayImport,
  encodeHolidays,
  encodeState,
  replaceHolidayYears
} from '../src/holiday/storage.js';

/**
 * 将公共间距表达式还原为基准值，继续核对既有布局比例。
 */
function readBaseStyles() {
  const cssUrl = new URL('../src/styles.css', import.meta.url);
  const css = readFileSync(cssUrl, 'utf8');
  return css.replace(/calc\((-?\d+(?:\.\d+)?) \* var\(--layout-space\)\)/g, '$1px');
}

test('两端间距统一使用窗口及密度比例，滚动避让保留 Tab 高度下限', () => {
  const stylePaths = ['../src/styles.css', '../src/desktop/styles.css'];

  for (const stylePath of stylePaths) {
    const cssUrl = new URL(stylePath, import.meta.url);
    const css = readFileSync(cssUrl, 'utf8');
    const declarations = css.matchAll(/(?<![\w-])((?:padding|margin)(?:-[a-z-]+)?|(?:row-|column-)?gap)\s*:\s*([^;{}]+);/g);

    for (const declaration of declarations) {
      const context = `${stylePath}: ${declaration[0]}`;
      assert.doesNotMatch(declaration[2], /-?\d*\.?\d+px\b/, context);
    }
  }

  const cssUrl = new URL('../src/styles.css', import.meta.url);
  const css = readFileSync(cssUrl, 'utf8');
  assert.match(css, /--layout-space: calc\(var\(--responsive-space\) \* var\(--layout-scale\)\)/);
  assert.match(css, /scroll-padding-top: max\(56px, calc\(64 \* var\(--layout-space\)\)\)/);
  const sidebar = css.match(/:root\.platform-utools \.result-panel,[^{]+\{([^}]+)\}/)?.[1];
  assert.ok(sidebar);
  assert.match(sidebar, /position: static;/);
  assert.match(sidebar, /grid-column: 2;/);
  assert.match(sidebar, /grid-row: 1 \/ 3;/);
  assert.match(sidebar, /min-height: var\(--calendar-panel-height, 0px\);/);
  assert.match(sidebar, /height: var\(--utools-sidebar-height\);/);
});

test('节假日区间元数据只存一次，日期恢复与内置数据一致', () => {
  const state = {
    settings: DEFAULT_SETTINGS,
    holidays: BUILT_IN_HOLIDAYS,
    loadedYears: [2026],
    adjustments: []
  };
  const encoded = encodeState(state);
  assert.equal(encoded.version, STORAGE_VERSION);
  assert.equal(encoded.holidays, undefined);
  assert.equal(encoded.holidayData.blocks.length, 8);
  assert.equal(encoded.holidayData.blocks.filter((block) => 'dates' in block).length, 2);
  assert.equal(encoded.holidayData.blocks.find((block) => block.name === '除夕').dates.length, 1);
  assert.deepEqual(decodeState(encoded).holidays, BUILT_IN_HOLIDAYS);
});

test('区间中删除或修正单日后，稀疏日期可无损恢复', () => {
  const holidays = { ...BUILT_IN_HOLIDAYS };
  delete holidays['2026-10-03'];
  holidays['2026-10-04'] = { kind: 'work', name: '法定补班' };
  const state = { settings: DEFAULT_SETTINGS, holidays, loadedYears: [2026], adjustments: [] };
  const encoded = encodeState(state);
  const block = encoded.holidayData.blocks.find((item) => item.name === '国庆节');
  assert.equal(block.dates.includes('2026-10-03'), false);
  assert.equal(block.dates.includes('2026-10-04'), false);
  assert.deepEqual(decodeState(encoded).holidays, holidays);
});

test('新格式状态与记录往返，旧版本直接拒绝', () => {
  const adjustment = { id: 'test-rest', associationType: 'none', ranges: [{
    type: 'rest', startDate: '2026-09-14', startPeriod: 'am',
    endDate: '2026-09-14', endPeriod: 'pm'
  }], note: '测试', createdAt: 1 };
  const state = {
    settings: DEFAULT_SETTINGS,
    holidays: BUILT_IN_HOLIDAYS,
    loadedYears: [2026],
    adjustments: [adjustment]
  };
  const expected = [{ id: 'test-rest', associationType: 'none', ranges: [{
    type: 'rest', startDate: '2026-09-14', startPeriod: 'am',
    endDate: '2026-09-14', endPeriod: 'pm'
  }], note: '测试', createdAt: 1 }];
  assert.deepEqual(decodeState(JSON.parse(JSON.stringify(encodeState(state)))).adjustments, expected);
  assert.deepEqual(encodeState(state).adjustments, expected);
  assert.throws(() => decodeState({ version: 5, holidays: BUILT_IN_HOLIDAYS }), /不支持的数据版本/);
  assert.throws(() => decodeState({ version: 6, holidayData: { blocks: [], days: {} } }),
    /不支持的数据版本/);
  assert.throws(() => decodeState({ version: 7, holidayData: { blocks: [], days: null } }),
    /节假日存储格式无效/);
  const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /const STORAGE_KEY = 'holiday-planner-state-v7'/);
  assert.match(appSource, /const LEGACY_STORAGE_KEYS = \[\s*'holiday-planner-state-v6'/);
  assert.deepEqual(encodeState({ ...state, adjustments: [{
    id: 'old', type: 'rest', startDate: '2026-09-14', startPeriod: 'am',
    endDate: '2026-09-14', endPeriod: 'pm'
  }] }).adjustments, []);
});

test('连续的同类型半天范围在状态读取与写入时保持合并', () => {
  const state = { settings: DEFAULT_SETTINGS, holidays: BUILT_IN_HOLIDAYS, loadedYears: [2026],
    adjustments: [{ id: 'paired', associationType: 'required', note: '', createdAt: 100, ranges: [
      { type: 'rest', startDate: '2026-09-28', startPeriod: 'am',
        endDate: '2026-09-29', endPeriod: 'am' },
      { type: 'work', startDate: '2026-09-19', startPeriod: 'am',
        endDate: '2026-09-20', endPeriod: 'pm' },
      { type: 'rest', startDate: '2026-09-29', startPeriod: 'pm',
        endDate: '2026-09-30', endPeriod: 'pm' }
    ] }] };
  const encoded = encodeState(state);
  assert.equal(encoded.adjustments[0].ranges.length, 2);
  assert.deepEqual(decodeState({ ...encoded, adjustments: state.adjustments }).adjustments,
    encoded.adjustments);
  assert.deepEqual(decodeState(encoded).adjustments, encoded.adjustments);
});

test('右键多项仍为列表，编辑窗口使用调班与修正 tab', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="adjustment-picker-list" class="adjustment-picker-list"/);
  assert.match(html, /id="adjustment-type"[^>]+role="tablist"/);
  assert.match(html, /id="adjustment-fields" role="tabpanel"/);
  assert.match(html, /id="correction-fields" role="tabpanel"/);
  assert.match(app, /button\.setAttribute\('aria-selected', String\(selected\)\)/);
  assert.match(app, /tabs\[next\]\.click\(\)/);
});

test('不需要关联时只编辑当前日期类型，已有另一类日期独立保留', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="rest-range-section"/);
  assert.match(html, /id="work-range-section"/);
  assert.ok(app.includes('counterpartSection.before(primarySection)'));
  assert.ok(app.includes("setDialogFieldsEnabled(counterpartSection, !isCorrection && associationType === 'required')"));
  assert.ok(app.includes("ranges: associationType === 'none'"));
  assert.ok(app.includes('getAdjustmentRanges(existing).filter((range) => range.type !== rangeType)'));
});

test('日历无顶栏，设置页无头部栏且保留悬浮返回入口', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readBaseStyles();
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /class="app-header"/);
  assert.match(html, /id="settings-toggle" class="settings-fab"/);
  assert.doesNotMatch(html, /class="settings-page-heading"/);
  assert.doesNotMatch(html, /id="settings-back"/);
  assert.match(html, /id="settings-floating-back" class="settings-back-fab"/);
  assert.doesNotMatch(html, /偏好设置/);
  assert.ok(css.includes('.settings-fab {'));
  assert.ok(css.includes('.settings-back-fab {'));
  assert.ok(css.includes('position: fixed;'));
  assert.ok(app.includes("settingsFloatingBack.addEventListener('click', returnToCalendar)"));
  assert.ok(app.includes('elements.settingsFloatingBack.hidden = !isSettings;'));
});

test('周末自定义支持上班并在输入框后显示间隔单位', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = readBaseStyles();
  assert.equal(html.match(/data-value="none">上班/g)?.length, 2);
  assert.equal(html.match(/<label class="repeat-field"><input class="weekend-repeat-interval"[^>]+\/><span>间隔（周）<\/span><\/label>/g)?.length, 2);
  assert.ok(css.includes('.weekend-period-control { grid-template-columns: repeat(4, 1fr); padding: 2px; }'));
  assert.ok(css.includes('grid-template-columns: 28px minmax(88px, 1fr) minmax(80px, 112px);'));
  assert.ok(css.includes('.repeat-field input { min-width: 32px; padding: 0 4px; flex: 1 1 56px; }'));
  assert.ok(!css.includes('.repeat-field { grid-column: 2; }'));
});

test('全局和日期格使用无边框岛屿布局、日历外壳内边距和右上角旗帜图片标签', () => {
  const css = readBaseStyles();
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const tagTexture = readFileSync(new URL('../assets/tag-ribbon-texture.png', import.meta.url));
  assert.ok(css.includes('grid-template-rows: minmax(0, 1fr) auto;\n  gap: 12px;\n  padding: 12px;'));
  assert.ok(css.includes('.calendar-panel, .adjustment-panel, .result-panel {\n  border: 0;\n  border-radius: 10px;'));
  assert.ok(css.includes('.calendar-board {\n  min-width: 0;\n  padding: 10px;\n  overflow-x: auto;\n  border: 0;\n  border-radius: 10px;'));
  assert.ok(css.includes('.weekday-header {\n  height: 30px;\n  align-items: center;\n  column-gap: 6px;'));
  assert.ok(css.includes('.calendar-grid {\n  gap: 6px;\n  border: 0;\n  background: transparent;'));
  assert.ok(css.includes('.day-cell {\n  --day-cell-background: var(--surface);'));
  assert.ok(css.includes('gap: 5px;\n  border: 0;\n  border-radius: 10px;'));
  assert.ok(css.includes('min-height: 0;\n  aspect-ratio: 1;'));
  assert.ok(css.includes('box-shadow: 0 2px 8px color-mix(in srgb, var(--text) 12%, transparent);'));
  assert.ok(css.includes('.summary-item {') && css.includes('border-right: 0;'));
  assert.ok(css.includes('.calendar-today-button {') && css.includes('border: 0;'));
  assert.ok(css.includes('.holiday-row {') && css.includes('.holiday-row:hover { background: var(--hover); }'));
  assert.ok(css.includes('.adjustment-row {') && css.includes('.adjustment-row.work { background: color-mix'));
  assert.ok(css.includes('.settings-view {\n  flex: 1;\n  min-height: 0;\n  padding: 0;\n  overflow: auto;\n  scroll-padding-top: max(56px, 64px);\n  background: var(--page);'));
  assert.ok(css.includes('width: min(760px, calc(100% - 96 * var(--layout-space)));\n  margin: 0 auto;'));
  assert.ok(css.includes('.settings-group {\n  min-width: 0;\n  padding: 28px;\n  border: 0;\n  border-radius: 10px;'));
  assert.ok(css.includes('grid-template-columns: minmax(0, 1fr);\n  grid-template-rows: auto minmax(0, 1fr);\n  align-items: stretch;'));
  assert.ok(css.includes('.day-cell.has-official-label .day-top {\n  padding-top: 0;\n  padding-right: 0;'));
  assert.ok(css.includes('.day-main {\n  min-width: 0;\n  min-height: 0;\n  display: flex;'));
  assert.ok(css.includes('.day-date-labels {\n  position: relative;\n  z-index: 1;\n  grid-column: 1;\n  grid-row: 1;'));
  assert.ok(css.includes('align-self: start;\n  justify-self: start;'));
  assert.ok(css.includes('flex-direction: row;\n  align-items: baseline;\n  justify-content: space-between;\n  gap: 2px;'));
  assert.ok(css.includes('font-size: 18px;\n  line-height: 1;'));
  assert.ok(css.includes('.day-name {\n  flex: none;\n  min-width: 0;\n  width: 100%;\n  color: var(--text);'));
  assert.ok(!css.includes('.day-name:not(:empty)::after'));
  assert.ok(app.includes('main.append(number, name);\n    top.append(dateLabels, main);'));
  assert.ok(app.includes('button.append(top, status);'));
  assert.ok(css.includes('background-image: url("../assets/tag-ribbon-texture.png");'));
  assert.ok(css.includes('.day-tags {\n  flex: none;\n  align-self: baseline;\n  margin-left: auto;'));
  assert.ok(css.includes('.day-cell.schedule-rest { --day-cell-background: var(--rest-bg); }'));
  assert.ok(css.includes('.day-cell.regular-work { --day-cell-background: transparent; }'));
  assert.ok(css.includes('.day-cell.official-holiday { --day-cell-background: var(--holiday-bg); }'));
  assert.ok(css.includes('.day-cell.manual-rest { --day-cell-background: var(--manual-rest-bg); }'));
  assert.ok(!css.includes('.day-cell.partial-rest {'));
  assert.ok(css.includes('.day-cell.selected::after {\n  content: "";\n  position: absolute;\n  inset: 0;\n  border: 2px solid var(--primary);'));
  assert.ok(!css.includes('.day-cell.selected:hover'));
  assert.ok(!css.includes('color-mix(in srgb, var(--day-cell-background) 72%, var(--primary))'));
  assert.ok(css.includes('inset 0 0 0 100vmax color-mix(in srgb, var(--hover) 22%, transparent)'));
  assert.ok(!css.includes('background-color: color-mix(in srgb, var(--day-cell-background) 78%, var(--hover))'));
  assert.ok(css.includes('.day-cell.consecutive-rest::before {'));
  assert.ok(css.includes('bottom: 2px;\n  left: 4px;\n  height: 2px;'));
  assert.ok(css.includes('.day-period-status {\n  position: absolute;\n  bottom: 5px;\n  left: 50%;'));
  assert.ok(css.includes('grid-template-columns: repeat(2, 4px);\n  gap: 6px;\n  transform: translateX(-50%);'));
  assert.ok(css.includes('width: 4px;\n  height: 4px;\n  border-radius: 0;'));
  assert.ok(css.includes('.period-status-item.regular-work { background: #fff; }'));
  assert.ok(css.includes('.day-cell.manual-work { --day-cell-background: var(--manual-work-bg); }'));
  assert.ok(app.includes("const visibleOfficialLabels = day.officialLabels.filter((label) => label === '放假');"));
  assert.ok(app.includes("button.classList.toggle('has-official-label', visibleOfficialLabels.length > 0);"));
  assert.ok(app.includes('visibleOfficialLabels.forEach((label) => {'));
  assert.ok(css.includes('.weekday-header, .calendar-grid { min-width: 0; }'));
  assert.ok(css.includes('.calendar-board { grid-column: 1 / -1; grid-row: 2; }'));
  assert.ok(css.includes('.weekday-header { height: 24px; }'));
  assert.ok(css.includes('.day-cell { min-height: 72px; border-radius: 7px; }'));
  assert.ok(!css.includes('.day-cell { min-height: 84px;'));
  assert.ok(css.includes('grid-template-columns: repeat(7, minmax(72px, 84px));\n  justify-content: safe center;'));
  assert.ok(!css.includes('.day-number { font-size: 12px; }'));
  assert.ok(!css.includes('.period-status-item { font-size: 0; }'));
  assert.ok(!css.includes('.summary-item strong { font-size: 24px; }'));
  assert.ok(!css.includes('.summary-item strong { font-size: 20px; }'));
  assert.deepEqual([...tagTexture.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('编辑弹窗外点击关闭，内部保持紧凑布局', () => {
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const css = readBaseStyles();
  assert.ok(app.includes("adjustmentDialog.addEventListener('click'"));
  assert.ok(app.includes('event.target !== elements.adjustmentDialog'));
  assert.ok(css.includes('width: calc(var(--range-form-width) + 32 * var(--layout-space))'));
  assert.ok(css.includes('min-width: calc(var(--range-form-width) + 32 * var(--layout-space))'));
  assert.ok(css.includes('#adjustment-form { padding: 16px; }'));
});

test('主题默认跟随系统，显式模式可往返且无效值回退', () => {
  const state = {
    settings: DEFAULT_SETTINGS,
    holidays: BUILT_IN_HOLIDAYS,
    loadedYears: [2026],
    adjustments: [],
    appearance: 'dark'
  };
  const encoded = encodeState(state);
  assert.equal(encoded.appearance, 'dark');
  assert.equal(decodeState(encoded).appearance, 'dark');
  assert.equal(decodeState({ ...encoded, appearance: 'light' }).appearance, 'light');
  assert.equal(decodeState({ ...encoded, appearance: 'invalid' }).appearance, 'system');
  const { appearance, ...legacyState } = encoded;
  assert.equal(decodeState(legacyState).appearance, 'system');
});

test('配色方案选择可往返保存，旧数据默认配色', () => {
  const state = {
    settings: DEFAULT_SETTINGS, holidays: BUILT_IN_HOLIDAYS,
    loadedYears: [2026], adjustments: [], colorSchemeId: 'calendar-colors-08-fresh-v2.json'
  };
  const encoded = encodeState(state);
  assert.equal(encoded.colorSchemeId, state.colorSchemeId);
  assert.equal(decodeState(encoded).colorSchemeId, state.colorSchemeId);
  assert.equal(decodeState({ ...encoded, colorSchemeId: 'custom' }).colorSchemeId, 'custom');
  assert.equal(decodeState({ ...encoded, colorSchemeId: '../outside.json' }).colorSchemeId, 'default');
  const { colorSchemeId, ...oldState } = encoded;
  assert.equal(decodeState(oldState).colorSchemeId, 'default');
});

test('排版密度可往返保存，旧数据和无效值默认宽松，假期导入保留密度', () => {
  const state = {
    settings: DEFAULT_SETTINGS, holidays: BUILT_IN_HOLIDAYS,
    loadedYears: [2026], adjustments: [], layoutDensity: 'compact'
  };

  const encoded = encodeState(state);
  const restored = decodeState(encoded);
  assert.equal(restored.layoutDensity, 'compact');
  const spacious = { ...encoded, layoutDensity: 'spacious' };
  const restoredSpacious = decodeState(spacious);
  assert.equal(restoredSpacious.layoutDensity, 'spacious');
  const { layoutDensity, ...legacy } = encoded;
  const restoredLegacy = decodeState(legacy);
  assert.equal(restoredLegacy.layoutDensity, 'spacious');

  for (const value of ['dense', null, 1, {}]) {
    const invalid = { ...encoded, layoutDensity: value };
    const restoredInvalid = decodeState(invalid);
    assert.equal(restoredInvalid.layoutDensity, 'spacious');
  }

  const imported = { holidays: { '2027-01-01': { kind: 'legal', name: '元旦' } }, loadedYears: [2027] };
  const replaced = replaceHolidayYears(state, imported);
  assert.equal(replaced.layoutDensity, 'compact');
});

test('内置配色配置名称、清单与预加载读取的目录一致', () => {
  const index = JSON.parse(readFileSync(new URL('../themes/index.json', import.meta.url), 'utf8'));
  const preloadUrl = new URL('../preload.js', import.meta.url);
  const context = {
    require: createRequire(preloadUrl),
    __dirname: dirname(fileURLToPath(preloadUrl)),
    window: {}
  };
  runInNewContext(readFileSync(preloadUrl, 'utf8'), context);
  const schemes = context.window.readBuiltInColorSchemes();
  assert.deepEqual(Array.from(schemes, (scheme) => scheme.id), index.files);
  assert.equal(schemes.length, index.files.length);
  assert.equal(new Set(schemes.map((scheme) => scheme.name)).size, schemes.length);
  for (const scheme of schemes) {
    assert.ok(scheme.name);
    const colors = decodeCustomColorsImport(scheme);
    assert.equal(Object.keys(colors.light).length, CUSTOM_COLOR_TOKENS.length);
    assert.equal(Object.keys(colors.dark).length, CUSTOM_COLOR_TOKENS.length);
  }
  const plugin = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
  assert.equal(plugin.preload, 'preload.js');
  const build = readFileSync(new URL('../scripts/build-offline.js', import.meta.url), 'utf8');
  assert.match(build, /'preload\.js'.*'themes'/);
});

test('默认深色配色和设置预览同步覆盖全部主题变量', () => {
  const app = readFileSync(new URL('../src/holiday/appearance.js', import.meta.url), 'utf8');
  const css = readBaseStyles();
  const darkDefaults = app.match(/  dark: \{([\s\S]*?)\n  \}\n\};/)?.[1];
  assert.ok(darkDefaults);
  const defaults = Object.fromEntries([...darkDefaults.matchAll(/(?:'([^']+)'|([a-z]+)):\s*'(#[0-9a-f]{6,8})'/g)]
    .map((match) => [match[1] ?? match[2], match[3]]));
  assert.equal(defaults.page, '#303633');
  assert.equal(defaults.surface, '#48514a');
  assert.equal(defaults.panel, '#3e4741');
  assert.equal(defaults['rest-bg'], '#465b4e');
  const blocks = [
    css.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1],
    css.match(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/)?.[1]
  ];
  for (const block of blocks) {
    assert.ok(block);
    const variables = Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6,8});/g)]
      .map((match) => [match[1], match[2]]));
    for (const token of CUSTOM_COLOR_TOKENS) {
      assert.equal(variables[token], defaults[token], token);
    }
  }
});

test('浅深自定义配色往返，错误颜色或字段被忽略', () => {
  const state = {
    settings: DEFAULT_SETTINGS,
    holidays: BUILT_IN_HOLIDAYS,
    loadedYears: [2026],
    adjustments: [],
    customColors: {
      light: { page: '#aBcD12', primary: '#123456', unknown: '#ffffff', text: 'red' },
      dark: { 'rest-bg': '#0a0b0c', green: '#88ffaa' }
    }
  };
  const encoded = encodeState(state);
  assert.deepEqual(encoded.customColors, {
    light: { page: '#abcd12', primary: '#123456' },
    dark: { green: '#88ffaa', 'rest-bg': '#0a0b0c' }
  });
  assert.deepEqual(decodeState(encoded).customColors, encoded.customColors);
  const { customColors, ...legacyState } = encoded;
  assert.deepEqual(decodeState(legacyState).customColors, { light: {}, dark: {} });
  assert.deepEqual(decodeState({ ...encoded, customColors: { light: [], dark: 'invalid' } }).customColors,
    { light: {}, dark: {} });
});

test('配色覆盖全部主题变量，透明度和旧配色可往返保存', () => {
  assert.equal(CUSTOM_COLOR_TOKENS.length, 36);
  const customColors = {
    light: {
      page: '#aBcD12', 'header-text': '#112233',
      'primary-hover': '#345678', stripe: '#26756880',
      'toc-bg': '#01020300', 'tag-neutral-bg': '#111111ff',
      green: '#aa00bbcc', unknown: '#ffffff'
    },
    dark: {
      'preview-error-bg': '#112233', gold: '#ffee11',
      stripe: '#112233', surface: '#11223344'
    }
  };
  const encoded = encodeState({
    settings: DEFAULT_SETTINGS, holidays: BUILT_IN_HOLIDAYS,
    loadedYears: [2026], adjustments: [], customColors
  });
  assert.deepEqual(encoded.customColors, {
    light: {
      page: '#abcd12', 'header-text': '#112233',
      'primary-hover': '#345678', stripe: '#26756880',
      'toc-bg': '#01020300', 'tag-neutral-bg': '#111111ff'
    },
    dark: { 'preview-error-bg': '#112233', gold: '#ffee11' }
  });
  assert.deepEqual(decodeState(encoded).customColors, encoded.customColors);
});

test('独立与完整数据文件可导入配色，浅深两套按导入值替换', () => {
  const palette = {
    light: { page: '#ABCD12', stripe: '#01234580', unknown: '#ffffff' },
    dark: { primary: '#112233', 'toc-bg': '#aabbcc44' }
  };
  const expected = {
    light: { page: '#abcd12', stripe: '#01234580' },
    dark: { 'toc-bg': '#aabbcc44', primary: '#112233' }
  };
  assert.deepEqual(decodeCustomColorsImport(palette), expected);
  const exported = encodeState({
    settings: DEFAULT_SETTINGS, holidays: BUILT_IN_HOLIDAYS,
    loadedYears: [2026], adjustments: [], customColors: palette
  });
  assert.deepEqual(decodeCustomColorsImport(exported), expected);
  assert.deepEqual(decodeCustomColorsImport({ light: {}, dark: {} }), { light: {}, dark: {} });
});

test('四类日期背景可导入透明度并在存储往返中保留，旧配色仍可导入', () => {
  const colors = decodeCustomColorsImport({
    light: { 'rest-bg': '#abcdef00', 'holiday-bg': '#12345680' },
    dark: { 'manual-rest-bg': '#11223366', 'manual-work-bg': '#445566' }
  });
  const encoded = encodeState({
    settings: DEFAULT_SETTINGS, holidays: BUILT_IN_HOLIDAYS,
    loadedYears: [2026], adjustments: [], customColors: colors
  });
  assert.deepEqual(decodeState(encoded).customColors, colors);
  assert.equal(colors.light['rest-bg'], '#abcdef00');
  assert.equal(colors.dark['manual-work-bg'], '#445566');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const token of ['rest-bg', 'holiday-bg', 'manual-rest-bg', 'manual-work-bg']) {
    assert.match(html, new RegExp('data-alpha-token="' + token + '"'));
  }
});

test('透明度滑杆 0% 为不透明，100% 为全透明，导入颜色格式不变', () => {
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(app, /color.length === 7 \? '0'/);
  assert.match(app, /1 - parseInt\(color.slice\(7\), 16\) \/ 255/);
  assert.match(app, /100 - Number\(alpha.value\)/);
  assert.match(html, /透明度滑杆 <code>0%<\/code> 完全不透明/);
});

test('配色导入拒绝残缺、无效值和无法识别的颜色', () => {
  assert.throws(() => decodeCustomColorsImport({ light: { page: '#112233' } }),
    /浅色和深色/);
  assert.throws(() => decodeCustomColorsImport({ customColors: null }),
    /浅色和深色/);
  assert.throws(() => decodeCustomColorsImport({ light: { page: '#12345678' }, dark: {} }),
    /light.page/);
  assert.throws(() => decodeCustomColorsImport({ light: {}, dark: { stripe: '#112233' } }),
    /dark.stripe/);
  assert.throws(() => decodeCustomColorsImport({ light: { unknown: '#123456' }, dark: {} }),
    /没有可识别/);
});

const testHolidayImportGuide = () => {
  const htmlUrl = new URL('../index.html', import.meta.url);
  const html = readFileSync(htmlUrl, 'utf8');
  const guide = html.match(/<details class="color-import-guide data-import-guide">([\s\S]*?)<\/details>/)?.[1];
  assert.ok(guide);
  const example = guide.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)?.[1];
  const imported = JSON.parse(example);
  const decoded = decodeHolidayImport(imported);
  assert.equal(imported.version, STORAGE_VERSION);
  assert.equal(decoded.holidays['2026-10-01'].kind, 'block');
  assert.equal(decoded.holidays['2026-10-02'], undefined);
  assert.equal(decoded.holidays['2026-10-03'].name, '示例假期');
  assert.equal(decoded.holidays['2026-09-25'].kind, 'legal');
  const reimported = {
    version: STORAGE_VERSION,
    holidayData: encodeHolidays(decoded.holidays),
    loadedYears: decoded.loadedYears
  };

  const roundTrip = decodeHolidayImport(reimported);
  assert.deepEqual(roundTrip.holidays, decoded.holidays);
  assert.equal(imported.settings, undefined);
  assert.equal(imported.adjustments, undefined);
  assert.match(guide, /保留其他年份、设置、配色和个人调班/);
  assert.match(guide, /旧版本文件不支持/);
};

test('假期导入说明示例可解码和无损往返，且不含个人配置', testHolidayImportGuide);

test('导入配色结构说明示例有效且列出全部受支持字段', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const guide = html.match(/<details class="color-import-guide">([\s\S]*?)<\/details>/)?.[1];
  assert.ok(guide);
  const example = guide.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)?.[1];
  assert.deepEqual(decodeCustomColorsImport(JSON.parse(example)), {
    light: { page: '#eef0ed', stripe: '#26756824' },
    dark: { page: '#141a16', stripe: '#75d0b130' }
  });
  const fields = [...guide.matchAll(/<dd><code>([^<]+)<\/code><\/dd>/g)]
    .flatMap((match) => match[1].split(', '));
  assert.deepEqual(fields, CUSTOM_COLOR_TOKENS);
  assert.match(guide, /四种日期背景/);
});
