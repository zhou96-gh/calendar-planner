import { isRecommendationAction, RECOMMENDATION_WINDOW } from './recommendation-protocol.js';

/**
 * 独立推荐窗复用公共表单及渲染结果，计算、状态提交和调班编辑仍留在主窗口。
 */
export async function connectRecommendations(context) {
  const { platform, application, dialog, notify } = context;
  const root = document.documentElement;
  const content = dialog.querySelector('.vacation-recommendation-content');
  const maximum = dialog.querySelector('#recommendation-maximum');
  const maximumLabel = dialog.querySelector('#recommendation-maximum-label');
  const leaveDays = dialog.querySelector('#recommendation-leave-days');
  const workMaximum = dialog.querySelector('#recommendation-work-maximum');
  const crossMonth = dialog.querySelector('#recommendation-cross-month');
  const results = dialog.querySelector('#vacation-recommendation-results');
  let session = 0;
  let sequence = 0;
  let revision = 0;
  let scheduled = false;
  let refreshing = false;

  async function publish() {
    if (!platform.recommendationsOpen) return;

    const payload = {
      session, sequence, revision: ++revision,
      template: content.innerHTML, results: results.innerHTML,
      values: { maximum: maximum.value, leaveDays: leaveDays.value, workMaximum: workMaximum.value, crossMonth: crossMonth.checked },
      limits: { maximum: maximum.max, label: maximumLabel.textContent },
      theme: root.dataset.theme, layoutDensity: root.dataset.layoutDensity, style: root.style.cssText
    };

    await platform.emitTo(RECOMMENDATION_WINDOW, 'recommendation-snapshot', payload);
  }

  function schedule() {
    if (scheduled) return;

    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      publish().catch(notify);
    });
  }

  platform.openRecommendations = async () => {
    const opening = ++session;
    sequence = 0;
    platform.recommendationsOpen = true;
    maximum.setCustomValidity('');
    leaveDays.setCustomValidity('');
    workMaximum.setCustomValidity('');

    try {
      const argumentsValue = { session: opening };
      await platform.invoke('show_vacation_recommendations', argumentsValue);
      await publish();
    } catch (error) {
      if (session === opening) platform.recommendationsOpen = false;

      throw error;
    }
  };

  platform.closeRecommendations = async () => {
    platform.recommendationsOpen = false;
    await platform.invoke('hide_vacation_recommendations');
  };

  platform.refreshRecommendations = () => {
    if (!platform.recommendationsOpen || refreshing) return;

    refreshing = true;
    queueMicrotask(() => {
      refreshing = false;

      if (platform.recommendationsOpen) application.refreshRecommendations().catch(notify);
    });
  };

  await platform.listen('recommendation-ready', schedule);
  const close = ({ payload }) => {
    if (payload === session) platform.recommendationsOpen = false;
  };

  await platform.listen('recommendation-closed', close);

  const receive = async ({ payload }) => {
    if (!isRecommendationAction(payload) || !platform.recommendationsOpen
      || payload.session !== session || payload.sequence <= sequence) return;

    sequence = payload.sequence;
    const current = sequence;

    try {
      if (payload.kind === 'close') {
        await platform.closeRecommendations();
        return;
      }

      await application.whenIdle();

      if (!platform.recommendationsOpen || payload.session !== session) return;

      if (payload.kind === 'cancel') {
        await application.cancelRecommendation(payload.value);
        return;
      }

      if (current !== sequence) return;

      maximum.value = payload.values.maximum;
      leaveDays.value = payload.values.leaveDays;
      workMaximum.value = payload.values.workMaximum;
      crossMonth.checked = payload.values.crossMonth;
      const maximumError = payload.values.maximumBadInput ? '请输入有效天数' : '';
      const workError = payload.values.workMaximumBadInput ? '请输入有效天数' : '';
      const leaveError = payload.values.leaveBadInput ? '请输入有效天数' : '';
      maximum.setCustomValidity(maximumError);
      workMaximum.setCustomValidity(workError);
      leaveDays.setCustomValidity(leaveError);
      await application.refreshRecommendations();

      if (payload.kind === 'use') {
        if (!platform.recommendationsOpen || payload.session !== session || current !== sequence) return;

        await platform.invoke('focus_calendar');

        if (!platform.recommendationsOpen || payload.session !== session || current !== sequence) return;

        const target = Array.from(results.querySelectorAll('[data-use-recommendation]'))
          .find((button) => button.dataset.useRecommendation === payload.value);

        target?.click();
      }
    } catch (error) {
      notify(error);
    } finally {
      await publish().catch(notify);
    }
  };

  await platform.listen('recommendation-action', receive);
  const observer = new MutationObserver(schedule);
  const contentOptions = { childList: true, subtree: true, characterData: true };
  observer.observe(content, contentOptions);
  const rootOptions = { attributes: true, attributeFilter: ['style', 'data-theme', 'data-layout-density'] };
  observer.observe(root, rootOptions);
}
