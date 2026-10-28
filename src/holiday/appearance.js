export const COLOR_DEFAULTS = {
  light: {
    page: '#eef0ed', surface: '#ffffff', panel: '#f8f9f7',
    'panel-muted': '#f1f3f1', header: '#202522', 'header-text': '#ffffff',
    'header-muted': '#b9c0bb', text: '#202522', muted: '#66706a',
    faint: '#89908c', 'toc-bg': '#f8f9f7f5',
    border: '#d8ddda', 'border-strong': '#cfd5d1', control: '#e8ebe8',
    hover: '#f4f6f4', 'warm-hover': '#f4e9e7', 'badge-bg': '#dcece8',
    primary: '#d94b3d', 'primary-hover': '#bf3d31', 'primary-text': '#ffffff',
    'error-strong': '#a83a31',
    'rest-bg': '#edf7f4', 'holiday-bg': '#fde9e6', 'manual-rest-bg': '#fff4cf',
    'manual-work-bg': '#f2eef8', green: '#267568', red: '#b5453b',
    purple: '#60478f', gold: '#966108', stripe: '#26756824',
    'tag-work-bg': '#e7def4', 'tag-suggestion-bg': '#fff0cf', 'tag-holiday-bg': '#f8deda',
    'preview-bg': '#eef5f2', 'preview-error-bg': '#f8ebe9', 'tag-neutral-bg': '#20252214'
  },
  dark: {
    page: '#303633', surface: '#48514a', panel: '#3e4741',
    'panel-muted': '#515b53', header: '#292f2c', 'header-text': '#f9faf8',
    'header-muted': '#d4ddd5', text: '#f7f9f6', muted: '#d1dbd3',
    faint: '#b9c6bc', 'toc-bg': '#3e4741f2',
    border: '#758178', 'border-strong': '#94a296', control: '#56615a',
    hover: '#606b61', 'warm-hover': '#654c4d', 'badge-bg': '#435e4e',
    primary: '#f0bb9f', 'primary-hover': '#ffd0b1', 'primary-text': '#2f3430',
    'error-strong': '#f0aaa4',
    'rest-bg': '#465b4e', 'holiday-bg': '#5c4d50', 'manual-rest-bg': '#5e5544',
    'manual-work-bg': '#534e5e', green: '#bde6cf', red: '#ffd0c5',
    purple: '#e1d0ed', gold: '#f4dcaf', stripe: '#bde6cf3f',
    'tag-work-bg': '#5d536a', 'tag-suggestion-bg': '#6a5941', 'tag-holiday-bg': '#694c50',
    'preview-bg': '#495f50', 'preview-error-bg': '#624d50', 'tag-neutral-bg': '#ffffff24'
  }
};

/**
 * 公共页面和桌面存储共用有效配色计算，自定义覆盖保持稀疏。
 */
export function getPalette(mode, state, schemes) {
  let overrides = schemes.get(state.colorSchemeId)?.colors[mode] ?? {};

  if (state.colorSchemeId === 'custom') overrides = state.customColors[mode];

  return { ...COLOR_DEFAULTS[mode], ...overrides };
}
