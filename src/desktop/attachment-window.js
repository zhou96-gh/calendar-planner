import { invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { readAttachmentAction } from './attachment-protocol.js';
import './styles.css';

const kind = window.__CALENDAR_ATTACHMENT__ === 0 ? 'info' : 'holidays';
const title = kind === 'info' ? '日期与待办' : '节日与假期';
const root = document.documentElement;
root.classList.add('platform-desktop', 'desktop-attachment');
document.title = title;
document.body.innerHTML = `
  <main class="attachment-shell">
    <header class="desktop-titlebar">
      <span id="attachment-drag" class="attachment-drag" tabindex="0" role="button" aria-label="拖动选择主窗口左侧或右侧">${title}</span>
      <button type="button" id="attachment-close" title="收起" aria-label="收起${title}">×</button>
    </header>
    <section id="attachment-content" class="attachment-content" aria-label="${title}"></section>
    <p id="attachment-error" role="status" hidden></p>
  </main>`;
const content = document.querySelector('#attachment-content');
const errorOutput = document.querySelector('#attachment-error');
const drag = document.querySelector('#attachment-drag');
let lastHtml = '';
let lastRevision = -1;
let dragging = false;
let moving = false;
let pendingMove = false;
let dragQueue = Promise.resolve();
let dragSession = 0;

/**
 * 原生失败留在本窗口显示，不影响主窗口已有状态。
 */
function report(error) {
  errorOutput.textContent = String(error.message || error);
  errorOutput.hidden = false;
}

/**
 * 替换内容时保留本窗口的折叠和滚动状态，不重新计算业务数据。
 */
function applySnapshot(snapshot) {
  if (snapshot.revision < lastRevision) return;

  lastRevision = snapshot.revision;
  root.dataset.theme = snapshot.theme;
  root.dataset.layoutDensity = snapshot.layoutDensity ?? 'spacious';
  root.style.cssText = snapshot.style;
  root.classList.toggle('desktop-locked', snapshot.locked);
  const lockedValue = String(snapshot.locked);
  drag.setAttribute('aria-disabled', lockedValue);
  const html = snapshot[kind];

  if (html === lastHtml) {
    content.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.checked = input.hasAttribute('checked');
    });

    return;
  }

  const opened = new Map(Array.from(content.querySelectorAll('details[id]')).map((item) => [item.id, item.open]));
  const scrollTop = content.scrollTop;
  const focusedTabId = document.activeElement?.closest('[role="tab"][data-desktop-view]')?.id;
  content.innerHTML = html;
  content.querySelectorAll('details[id]').forEach((item) => {
    if (opened.has(item.id)) item.open = opened.get(item.id);
  });

  content.scrollTop = scrollTop;

  if (focusedTabId) document.getElementById(focusedTabId)?.focus({ preventScroll: true });

  lastHtml = html;
}

/**
 * 移动请求合并为串行队列，释放时等待最后一次移动完成再吸附。
 */
async function move(session) {
  if (moving || !dragging || session !== dragSession) return;

  moving = true;

  try {
    while (pendingMove && dragging && session === dragSession) {
      pendingMove = false;
      await invoke('move_attachment_drag');
    }
  } finally {
    moving = false;
  }
}

drag.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || root.classList.contains('desktop-locked')) return;

  event.preventDefault();
  drag.setPointerCapture(event.pointerId);
  dragging = true;
  const session = ++dragSession;
  dragQueue = dragQueue.then(() => invoke('begin_attachment_drag')).catch((error) => {
    if (session !== dragSession) return;

    dragging = false;
    report(error);
  });
});
drag.addEventListener('pointermove', () => {
  if (!dragging) return;

  pendingMove = true;
  const session = dragSession;
  dragQueue = dragQueue.then(() => move(session)).catch(report);
});

/**
 * Pointer Capture 保证鼠标移出窗口后仍能结束拖动；吸附方向由物理坐标判断。
 */
function finishDrag() {
  if (!dragging) return;

  dragging = false;
  pendingMove = false;
  const session = dragSession;
  dragQueue = dragQueue.then(() => invoke('finish_attachment_drag')).catch((error) => {
    if (session === dragSession) report(error);
  });
}

drag.addEventListener('pointerup', finishDrag);
drag.addEventListener('pointercancel', finishDrag);
drag.addEventListener('lostpointercapture', finishDrag);
drag.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;

  event.preventDefault();
  const argumentsValue = { left: event.key === 'ArrowLeft' };
  invoke('finish_attachment_drag', argumentsValue).catch(report);
});
document.querySelector('#attachment-close').addEventListener('click', () => invoke('hide_attachment').catch(report));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') invoke('hide_attachment').catch(report);
});

content.addEventListener('keydown', (event) => {
  const tab = event.target.closest('[role="tab"][data-desktop-view]');

  if (!tab) return;

  const tabs = Array.from(tab.parentElement.querySelectorAll('[role="tab"]'));
  const current = tabs.indexOf(tab);
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
  tabs[next].focus();
  tabs[next].click();
});

for (const type of ['click', 'change']) {
  content.addEventListener(type, (event) => {
    const action = readAttachmentAction(event.target, type);

    if (!action) return;

    emitTo('main', 'attachment-action', action).catch(report);
  });
}

const windowHandle = getCurrentWebviewWindow();

try {
  await windowHandle.listen('attachment-snapshot', ({ payload }) => applySnapshot(payload));
  const ready = { kind };
  await emitTo('main', 'attachment-ready', ready);
} catch (error) {
  report(error);
}
