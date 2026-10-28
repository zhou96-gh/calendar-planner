/**
 * 隔离 uTools 同步存储及再次进入事件，普通浏览器使用独立 localStorage。
 */
export function createUtoolsPlatform(host, browserStorage) {
  const storage = host.utools?.dbStorage;

  return {
    kind: storage ? 'utools' : 'browser',
    onEnter: (listener) => host.utools?.onPluginEnter?.(listener),
    storage: {
      getItem: (key) => {
        if (storage) return storage.getItem(key);

        const raw = browserStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      },
      setItem: (key, value) => {
        if (storage) {
          storage.setItem(key, value);
          return;
        }

        const serialized = JSON.stringify(value);
        browserStorage.setItem(key, serialized);
      },
      removeItem: (key) => {
        if (storage) return storage.removeItem(key);

        browserStorage.removeItem(key);
      }
    }
  };
}
