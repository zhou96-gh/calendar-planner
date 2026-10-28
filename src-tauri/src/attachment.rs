use std::sync::Mutex;
use tauri::{
    App, AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};

const LABELS: [&str; 2] = ["sidebar-info", "sidebar-holidays"];
const ATTACHMENT_GAP: f64 = 2.0;

#[derive(Clone, Copy)]
struct AttachmentMetrics {
    widths: [u32; 2],
    gap: u32,
}

#[derive(Clone, Copy, Default)]
struct PanelState {
    visible: bool,
    left: bool,
    chosen: bool,
}

#[derive(Clone, Copy)]
struct DragOrigin {
    panel: usize,
    cursor: (f64, f64),
    position: PhysicalPosition<i32>,
}

pub struct Attachments {
    panels: [PanelState; 2],
    drag: Option<DragOrigin>,
    locked: bool,
}

impl Default for Attachments {
    fn default() -> Self {
        Self {
            panels: [PanelState { left: true, ..PanelState::default() }, PanelState::default()],
            drag: None,
            locked: false,
        }
    }
}

/**
 * 按屏幕列顺序排列同侧窗口，统一使用物理坐标，支持负坐标显示器。
 */
fn positions(main: PhysicalPosition<i32>, size: PhysicalSize<u32>, metrics: AttachmentMetrics, panels: [PanelState; 2]) -> [PhysicalPosition<i32>; 2] {
    let AttachmentMetrics { widths, gap } = metrics;
    let gap = gap as i64;
    let left_width: i64 = panels.iter().enumerate()
        .filter(|(_, panel)| panel.visible && panel.left)
        .map(|(index, _)| widths[index] as i64 + gap)
        .sum();
    let mut left = main.x as i64 - left_width;
    let mut right = main.x as i64 + size.width as i64 + gap;
    let mut result = [main; 2];

    for (index, panel) in panels.iter().enumerate() {
        if !panel.visible { continue; }

        let x = if panel.left { &mut left } else { &mut right };
        result[index].x = (*x).clamp(i32::MIN as i64, i32::MAX as i64) as i32;
        *x += widths[index] as i64 + gap;
    }

    result
}

/**
 * 只在主窗口事件或拖动结束时布局，不监听附着窗口的程序移动，避免递归。
 */
pub fn sync<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let (panels, drag) = {
        let state = app.state::<Mutex<Attachments>>();
        let state = state.lock().map_err(|error| error.to_string())?;
        (state.panels, state.drag)
    };

    layout(app, panels, drag)
}

fn layout<R: Runtime>(app: &AppHandle<R>, panels: [PanelState; 2], drag: Option<DragOrigin>) -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("无法获取主窗口")?;
    let size = main.outer_size().map_err(|error| error.to_string())?;
    let position = main.outer_position().map_err(|error| error.to_string())?;
    let scale = main.scale_factor().map_err(|error| error.to_string())?;
    let width = (300.0 * scale).round() as u32;
    let mut widths = [width; 2];

    for (index, label) in LABELS.iter().enumerate() {
        if !panels[index].visible || drag.is_some_and(|drag| drag.panel == index) { continue; }

        if let Some(window) = app.get_webview_window(label) {
            let outer = window.outer_size().map_err(|error| error.to_string())?;
            let inner = window.inner_size().map_err(|error| error.to_string())?;
            let frame_height = outer.height.saturating_sub(inner.height);
            let height = size.height.saturating_sub(frame_height).max(1);
            let target_size = PhysicalSize::new(width, height);

            if inner != target_size {
                window.set_size(target_size).map_err(|error| error.to_string())?;
            }

            widths[index] = window.outer_size().map_err(|error| error.to_string())?.width;
        }
    }

    let metrics = AttachmentMetrics { widths, gap: (ATTACHMENT_GAP * scale).round() as u32 };
    let targets = positions(position, size, metrics, panels);

    for (index, label) in LABELS.iter().enumerate() {
        if !panels[index].visible || drag.is_some_and(|drag| drag.panel == index) { continue; }

        if let Some(window) = app.get_webview_window(label) {
            if window.outer_position().map_err(|error| error.to_string())? != targets[index] {
                window.set_position(targets[index]).map_err(|error| error.to_string())?;
            }
        }
    }

    Ok(())
}

/**
 * 新展开的窗口优先采用默认左右位置，空间不足时回退，不移动另一个窗口。
 */
fn initial_side(index: usize, main: (i32, u32), area: (i32, u32), extent: u32, panels: &mut [PanelState; 2]) {
    if panels[index].chosen || !panels[index].visible { return; }

    let (main_x, main_width) = main;
    let (area_x, area_width) = area;
    let mut left = (main_x as i64 - area_x as i64).max(0);
    let mut right = (area_x as i64 + area_width as i64 - main_x as i64 - main_width as i64).max(0);
    let extent = extent as i64;

    for (other, panel) in panels.iter().enumerate() {
        if other == index || !panel.visible { continue; }

        if panel.left { left -= extent; } else { right -= extent; }
    }

    let prefer_left = index == 0;
    let (preferred, alternative) = if prefer_left { (left, right) } else { (right, left) };

    if preferred < extent && alternative > preferred {
        panels[index].left = !prefer_left;
    } else {
        panels[index].left = prefer_left;
    }
}

fn apply_visibility<R: Runtime>(app: &AppHandle<R>, panels: [PanelState; 2]) -> Result<(), String> {
    for (index, label) in LABELS.iter().enumerate() {
        let window = app.get_webview_window(label).ok_or("无法获取附着窗口")?;

        if window.is_visible().map_err(|error| error.to_string())? == panels[index].visible { continue; }

        if panels[index].visible { window.show() } else { window.hide() }.map_err(|error| error.to_string())?;
    }

    Ok(())
}

/**
 * 窗口操作成功后才提交可见状态；失败时回滚并以实际窗口状态同步开关。
 */
fn update_visibility<R: Runtime>(app: &AppHandle<R>, mut panels: [PanelState; 2]) -> Result<[bool; 2], String> {
    let previous = app.state::<Mutex<Attachments>>().lock().map_err(|error| error.to_string())?.panels;
    let result = layout(app, panels, None).and_then(|_| apply_visibility(app, panels));

    if result.is_err() {
        let _ = apply_visibility(app, previous);
        panels = previous;
    }

    for (index, label) in LABELS.iter().enumerate() {
        if let Some(window) = app.get_webview_window(label) {
            panels[index].visible = window.is_visible().unwrap_or(previous[index].visible);
        }
    }

    {
        let state = app.state::<Mutex<Attachments>>();
        let mut state = state.lock().map_err(|error| error.to_string())?;
        state.panels = panels;
        state.drag = None;
    }

    let _ = sync(app);
    let visible = notify_visibility(app)?;
    result.map(|_| visible)
}

fn notify_visibility<R: Runtime>(app: &AppHandle<R>) -> Result<[bool; 2], String> {
    let visible = app.state::<Mutex<Attachments>>().lock().map_err(|error| error.to_string())?
        .panels.map(|panel| panel.visible);
    app.emit_to("main", "attachment-visibility", visible).map_err(|error| error.to_string())?;
    Ok(visible)
}

/**
 * setup 预建隐藏的 owned 窗口，避免在 Windows 同步命令内创建 WebView 死锁。
 */
pub fn setup(app: &mut App, locked: bool) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(Mutex::new(Attachments { locked, ..Attachments::default() }));
    let main = app.get_webview_window("main").ok_or("无法获取主窗口")?;

    for (index, label) in LABELS.iter().enumerate() {
        let script = format!("window.__CALENDAR_ATTACHMENT__ = {index};");
        let url = WebviewUrl::App("index.html".into());

        WebviewWindowBuilder::new(app, *label, url)
            .title(if index == 0 { "日期与待办" } else { "节日与假期" })
            .initialization_script(script)
            .inner_size(300.0, 800.0)
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .skip_taskbar(true)
            .visible(false)
            .parent(&main)?
            .build()?;
    }

    Ok(())
}

pub fn set_locked<R: Runtime>(app: &AppHandle<R>, locked: bool) {
    if let Ok(mut state) = app.state::<Mutex<Attachments>>().lock() {
        state.locked = locked;
        state.drag = None;
    }

    let _ = sync(app);
}

/**
 * 主窗口关闭仍退出；关闭附着窗口只收起自身，并重新排列另一个窗口。
 */
pub fn handle_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) -> bool {
    let app = window.app_handle();

    if let Some(index) = LABELS.iter().position(|label| *label == window.label()) {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let panels = app.state::<Mutex<Attachments>>().lock().ok().map(|state| state.panels);

            if let Some(mut panels) = panels {
                panels[index].visible = false;
                let _ = update_visibility(app, panels);
            }
        }

        return true;
    }

    if window.label() == "main" && matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. })
        && app.try_state::<Mutex<Attachments>>().is_some() {
        let _ = sync(app);
    }

    false
}

#[tauri::command]
pub fn set_attachment_visible(app: AppHandle, panel: usize, visible: bool) -> Result<[bool; 2], String> {
    let mut panels = app.state::<Mutex<Attachments>>().lock().map_err(|error| error.to_string())?.panels;

    panels.get_mut(panel).ok_or("无效附着窗口")?.visible = visible;

    if visible {
        let main = app.get_webview_window("main").ok_or("无法获取主窗口")?;

        if let Some(monitor) = main.current_monitor().map_err(|error| error.to_string())? {
            let position = main.outer_position().map_err(|error| error.to_string())?;
            let size = main.outer_size().map_err(|error| error.to_string())?;
            let scale = main.scale_factor().map_err(|error| error.to_string())?;
            let extent = ((300.0 + ATTACHMENT_GAP) * scale).round() as u32;
            let area = monitor.work_area();
            let main_bounds = (position.x, size.width);
            let area_bounds = (area.position.x, area.size.width);
            initial_side(panel, main_bounds, area_bounds, extent, &mut panels);
        }
    }

    update_visibility(&app, panels)
}

#[tauri::command]
pub fn hide_attachment(window: WebviewWindow) -> Result<[bool; 2], String> {
    let index = LABELS.iter().position(|label| *label == window.label()).ok_or("无效附着窗口")?;
    let mut panels = window.state::<Mutex<Attachments>>().lock().map_err(|error| error.to_string())?.panels;
    panels[index].visible = false;
    update_visibility(window.app_handle(), panels)
}

#[tauri::command]
pub fn begin_attachment_drag(window: WebviewWindow) -> Result<(), String> {
    let panel = LABELS.iter().position(|label| *label == window.label()).ok_or("无效附着窗口")?;
    let cursor = window.app_handle().cursor_position().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let state = window.state::<Mutex<Attachments>>();
    let mut state = state.lock().map_err(|error| error.to_string())?;

    if state.locked { return Err("窗口已固定".into()); }

    state.drag = Some(DragOrigin { panel, cursor: (cursor.x, cursor.y), position });
    Ok(())
}

#[tauri::command]
pub fn move_attachment_drag(window: WebviewWindow) -> Result<(), String> {
    let drag = window.state::<Mutex<Attachments>>().lock().map_err(|error| error.to_string())?.drag;
    let Some(drag) = drag else { return Ok(()); };

    if LABELS[drag.panel] != window.label() { return Err("无效拖动会话".into()); }

    let cursor = window.app_handle().cursor_position().map_err(|error| error.to_string())?;
    let x = drag.position.x as f64 + cursor.x - drag.cursor.0;
    let y = drag.position.y as f64 + cursor.y - drag.cursor.1;
    window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32)).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn finish_attachment_drag(window: WebviewWindow, left: Option<bool>) -> Result<(), String> {
    let movement = if left.is_none() { move_attachment_drag(window.clone()) } else { Ok(()) };
    window.state::<Mutex<Attachments>>().lock().map_err(|error| error.to_string())?.drag = None;

    if let Err(error) = movement {
        let _ = sync(window.app_handle());
        return Err(error);
    }

    let index = LABELS.iter().position(|label| *label == window.label()).ok_or("无效附着窗口")?;
    let main = window.app_handle().get_webview_window("main").ok_or("无法获取主窗口")?;
    let main_center = main.outer_position().map_err(|error| error.to_string())?.x as i64
        + main.outer_size().map_err(|error| error.to_string())?.width as i64 / 2;
    let center = window.outer_position().map_err(|error| error.to_string())?.x as i64
        + window.outer_size().map_err(|error| error.to_string())?.width as i64 / 2;
    {
        let state = window.state::<Mutex<Attachments>>();
        let mut state = state.lock().map_err(|error| error.to_string())?;
        state.drag = None;

        if !state.locked {
            state.panels[index].left = left.unwrap_or(center < main_center);
            state.panels[index].chosen = true;
        }
    }

    sync(window.app_handle())
}

#[tauri::command]
pub fn focus_calendar(app: AppHandle) -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("无法获取主窗口")?;
    main.show().map_err(|error| error.to_string())?;
    main.set_focus().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachments_keep_equal_gaps_on_both_sides_and_between_columns() {
        let main = PhysicalPosition::new(100, 50);
        let size = PhysicalSize::new(680, 800);
        let visible = PanelState { visible: true, ..PanelState::default() };
        let metrics = AttachmentMetrics { widths: [300; 2], gap: 2 };
        let mut panels = [visible; 2];
        let right = positions(main, size, metrics, panels);
        assert_eq!(right, [PhysicalPosition::new(782, 50), PhysicalPosition::new(1084, 50)]);
        panels[0].left = true;
        let split = positions(main, size, metrics, panels);
        assert_eq!(split, [PhysicalPosition::new(-202, 50), PhysicalPosition::new(782, 50)]);
        panels[1].left = true;
        let both_left = positions(main, size, metrics, panels);
        assert_eq!(both_left, [PhysicalPosition::new(-504, 50), PhysicalPosition::new(-202, 50)]);
    }

    #[test]
    fn hidden_panels_leave_no_gap_and_physical_sizes_support_scaled_monitors() {
        let main = PhysicalPosition::new(-1600, -100);
        let size = PhysicalSize::new(1020, 1200);
        let metrics = AttachmentMetrics { widths: [450; 2], gap: 3 };
        let mut panels = Attachments::default().panels;
        panels[1].visible = true;
        let right_only = positions(main, size, metrics, panels);
        assert_eq!(right_only[1], PhysicalPosition::new(-577, -100));
        panels[1].visible = false;
        panels[0].visible = true;
        let left_only = positions(main, size, metrics, panels);
        assert_eq!(left_only[0], PhysicalPosition::new(-2053, -100));
    }

    #[test]
    fn defaults_keep_todos_left_and_holidays_right_with_independent_visibility() {
        let mut panels = Attachments::default().panels;
        assert!(panels.iter().all(|panel| !panel.visible));
        assert!(panels[0].left && !panels[1].left);
        let main = (400, 680);
        let area = (0, 1920);
        panels[0].visible = true;
        initial_side(0, main, area, 302, &mut panels);
        assert!(panels[0].left && !panels[1].visible);
        panels[1].visible = true;
        initial_side(1, main, area, 302, &mut panels);
        assert!(panels[0].visible && panels[0].left && !panels[1].left);
    }

    #[test]
    fn opening_one_panel_only_falls_back_for_that_panel_and_preserves_user_choice() {
        let mut panels = Attachments::default().panels;
        panels[0].visible = true;
        let main = (0, 680);
        let area = (0, 1920);
        initial_side(0, main, area, 302, &mut panels);
        assert!(!panels[0].left && !panels[1].visible);
        panels[0].chosen = true;
        let moved = (1200, 680);
        initial_side(0, moved, area, 302, &mut panels);
        assert!(!panels[0].left);
        panels[1].visible = true;
        initial_side(1, moved, area, 302, &mut panels);
        assert!(!panels[0].left && panels[1].left);
    }
}
