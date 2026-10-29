use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{
    App, AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent,
};

const LABEL: &str = "vacation-recommendations";

#[derive(Default)]
struct RecommendationState {
    session: AtomicU64,
}

/**
 * 启动时预建隐藏窗口，避免 Windows 同步命令创建 WebView 的死锁风险。
 */
pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(RecommendationState::default());
    let main = app.get_webview_window("main").ok_or("无法获取主窗口")?;
    let url = WebviewUrl::App("index.html".into());

    WebviewWindowBuilder::new(app, LABEL, url)
        .title("休假推荐")
        .initialization_script("window.__CALENDAR_RECOMMENDATION__ = true;")
        .inner_size(1000.0, 700.0)
        .min_inner_size(680.0, 420.0)
        .decorations(true)
        .resizable(true)
        .visible(false)
        .parent(&main)?
        .center()
        .build()?;

    Ok(())
}

fn hide<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or("无法获取休假推荐窗口")?;
    window.hide().map_err(|error| error.to_string())?;
    let session = app.state::<RecommendationState>().session.load(Ordering::SeqCst);
    app.emit_to("main", "recommendation-closed", session).map_err(|error| error.to_string())
}

/**
 * 推荐窗关闭只隐藏自身，不进入主窗口的退出及尺寸保存流程。
 */
pub fn handle_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) -> bool {
    if window.label() != LABEL { return false; }

    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = hide(window.app_handle());
    }

    true
}

#[tauri::command]
pub fn show_vacation_recommendations(app: AppHandle, session: u64) -> Result<(), String> {
    if session == 0 { return Err("无效推荐会话".into()); }

    let window = app.get_webview_window(LABEL).ok_or("无法获取休假推荐窗口")?;
    app.state::<RecommendationState>().session.store(session, Ordering::SeqCst);
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn hide_vacation_recommendations(app: AppHandle) -> Result<(), String> {
    hide(&app)
}
