import { addDays, isDateKey, parseDate } from './core.js';
import { formatLunarDate, getFestivalNames } from './festivals.js';

/**
 * 日期面板只浏览节日所在月，用户点选前不修改临时配置。
 */
export function connectStartDatePicker(root) {
  const document = root.ownerDocument;
  let panel;

  const open = (input) => {
    const initialDate = input.value || input.dataset.defaultDate;

    if (!isDateKey(initialDate)) return;

    panel?.remove();
    panel = document.createElement('div');
    panel.className = 'recommendation-date-picker';
    panel.setAttribute('popover', 'auto');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '选择开始休息日期');
    let month = initialDate.slice(0, 7) + '-01';

    const choose = (value) => {
      input.value = value;
      panel.hidePopover();
      input.focus();
      const event = new Event('input', { bubbles: true });
      input.dispatchEvent(event);
    };

    const button = (label, action) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      element.addEventListener('click', action);
      return element;
    };

    const position = () => {
      const bounds = input.getBoundingClientRect();
      const viewport = document.documentElement;
      const left = Math.max(8, Math.min(bounds.left, viewport.clientWidth - panel.offsetWidth - 8));
      const top = Math.max(8, Math.min(bounds.bottom, viewport.clientHeight - panel.offsetHeight - 8));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };

    const render = () => {
      panel.replaceChildren();
      const navigation = document.createElement('div');
      navigation.className = 'recommendation-date-navigation';
      const previous = button('‹', () => {
        const previousDate = addDays(month, -1);
        month = previousDate.slice(0, 7) + '-01';
        render();
      });

      previous.setAttribute('aria-label', '上个月');
      const title = document.createElement('span');
      title.textContent = month.slice(0, 7);
      const next = button('›', () => {
        const nextDate = addDays(month, 32);
        month = nextDate.slice(0, 7) + '-01';
        render();
      });

      next.setAttribute('aria-label', '下个月');
      navigation.append(previous, title, next);
      const grid = document.createElement('div');
      grid.className = 'recommendation-date-grid';

      for (const label of ['日', '一', '二', '三', '四', '五', '六']) {
        const weekday = document.createElement('span');
        weekday.textContent = label;
        grid.append(weekday);
      }

      const first = parseDate(month);
      const offset = first.getUTCDay();

      for (let index = 0; index < offset; index += 1) grid.append(document.createElement('span'));

      for (let date = month; date.slice(0, 7) === month.slice(0, 7); date = addDays(date, 1)) {
        const value = date;
        const label = String(Number(date.slice(8)));
        const day = button(label, () => choose(value));
        const lunarDate = formatLunarDate(date);
        const names = getFestivalNames(date);
        const festivalNames = names.join('、');
        let description = `农历${lunarDate}`;

        if (festivalNames) description += ` ${festivalNames}`;

        day.dataset.date = date;
        day.title = description;
        const accessibleLabel = `${date} ${description}`;
        day.setAttribute('aria-label', accessibleLabel);
        const selected = String(date === input.value);
        day.setAttribute('aria-pressed', selected);
        grid.append(day);
      }

      const clear = button('清空', () => choose(''));
      panel.append(navigation, grid, clear);

      if (panel.matches(':popover-open')) position();
    };

    render();
    root.append(panel);
    panel.addEventListener('toggle', () => {
      const expanded = String(panel.matches(':popover-open'));
      input.setAttribute('aria-expanded', expanded);
    });

    panel.showPopover();
    position();
    panel.querySelector(`[data-date="${initialDate}"]`)?.focus();
  };

  root.addEventListener('click', (event) => {
    const input = event.target.closest('#recommendation-start-date');

    if (input && !input.disabled) open(input);
  });

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel?.matches(':popover-open')) {
      event.preventDefault();
      event.stopPropagation();
      panel.hidePopover();
      return;
    }

    const input = event.target.closest('#recommendation-start-date');

    if (!input || !['Enter', ' ', 'ArrowDown'].includes(event.key)) return;

    event.preventDefault();
    open(input);
  });
}
