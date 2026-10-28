import { createUtoolsPlatform } from './platforms/utools.js';

if ('__TAURI_INTERNALS__' in window && Number.isInteger(window.__CALENDAR_ATTACHMENT__)) {
  await import('./desktop/attachment-window.js');
} else if ('__TAURI_INTERNALS__' in window) {
  const { createDesktopPlatform } = await import('./platforms/desktop.js');
  globalThis.calendarPlatform = await createDesktopPlatform();
  window.readBuiltInColorSchemes = globalThis.calendarPlatform.readColorSchemes;
} else {
  document.documentElement.classList.add('platform-utools');
  globalThis.calendarPlatform = createUtoolsPlatform(window, localStorage);
}

if (!Number.isInteger(window.__CALENDAR_ATTACHMENT__)) await import('./app.js');
