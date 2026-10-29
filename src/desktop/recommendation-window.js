import { emitTo } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import './styles.css';

const root = document.documentElement;
root.classList.add('platform-desktop', 'desktop-recommendation');
document.title = '休假推荐';
document.body.innerHTML = '<main id="recommendation-window-content"></main><p id="recommendation-window-error" role="status" hidden></p>';
const content = document.querySelector('#recommendation-window-content');
const errorOutput = document.querySelector('#recommendation-window-error');
let session = 0;
let sequence = 0;
let lastRevision = -1;

function report(error) {
  errorOutput.textContent = String(error.message || error);
  errorOutput.hidden = false;
}

/**
 * 只在换假期时装配公共模板；刷新结果时保留正在输入的半成品、焦点及滚动位置。
 */
function applySnapshot(snapshot) {
  if (snapshot.session < session || snapshot.revision <= lastRevision) return;

  const changedSession = snapshot.session !== session;

  if (!changedSession && snapshot.sequence < sequence) return;

  root.dataset.theme = snapshot.theme;
  root.dataset.layoutDensity = snapshot.layoutDensity ?? 'spacious';
  root.style.cssText = snapshot.style;
  lastRevision = snapshot.revision;

  if (changedSession) {
    session = snapshot.session;
    sequence = snapshot.sequence;
    content.innerHTML = snapshot.template;
    content.querySelector('#recommendation-maximum').value = snapshot.values.maximum;
    content.querySelector('#recommendation-leave-days').value = snapshot.values.leaveDays;
    content.querySelector('#recommendation-work-maximum').value = snapshot.values.workMaximum;
    content.querySelector('#recommendation-cross-month').checked = snapshot.values.crossMonth;
    errorOutput.hidden = true;
  }

  const maximum = content.querySelector('#recommendation-maximum');
  maximum.max = snapshot.limits.maximum;
  content.querySelector('#recommendation-maximum-label').textContent = snapshot.limits.label;

  if (!maximum.validity.badInput && maximum.valueAsNumber > Number(maximum.max)) {
    maximum.value = snapshot.values.maximum;
  }

  const results = content.querySelector('#vacation-recommendation-results');
  const scrollLeft = results.scrollLeft;
  const scrollTop = content.scrollTop;

  if (results.innerHTML !== snapshot.results) results.innerHTML = snapshot.results;

  results.scrollLeft = scrollLeft;
  content.scrollTop = scrollTop;
}

function send(action) {
  if (!session) return;

  const payload = { ...action, session, sequence: ++sequence };
  emitTo('main', 'recommendation-action', payload).catch(report);
}

function readValues() {
  const maximum = content.querySelector('#recommendation-maximum');
  const leaveDays = content.querySelector('#recommendation-leave-days');
  const workMaximum = content.querySelector('#recommendation-work-maximum');
  const crossMonth = content.querySelector('#recommendation-cross-month');
  return {
    maximum: maximum.value, leaveDays: leaveDays.value, workMaximum: workMaximum.value, crossMonth: crossMonth.checked,
    maximumBadInput: maximum.validity.badInput, workMaximumBadInput: workMaximum.validity.badInput,
    leaveBadInput: leaveDays.validity.badInput
  };
}

const configure = (event) => {
  if (!['recommendation-maximum', 'recommendation-leave-days', 'recommendation-work-maximum', 'recommendation-cross-month'].includes(event.target.id)) return;

  const values = readValues();
  const action = { kind: 'configure', values };
  send(action);
};

content.addEventListener('input', configure);
content.addEventListener('change', configure);

const click = (event) => {
  if (event.target.closest('[data-recommendation-close]')) {
    send({ kind: 'close' });
    return;
  }

  const cancel = event.target.closest('[data-cancel-recommendation]');

  if (cancel) {
    const action = { kind: 'cancel', value: cancel.dataset.cancelRecommendation };
    send(action);
    return;
  }

  const button = event.target.closest('[data-use-recommendation]');

  if (!button) return;

  const values = readValues();
  const action = { kind: 'use', value: button.dataset.useRecommendation, values };
  send(action);
};

content.addEventListener('click', click);
const escape = (event) => {
  if (event.key === 'Escape') send({ kind: 'close' });
};

document.addEventListener('keydown', escape);
const windowHandle = getCurrentWebviewWindow();

try {
  const receive = ({ payload }) => applySnapshot(payload);
  await windowHandle.listen('recommendation-snapshot', receive);
  await emitTo('main', 'recommendation-ready');
} catch (error) {
  report(error);
}
