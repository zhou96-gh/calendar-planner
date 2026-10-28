import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emitTo } from '@tauri-apps/api/event';
import { mountDesktop } from '../desktop/extension.js';
import { createDesktopExtension, decodeDesktopState, encodeDesktopState, sanitizeDesktop } from './desktop-state.js';

/**
 * 异步原生读取先于公共应用启动；同步读取只返回已经准备好的快照。
 */
export async function createDesktopPlatform() {
  const files = import.meta.glob('../../themes/*.json', { eager: true, import: 'default' });
  const entries = Object.entries(files)
    .filter(([path]) => !path.endsWith('/index.json'))
    .map(([path, value]) => ({ id: path.split('/').at(-1), ...value }));

  const schemes = new Map(entries.map((entry) => {
    const colors = { light: entry.light, dark: entry.dark };
    return [entry.id, { name: entry.name, colors }];
  }));

  let current = null;
  let extension = sanitizeDesktop();
  let readError = null;

  try {
    const saved = await invoke('load_state');

    if (saved) {
      const decoded = decodeDesktopState(saved);
      current = decoded.calendar;
      extension = decoded.desktop;
    }
  } catch (error) {
    readError = new Error(String(error));
  }

  const windowHandle = getCurrentWebviewWindow();
  const extensions = createDesktopExtension(extension);
  const platform = {
    ...extensions,
    kind: 'desktop',
    window: windowHandle,
    invoke,
    emitTo,
    listen: (event, handler) => windowHandle.listen(event, handler),
    readColorSchemes: () => entries,
    exportBackup: (calendar) => {
      const committed = extensions.getDesktop();
      return encodeDesktopState(calendar, committed, schemes);
    },
    importBackup: (value) => decodeDesktopState(value, true),
    mount: (application) => mountDesktop(platform, application),
    storage: {
      getItem: () => {
        if (readError) throw readError;

        return current;
      },
      removeItem: () => {},
      setItem: async (_key, value) => {
        if (readError) throw readError;

        const snapshot = structuredClone(value);
        const draft = extensions.getWriteExtension();
        const payload = encodeDesktopState(snapshot, draft, schemes);
        const argumentsValue = { state: payload };
        await invoke('save_state', argumentsValue);
        current = snapshot;
      }
    }
  };

  return platform;
}
