import './styles.css';
import { connectAttachments } from './attachment-bridge.js';

/**
 * 桌面只扩展宿主能力与待办；月历、调班、节日及设置仍使用公共页面。
 */
export async function mountDesktop(platform, application) {
  document.documentElement.classList.add('platform-desktop');
  document.title = '桌面日历';
  const shell = document.querySelector('.app-shell');
  const calendar = document.querySelector('#calendar-view');
  const settings = document.querySelector('.settings-panel');
  const header = document.createElement('header');
  header.className = 'desktop-titlebar';
  header.innerHTML = `
    <span class="desktop-drag" data-tauri-drag-region>桌面日历</span>
    <button type="button" id="desktop-info-toggle" class="desktop-sidebar-toggle" title="展开待办与调班" aria-label="展开待办与调班" aria-expanded="false">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m3 6 2 2 3-4M11 6h10M3 13h4M11 13h10M3 20h4M11 20h10" />
      </svg>
    </button>
    <button type="button" id="desktop-holidays-toggle" class="desktop-sidebar-toggle" title="展开节日与假期" aria-label="展开节日与假期" aria-expanded="false">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2M8 18h2" />
      </svg>
    </button>
    <button type="button" id="desktop-lock" title="锁定窗口">◇</button>
    <button type="button" id="desktop-close" title="退出程序">×</button>`;
  shell.prepend(header);
  const settingsToggle = document.querySelector('#settings-toggle');
  settingsToggle.classList.remove('settings-fab');
  const lockButton = header.querySelector('#desktop-lock');
  header.insertBefore(settingsToggle, lockButton);
  const footer = document.createElement('section');
  footer.className = 'desktop-footer panel-section';
  footer.innerHTML = `
    <strong id="desktop-selected-date"></strong>
    <div class="desktop-view-tabs" role="tablist" aria-label="待办与调班">
      <button id="desktop-todos-tab" type="button" role="tab" data-desktop-view="todos" aria-controls="desktop-todos" aria-selected="true">待办 <span id="desktop-pending" class="count-badge">0</span></button>
      <button id="desktop-adjustments-tab" type="button" role="tab" data-desktop-view="adjustments" aria-controls="desktop-adjustments" aria-selected="false" tabindex="-1">调班</button>
    </div>`;
  const todos = document.createElement('section');
  todos.id = 'desktop-todos';
  todos.className = 'panel-section';
  todos.setAttribute('role', 'tabpanel');
  todos.setAttribute('aria-labelledby', 'desktop-todos-tab');
  todos.tabIndex = 0;
  todos.innerHTML = `
    <ul id="desktop-todo-list" class="desktop-todo-list"></ul>
    <button type="button" id="desktop-add-todo" class="desktop-add-todo-fab" title="添加待办" aria-label="添加待办">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" /></svg>
    </button>`;
  const adjustmentPanel = document.querySelector('.adjustment-panel');
  const holidayPanel = document.querySelector('.result-panel');
  const adjustmentHeading = adjustmentPanel.querySelector('.section-heading');
  const adjustmentCount = adjustmentHeading.querySelector('#adjustment-record-count');
  footer.querySelector('#desktop-adjustments-tab').append(' ', adjustmentCount);
  adjustmentHeading.remove();
  adjustmentPanel.id = 'desktop-adjustments';
  adjustmentPanel.setAttribute('role', 'tabpanel');
  adjustmentPanel.setAttribute('aria-labelledby', 'desktop-adjustments-tab');
  adjustmentPanel.tabIndex = 0;
  adjustmentPanel.hidden = true;
  const infoSource = document.createElement('section');
  infoSource.hidden = true;
  infoSource.append(footer, todos, adjustmentPanel);
  calendar.append(infoSource);
  holidayPanel.hidden = true;
  const todoDialog = document.createElement('dialog');
  todoDialog.className = 'desktop-todo-dialog';
  todoDialog.setAttribute('aria-labelledby', 'desktop-todo-heading');
  todoDialog.innerHTML = `
    <form id="desktop-todo-form">
      <div class="dialog-heading">
        <h2 id="desktop-todo-heading">待办</h2>
        <button class="icon-button" type="button" data-desktop-todo-close title="关闭" aria-label="关闭">×</button>
      </div>
      <label class="desktop-todo-field" for="desktop-todo-date"><span class="field-label">日期</span><input id="desktop-todo-date" type="date" required /></label>
      <label class="desktop-todo-field" for="desktop-todo-text"><span class="field-label">内容</span><textarea id="desktop-todo-text" maxlength="500" required rows="4" placeholder="输入待办内容"></textarea></label>
      <div class="dialog-actions">
        <button class="secondary-button" type="button" id="desktop-cancel-todo" data-desktop-todo-close>取消</button>
        <button class="primary-button" type="submit">保存</button>
      </div>
    </form>`;
  calendar.append(todoDialog);
  const system = document.createElement('section');
  system.id = 'desktop-settings';
  system.className = 'settings-group';
  system.setAttribute('role', 'tabpanel');
  system.setAttribute('aria-labelledby', 'desktop-settings-tab');
  system.tabIndex = 0;
  system.hidden = true;
  system.innerHTML = `
    <h3>桌面挂件</h3>
    <label>字号（px）<input id="desktop-font" type="number" min="12" max="15" step="1" /></label>
    <label>亮度（%）<input id="desktop-brightness" type="number" min="70" max="130" step="1" /></label>
    <label>背景透明度（%）<input id="desktop-transparency" type="range" min="0" max="100" step="5" /></label>
    <label><input id="desktop-autostart" type="checkbox" />开机启动</label>
    <h3>桌面完整备份</h3>
    <p>完整导入会替换设置、假期、调班和待办；不会改变锁定、位置和开机启动。普通假期导入只更新假期。</p>
    <details><summary>完整备份格式</summary>
      <p>新格式 version: 12，包含 settings、todos、adjustments、holidayCache、holidayOverrides。
      支持显式导入旧桌面 version: 11 JSON；请使用完整导出文件作为模板。</p>
      <pre id="desktop-backup-example"></pre></details>
    <div class="button-row"><button type="button" id="desktop-export">导出完整备份</button>
      <button type="button" id="desktop-import">导入完整备份</button></div>
    <input id="desktop-backup-file" type="file" accept="application/json,.json" hidden />`;
  settings.append(system);
  const systemTab = document.createElement('button');
  systemTab.id = 'desktop-settings-tab';
  systemTab.type = 'button';
  systemTab.setAttribute('role', 'tab');
  systemTab.setAttribute('aria-controls', system.id);
  systemTab.setAttribute('aria-selected', 'false');
  systemTab.tabIndex = -1;
  systemTab.textContent = '桌面挂件';
  document.querySelector('.settings-tabs').append(systemTab);
  const context = document.createElement('div');
  context.className = 'desktop-context';
  context.hidden = true;
  context.setAttribute('role', 'menu');
  context.innerHTML = `
    <button type="button" data-context="todo" role="menuitem">添加待办</button>
    <button type="button" data-context="adjustment" role="menuitem">调班</button>
    <button type="button" data-context="correction" role="menuitem">日期修正</button>`;
  document.body.append(context);
  const query = (selector) => document.querySelector(selector);
  const example = platform.exportBackup(application.getState());
  example.todos = [];
  example.adjustments = [];
  example.holidayCache = { 2027: { '2027-01-01': { kind: 'legal', name: '元旦' } } };
  example.holidayOverrides = {};
  query('#desktop-backup-example').textContent = JSON.stringify(example, null, 2);
  let editingId = '';
  let todoSession = 0;
  let contextDate = '';
  let preferences = { locked: false, autoLaunch: false };
  let sizeTimer;
  let sidebarVisibility = [false, false];

  /**
   * 事件失败保持编辑窗口和已提交状态，原生调用不产生未处理拒绝。
   */
  function bind(target, type, action) {
    target.addEventListener(type, (event) => {
      if (type === 'submit') event.preventDefault();

      const operation = Promise.resolve().then(() => action(event)).catch((error) => {
        application.notify(String(error.message || error), true);
      });

      event.calendarActions?.push(operation);
    });
  }

  /**
   * 只调整桌面 CSS 变量，不改变公共配色或日历分类。
   */
  function applyAppearance() {
    const appearance = platform.getDesktop().appearance;
    const root = document.documentElement;
    root.style.setProperty('--desktop-opacity', String(1 - appearance.backgroundTransparency / 100));
    root.style.setProperty('--desktop-brightness', String(appearance.brightness / 100));
    root.style.setProperty('--desktop-font-offset', appearance.fontSizeOffset + 'px');
    query('#desktop-font').value = String(12 + appearance.fontSizeOffset);
    query('#desktop-brightness').value = String(appearance.brightness);
    query('#desktop-transparency').value = String(appearance.backgroundTransparency);
  }

  /**
   * 选中日期的待办只在桌面端展示，文本不通过 HTML 拼接。
   */
  function renderTodos(dateKey) {
    const todos = platform.getDesktop().todos.filter((todo) => todo.date === dateKey);
    todos.sort((left, right) => Number(left.done) - Number(right.done) || left.createdAt - right.createdAt);
    const list = query('#desktop-todo-list');
    list.replaceChildren();
    query('#desktop-selected-date').textContent = dateKey;
    query('#desktop-pending').textContent = String(todos.filter((todo) => !todo.done).length);

    for (const todo of todos) {
      const row = document.createElement('li');
      row.dataset.id = todo.id;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = todo.done;
      checkbox.dataset.todoToggle = todo.id;
      checkbox.setAttribute('aria-label', '完成 ' + todo.text);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.dataset.todoEdit = todo.id;
      edit.textContent = todo.text;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.todoDelete = todo.id;
      remove.textContent = '删除';
      row.append(checkbox, edit, remove);
      list.append(row);
    }

    if (!todos.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = '当天暂无待办';
      list.append(empty);
    }

    applyAppearance();
  }

  /**
   * 新建与编辑复用同一表单；日期可独立于当前浏览月份。
   */
  function openTodo(dateKey, todo = null) {
    todoSession += 1;
    editingId = todo?.id ?? '';
    query('#desktop-todo-heading').textContent = todo ? '编辑待办' : '添加待办';
    query('#desktop-todo-date').value = todo?.date ?? dateKey;
    query('#desktop-todo-text').value = todo?.text ?? '';
    todoDialog.showModal();
  }

  platform.updateSelection = renderTodos;
  platform.decorateDay = (button, dateKey) => {
    const todos = platform.getDesktop().todos.filter((todo) => todo.date === dateKey);

    if (!todos.length) return;

    const pending = todos.filter((todo) => !todo.done).length;
    const indicator = document.createElement('small');
    indicator.className = 'desktop-todo-indicator';
    indicator.textContent = String(pending);
    const text = `有待办，${pending} 项未完成`;
    indicator.title = text;
    button.append(indicator);
    const label = button.getAttribute('aria-label') + ' ' + text;
    button.setAttribute('aria-label', label);
  };

  const sidebarToggles = [query('#desktop-info-toggle'), query('#desktop-holidays-toggle')];
  const sidebarNames = ['待办与调班', '节日与假期'];

  /**
   * 每个顶部按钮只控制对应附着窗口；原生关闭单窗同步各自状态。
   */
  function setSidebarExpanded(visible) {
    sidebarVisibility = [...visible];
    sidebarToggles.forEach((toggle, index) => {
      const expanded = visible[index];
      const expandedValue = String(expanded);
      toggle.setAttribute('aria-expanded', expandedValue);
      const prefix = expanded ? '收起' : '展开';
      const label = prefix + sidebarNames[index];
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
    });
  }

  for (const [panel, toggle] of sidebarToggles.entries()) {
    bind(toggle, 'click', async () => {
      toggle.disabled = true;

      try {
        const argumentsValue = { panel, visible: !sidebarVisibility[panel] };
        const visible = await platform.invoke('set_attachment_visible', argumentsValue);
        setSidebarExpanded(visible);
      } finally {
        toggle.disabled = false;
      }
    });
  }

  setSidebarExpanded(sidebarVisibility);

  bind(footer, 'click', (event) => {
    const view = event.target.closest('[data-desktop-view]')?.dataset.desktopView;

    if (!view) return;

    for (const tab of footer.querySelectorAll('[role="tab"]')) {
      const selected = tab.dataset.desktopView === view;
      const selectedValue = String(selected);
      tab.setAttribute('aria-selected', selectedValue);
      tab.tabIndex = selected ? 0 : -1;
    }

    query('#desktop-todos').hidden = view !== 'todos';
    adjustmentPanel.hidden = view !== 'adjustments';
  });

  bind(query('#desktop-add-todo'), 'click', () => openTodo(application.getSelectedDate()));

  bind(todoDialog, 'click', (event) => {
    if (event.target.closest('[data-desktop-todo-close]')) todoDialog.close();
  });

  bind(query('#desktop-todo-form'), 'submit', async () => {
    const session = todoSession;
    const date = query('#desktop-todo-date').value;
    const text = query('#desktop-todo-text').value.trim();

    if (!text) throw new Error('请填写待办内容');

    const id = editingId || crypto.randomUUID();
    await application.commit(() => {
      const extension = platform.getDesktop();
      const existing = extension.todos.find((todo) => todo.id === id);
      const todo = { id, date, text, done: existing?.done ?? false, createdAt: existing?.createdAt ?? Date.now() };
      const todos = extension.todos.filter((item) => item.id !== id);
      todos.push(todo);
      const next = { ...extension, todos };
      platform.setDesktop(next);
    });

    if (todoSession === session) todoDialog.close();
    application.notify('待办已保存');
  });

  bind(query('#desktop-todo-list'), 'click', async (event) => {
    const edit = event.target.closest('[data-todo-edit]');
    const remove = event.target.closest('[data-todo-delete]');

    if (edit) {
      const todo = platform.getDesktop().todos.find((item) => item.id === edit.dataset.todoEdit);
      openTodo(todo.date, todo);
    } else if (remove && window.confirm('删除这条待办吗？')) {
      await application.commit(() => {
        const extension = platform.getDesktop();
        const todos = extension.todos.filter((todo) => todo.id !== remove.dataset.todoDelete);
        const next = { ...extension, todos };
        platform.setDesktop(next);
      });
    }
  });

  bind(query('#desktop-todo-list'), 'change', async (event) => {
    const id = event.target.dataset.todoToggle;

    if (!id) return;

    const done = event.target.checked;

    try {
      await application.commit(() => {
        const extension = platform.getDesktop();
        const todos = extension.todos.map((todo) => {
          if (todo.id === id) return { ...todo, done };

          return todo;
        });

        const next = { ...extension, todos };
        platform.setDesktop(next);
      });
    } catch (error) {
      renderTodos(application.getSelectedDate());
      throw error;
    }
  });

  const appearanceFields = [
    ['#desktop-font', 'fontSizeOffset', 12],
    ['#desktop-brightness', 'brightness', 0],
    ['#desktop-transparency', 'backgroundTransparency', 0]
  ];

  for (const [selector, field, offset] of appearanceFields) {
    bind(query(selector), 'change', async (event) => {
      const value = Number(event.target.value) - offset;

      try {
        await application.commit(() => {
          const extension = platform.getDesktop();
          const appearance = { ...extension.appearance, [field]: value };
          const next = { ...extension, appearance };
          platform.setDesktop(next);
        });
      } finally {
        applyAppearance();
      }
    });
  }

  bind(query('#desktop-export'), 'click', () => {
    const backup = platform.exportBackup(application.getState());
    const content = JSON.stringify(backup, null, 2);
    const parts = [content];
    const options = { type: 'application/json' };
    const url = URL.createObjectURL(new Blob(parts, options));
    const link = document.createElement('a');
    link.href = url;
    link.download = '桌面日历完整备份.json';
    link.click();
    URL.revokeObjectURL(url);
  });

  bind(query('#desktop-import'), 'click', () => query('#desktop-backup-file').click());
  bind(query('#desktop-backup-file'), 'change', async (event) => {
    const [file] = event.target.files;

    if (!file) return;

    try {
      const content = JSON.parse(await file.text());
      const decoded = platform.importBackup(content);

      if (!window.confirm('完整导入会替换设置、假期、调班和待办，继续吗？')) return;

      const updateExtension = () => platform.setDesktop(decoded.desktop);
      await application.replaceState(decoded.calendar, updateExtension);
      application.notify('桌面完整备份已导入');
    } finally {
      event.target.value = '';
    }
  });

  const grid = query('#calendar-grid');
  grid.addEventListener('contextmenu', (event) => {
    const day = event.target.closest('.day-cell');

    if (!day) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    contextDate = day.dataset.date;
    application.selectDate(contextDate);
    context.hidden = false;
    const bounds = context.getBoundingClientRect();
    context.style.left = Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8)) + 'px';
    context.style.top = Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8)) + 'px';
  }, true);

  bind(context, 'click', (event) => {
    const action = event.target.closest('[data-context]')?.dataset.context;
    context.hidden = true;

    if (action === 'todo') {
      openTodo(contextDate);
    } else if (action === 'adjustment') {
      application.openAdjustment(contextDate);
    } else if (action === 'correction') {
      application.openCorrection(contextDate);
    }
  });

  document.addEventListener('click', () => { context.hidden = true; });
  window.addEventListener('blur', () => { context.hidden = true; });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') context.hidden = true;
  });

  const dragRegion = query('.desktop-drag');

  function applyPreferences() {
    query('#desktop-lock').textContent = preferences.locked ? '◆' : '◇';
    query('#desktop-lock').setAttribute('aria-pressed', String(preferences.locked));
    query('#desktop-autostart').checked = preferences.autoLaunch;
    document.documentElement.classList.toggle('desktop-locked', preferences.locked);

    if (preferences.locked) {
      dragRegion.removeAttribute('data-tauri-drag-region');
    } else {
      dragRegion.setAttribute('data-tauri-drag-region', '');
    }
  }

  bind(query('#desktop-close'), 'click', () => platform.invoke('exit_app'));
  bind(query('#desktop-lock'), 'click', async () => {
    const argumentsValue = { locked: !preferences.locked };
    preferences.locked = await platform.invoke('set_locked', argumentsValue);
    applyPreferences();
  });

  bind(query('#desktop-autostart'), 'change', async (event) => {
    const argumentsValue = { enabled: event.target.checked };

    try {
      preferences.autoLaunch = await platform.invoke('set_auto_launch', argumentsValue);
    } finally {
      applyPreferences();
    }
  });

  for (const [corner, direction] of Object.entries({ nw: 'NorthWest', ne: 'NorthEast', sw: 'SouthWest', se: 'SouthEast' })) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'desktop-resize ' + corner;
    handle.setAttribute('aria-label', '调整窗口大小');
    bind(handle, 'pointerdown', (event) => {
      if (preferences.locked || event.button !== 0) return;

      return platform.window.startResizeDragging(direction);
    });

    document.body.append(handle);
  }

  try {
    preferences = await platform.invoke('get_preferences');

    if (preferences.databaseRecoveryNotice) application.notify(preferences.databaseRecoveryNotice);

    await platform.window.onResized(() => {
      clearTimeout(sizeTimer);
      sizeTimer = setTimeout(() => {
        platform.invoke('save_window_size').catch((error) => application.notify(String(error), true));
      }, 250);
    });
  } catch (error) {
    application.notify(String(error), true);
  }

  applyPreferences();
  applyAppearance();
  await platform.listen('attachment-visibility', ({ payload }) => setSidebarExpanded(payload));
  const sources = [infoSource, holidayPanel];
  const notify = (error) => application.notify(String(error.message || error), true);
  const attachmentContext = { platform, sources, notify };
  await connectAttachments(attachmentContext);
}
