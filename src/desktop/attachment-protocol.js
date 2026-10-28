const ACTIONS = [
  { kind: 'view', selector: '[data-desktop-view]', key: 'desktopView' },
  { kind: 'todo-add', selector: '#desktop-add-todo' },
  { kind: 'todo-edit', selector: '[data-todo-edit]', key: 'todoEdit' },
  { kind: 'todo-delete', selector: '[data-todo-delete]', key: 'todoDelete' },
  { kind: 'todo-toggle', selector: '[data-todo-toggle]', key: 'todoToggle' },
  { kind: 'adjustment-delete', selector: '[data-delete-adjustment-id]', key: 'deleteAdjustmentId' },
  { kind: 'adjustment-edit', selector: '[data-adjustment-id]', key: 'adjustmentId' },
  { kind: 'holiday', selector: '.holiday-row', key: 'date' }
];

/**
 * 附着窗口只发送白名单动作和记录标识，不传递任意选择器或业务状态。
 */
export function readAttachmentAction(target, type) {
  for (const definition of ACTIONS) {
    const isChange = definition.kind === 'todo-toggle';

    if ((type === 'change') !== isChange) continue;

    const element = target.closest(definition.selector);

    if (!element) continue;

    const action = { kind: definition.kind };

    if (definition.key) action.value = element.dataset[definition.key];

    if (isChange) action.checked = element.checked;

    return action;
  }

  return null;
}

/**
 * 在主窗口当前节点中重新查找记录，过期 ID 或不支持的动作直接忽略。
 */
export function findAttachmentTarget(sources, action) {
  const definition = ACTIONS.find((item) => item.kind === action?.kind);

  if (!definition || (definition.key && typeof action.value !== 'string')) return null;

  if (action.kind === 'todo-toggle' && typeof action.checked !== 'boolean') return null;

  for (const source of sources) {
    const candidates = source.querySelectorAll(definition.selector);

    for (const element of candidates) {
      if (!definition.key || element.dataset[definition.key] === action.value) return element;
    }
  }

  return null;
}

/**
 * 序列化视图时补全 checkbox 当前值；业务文本已经由主窗口安全构建。
 */
export function serializeAttachmentSource(source) {
  const clone = source.cloneNode(true);
  const original = source.querySelectorAll('input[type="checkbox"]');
  const copied = clone.querySelectorAll('input[type="checkbox"]');
  copied.forEach((input, index) => input.toggleAttribute('checked', original[index].checked));
  return clone.innerHTML;
}
