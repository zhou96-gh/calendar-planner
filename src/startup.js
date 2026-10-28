/**
 * 等页面就绪后再加载业务模块，避免同步存储调用阻塞 uTools 装配。
 */
function scheduleApplicationStart() {
  const loadApplication = () => import('./bootstrap.js').catch((error) => {
    console.error('假期安排启动失败', error);
    const toast = document.querySelector('#toast');

    if (!toast) return;

    toast.textContent = '假期安排启动失败，请重新打开插件';
    toast.classList.add('visible', 'error');
  });

  // 使用独立任务，确保页面就绪事件先交给宿主处理，而非继续占用当前事件或微任务。
  setTimeout(loadApplication, 0);
}

if (document.readyState !== 'complete') {
  const readyOptions = { once: true };
  document.addEventListener('DOMContentLoaded', scheduleApplicationStart, readyOptions);
} else {
  scheduleApplicationStart();
}
