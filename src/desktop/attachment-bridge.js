import { findAttachmentTarget, serializeAttachmentSource } from './attachment-protocol.js';

/**
 * 主窗口是唯一计算与保存入口；附着窗口只消费渲染快照并回传有限动作。
 */
export async function connectAttachments(context) {
  const { platform, sources, notify } = context;
  const root = document.documentElement;
  let scheduled = false;
  let lastSnapshot = '';
  let revision = 0;

  /**
   * 同一轮 DOM 更新完成后合并发送，避免传出日期渲染到一半的视图。
   */
  async function publish(force = false) {
    const snapshot = {
      info: serializeAttachmentSource(sources[0]),
      holidays: serializeAttachmentSource(sources[1]),
      theme: root.dataset.theme,
      layoutDensity: root.dataset.layoutDensity,
      style: root.style.cssText,
      locked: root.classList.contains('desktop-locked')
    };

    const encoded = JSON.stringify(snapshot);

    if (!force && encoded === lastSnapshot) return;

    const payload = { ...snapshot, revision: ++revision };
    await Promise.all([
      platform.emitTo('sidebar-info', 'attachment-snapshot', payload),
      platform.emitTo('sidebar-holidays', 'attachment-snapshot', payload)
    ]);
    lastSnapshot = encoded;
  }

  /**
   * 只观察两个视图源和根外观属性，不观察整棵应用树。
   */
  function schedule() {
    if (scheduled) return;

    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      publish().catch(notify);
    });
  }

  await platform.listen('attachment-ready', () => { publish(true).catch(notify); });
  await platform.listen('attachment-action', async ({ payload }) => {
    let target = findAttachmentTarget(sources, payload);

    if (!target) {
      await publish(true).catch(notify);
      return;
    }

    try {
      if (!['view', 'todo-toggle'].includes(payload.kind)) await platform.invoke('focus_calendar');

      target = findAttachmentTarget(sources, payload);

      if (!target) return;

      const type = payload.kind === 'todo-toggle' ? 'change' : 'click';
      const options = { bubbles: true, cancelable: true };
      const event = new Event(type, options);
      event.calendarActions = [];

      if (type === 'change') target.checked = payload.checked;

      target.dispatchEvent(event);
      await Promise.all(event.calendarActions);
    } catch (error) {
      notify(error);
    } finally {
      await publish(true).catch(notify);
    }
  });

  const observer = new MutationObserver(schedule);
  const sourceOptions = { childList: true, subtree: true, characterData: true, attributes: true };
  sources.forEach((source) => observer.observe(source, sourceOptions));
  const rootOptions = { attributes: true, attributeFilter: ['style', 'data-theme', 'data-layout-density', 'class'] };
  observer.observe(root, rootOptions);
  schedule();
}
