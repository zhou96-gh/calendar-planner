use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

mod attachment;
mod recommendation;

const DATABASE_FILE: &str = "calendar-planner.db";
static DATABASE_RECOVERY_NOTICE: Mutex<Option<String>> = Mutex::new(None);
const RECOVERY_TABLES: &[(&str, &[&str])] = &[
    ("settings", &[
        "id",
        "anchor_monday",
        "week_starts_on",
        "saturday_rest_period",
        "saturday_repeat_interval_weeks",
        "sunday_rest_period",
        "sunday_repeat_interval_weeks",
        "background_transparency",
        "brightness",
        "font_size_offset",
        "theme",
        "layout_density",
        "monthly_max_adjustment_days",
        "allow_cross_month_adjustment",
    ]),
    ("palette_colors", &["mode", "token", "color"]),
    ("palette_scheme_selection", &["id", "scheme_id"]),
    ("custom_palette_colors", &["mode", "token", "color"]),
    ("todos", &["id", "date", "text", "done", "created_at"]),
    ("adjustments", &["id", "type", "start_date", "start_period", "end_date", "end_period", "note", "compensation_required", "created_at"]),
    ("adjustment_counter_ranges", &["adjustment_id", "position", "type", "start_date", "start_period", "end_date", "end_period"]),
    ("holiday_cache_years", &["year"]),
    ("holiday_cache", &["year", "date", "kind", "name", "start_day", "end_day", "legal_days", "makeup_days"]),
    ("holiday_overrides", &["date", "kind", "name", "start_day", "end_day", "legal_days", "makeup_days"]),
    ("preferences", &["id", "locked", "window_x", "window_y", "window_width", "window_height", "updated_at"]),
];
const PALETTE_TOKENS: &[&str] = &[
    "page",
    "surface",
    "panel",
    "panel-muted",
    "header",
    "header-text",
    "header-muted",
    "text",
    "muted",
    "faint",
    "toc-bg",
    "border",
    "border-strong",
    "control",
    "hover",
    "warm-hover",
    "badge-bg",
    "primary",
    "primary-hover",
    "primary-text",
    "error-strong",
    "rest-bg",
    "holiday-bg",
    "manual-rest-bg",
    "manual-work-bg",
    "green",
    "red",
    "purple",
    "gold",
    "stripe",
    "tag-work-bg",
    "tag-suggestion-bg",
    "tag-holiday-bg",
    "preview-bg",
    "preview-error-bg",
    "tag-neutral-bg",
];
const ALPHA_PALETTE_TOKENS: &[&str] = &["toc-bg", "stripe", "tag-neutral-bg"];
const CREATE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    anchor_monday TEXT NOT NULL,
    week_starts_on INTEGER NOT NULL CHECK (week_starts_on BETWEEN 0 AND 6),
    saturday_rest_period TEXT NOT NULL CHECK (saturday_rest_period IN ('none', 'full', 'am', 'pm')),
    saturday_repeat_interval_weeks INTEGER NOT NULL CHECK (saturday_repeat_interval_weeks BETWEEN 0 AND 52),
    sunday_rest_period TEXT NOT NULL CHECK (sunday_rest_period IN ('none', 'full', 'am', 'pm')),
    sunday_repeat_interval_weeks INTEGER NOT NULL CHECK (sunday_repeat_interval_weeks BETWEEN 0 AND 52),
    background_transparency INTEGER NOT NULL CHECK (background_transparency BETWEEN 0 AND 100),
    brightness INTEGER NOT NULL CHECK (brightness BETWEEN 70 AND 130),
    font_size_offset INTEGER NOT NULL CHECK (font_size_offset BETWEEN 0 AND 3),
    theme TEXT NOT NULL CHECK (theme IN ('system', 'dark', 'light')),
    layout_density TEXT NOT NULL DEFAULT 'spacious' CHECK (layout_density IN ('compact', 'spacious')),
    monthly_max_adjustment_days REAL NOT NULL DEFAULT 4 CHECK (monthly_max_adjustment_days BETWEEN 0 AND 31 AND monthly_max_adjustment_days * 2 = CAST(monthly_max_adjustment_days * 2 AS INTEGER)),
    allow_cross_month_adjustment INTEGER NOT NULL DEFAULT 0 CHECK (allow_cross_month_adjustment IN (0, 1))
);
CREATE TABLE IF NOT EXISTS palette_colors (
    mode TEXT NOT NULL CHECK (mode IN ('light', 'dark')),
    token TEXT NOT NULL,
    color TEXT NOT NULL CHECK (length(color) IN (7, 9)),
    PRIMARY KEY (mode, token)
);
CREATE TABLE IF NOT EXISTS palette_scheme_selection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    scheme_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_palette_colors (
    mode TEXT NOT NULL CHECK (mode IN ('light', 'dark')),
    token TEXT NOT NULL,
    color TEXT NOT NULL CHECK (length(color) IN (7, 9)),
    PRIMARY KEY (mode, token)
);
CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    text TEXT NOT NULL,
    done INTEGER NOT NULL CHECK (done IN (0, 1)),
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_date_done ON todos (date, done);
CREATE TABLE IF NOT EXISTS adjustments (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('rest', 'work')),
    start_date TEXT NOT NULL,
    start_period TEXT NOT NULL CHECK (start_period IN ('am', 'pm')),
    end_date TEXT NOT NULL,
    end_period TEXT NOT NULL CHECK (end_period IN ('am', 'pm')),
    note TEXT NOT NULL,
    compensation_required INTEGER NOT NULL CHECK (compensation_required IN (0, 1)),
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS adjustment_counter_ranges (
    adjustment_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('rest', 'work')),
    start_date TEXT NOT NULL,
    start_period TEXT NOT NULL CHECK (start_period IN ('am', 'pm')),
    end_date TEXT NOT NULL,
    end_period TEXT NOT NULL CHECK (end_period IN ('am', 'pm')),
    PRIMARY KEY (adjustment_id, position),
    FOREIGN KEY (adjustment_id) REFERENCES adjustments(id)
);
CREATE INDEX IF NOT EXISTS idx_counter_ranges_start_date ON adjustment_counter_ranges (start_date);
CREATE INDEX IF NOT EXISTS idx_adjustments_start_date ON adjustments (start_date);
CREATE TABLE IF NOT EXISTS holiday_cache_years (
    year INTEGER PRIMARY KEY CHECK (year BETWEEN 1900 AND 2200)
);
CREATE TABLE IF NOT EXISTS holiday_cache (
    year INTEGER NOT NULL,
    date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('block', 'legal', 'off', 'work')),
    name TEXT NOT NULL,
    start_day TEXT,
    end_day TEXT,
    legal_days INTEGER,
    makeup_days INTEGER,
    PRIMARY KEY (year, date)
);
CREATE TABLE IF NOT EXISTS holiday_overrides (
    date TEXT PRIMARY KEY,
    kind TEXT CHECK (kind IN ('block', 'legal', 'off', 'work')),
    name TEXT,
    start_day TEXT,
    end_day TEXT,
    legal_days INTEGER,
    makeup_days INTEGER
);
CREATE TABLE IF NOT EXISTS preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    locked INTEGER NOT NULL CHECK (locked IN (0, 1)),
    window_x INTEGER,
    window_y INTEGER,
    window_width INTEGER CHECK (window_width IS NULL OR window_width > 0),
    window_height INTEGER CHECK (window_height IS NULL OR window_height > 0),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"#;
const UPSERT_PREFERENCES_SQL: &str = r#"
INSERT INTO preferences (id, locked, window_x, window_y, window_width, window_height)
VALUES (1, ?1, ?2, ?3, ?4, ?5)
ON CONFLICT(id) DO UPDATE SET
    locked = excluded.locked,
    window_x = COALESCE(excluded.window_x, preferences.window_x),
    window_y = COALESCE(excluded.window_y, preferences.window_y),
    window_width = COALESCE(excluded.window_width, preferences.window_width),
    window_height = COALESCE(excluded.window_height, preferences.window_height),
    updated_at = CURRENT_TIMESTAMP
"#;
#[derive(Debug, Default)]
struct StoredPreferences {
    locked: bool,
    position: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowPreferences {
    locked: bool,
    auto_launch: bool,
    database_recovery_notice: Option<String>,
}

fn portable_file_path(file_name: &str) -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    executable
        .parent()
        .map(|directory| directory.join(file_name))
        .ok_or_else(|| "无法确定程序所在目录".to_string())
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut statement = connection.prepare(&sql).map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(columns)
}

fn check_database_integrity(connection: &Connection) -> Result<(), String> {
    let check = || {
        connection
            .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())
    };
    let mut result = check()?;
    if result != "ok" {
        connection.execute_batch("REINDEX;").map_err(|error| error.to_string())?;
        result = check()?;
    }
    if result == "ok" {
        Ok(())
    } else {
        Err(format!("数据库完整性检查失败：{result}"))
    }
}

fn path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = OsString::from(path.as_os_str());
    value.push(suffix);
    PathBuf::from(value)
}

fn recovery_backup_path(path: &Path) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    path_with_suffix(path, &format!(".recovery-{timestamp}"))
}

fn move_database_to_backup(path: &Path) -> Result<PathBuf, String> {
    let backup = recovery_backup_path(path);
    fs::rename(path, &backup).map_err(|error| format!("备份异常数据库失败：{error}"))?;
    let mut moved_sidecars = Vec::new();
    for suffix in ["-wal", "-shm"] {
        let source = path_with_suffix(path, suffix);
        if source.exists() {
            let destination = path_with_suffix(&backup, suffix);
            if let Err(error) = fs::rename(&source, &destination) {
                for (moved_source, moved_destination) in moved_sidecars.into_iter().rev() {
                    let _ = fs::rename(moved_destination, moved_source);
                }
                let _ = fs::rename(&backup, path);
                return Err(format!("备份数据库附属文件失败：{error}"));
            }
            moved_sidecars.push((source, destination));
        }
    }
    Ok(backup)
}

fn recovery_table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, String> {
    let sql = format!("PRAGMA recovery.table_info({table})");
    let mut statement = connection.prepare(&sql).map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(columns)
}

fn salvage_database(connection: &Connection, backup: &Path) -> usize {
    if connection
        .execute("ATTACH DATABASE ?1 AS recovery", params![backup.to_string_lossy()])
        .is_err()
    {
        return 0;
    }

    let mut recovered = 0;
    for (table, target_columns) in RECOVERY_TABLES {
        let has_table = connection
            .query_row(
                "SELECT COUNT(*) FROM recovery.sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or_default()
            > 0;
        if !has_table {
            continue;
        }
        let Ok(source_columns) = recovery_table_columns(connection, table) else {
            continue;
        };
        let columns = target_columns
            .iter()
            .filter(|column| source_columns.iter().any(|source| source == **column))
            .map(|column| format!("\"{column}\""))
            .collect::<Vec<_>>();
        if columns.is_empty() {
            continue;
        }
        let column_list = columns.join(", ");
        let relation_filter = if *table == "adjustment_counter_ranges" {
            " WHERE adjustment_id IN (SELECT id FROM main.adjustments)"
        } else {
            ""
        };
        let sql = format!(
            "INSERT OR IGNORE INTO main.\"{table}\" ({column_list}) SELECT {column_list} FROM recovery.\"{table}\"{relation_filter}"
        );
        if let Ok(rows) = connection.execute(&sql, []) {
            recovered += rows;
        }
    }
    let _ = connection.execute_batch("DETACH DATABASE recovery;");
    recovered
}

fn initialize_database(connection: &Connection) -> Result<(), String> {
    check_database_integrity(connection)?;
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version > 0 && version < 9 {
        return Err("旧版 settings 表结构不兼容；请保留旧数据库，使用新的程序目录".to_string());
    }
    for (table, expected) in [
        ("settings", &["anchor_monday", "week_starts_on", "saturday_rest_period", "saturday_repeat_interval_weeks", "sunday_rest_period", "sunday_repeat_interval_weeks", "background_transparency", "brightness", "font_size_offset", "theme"][..]),
        ("palette_colors", &["mode", "token", "color"][..]),
        ("palette_scheme_selection", &["scheme_id"][..]),
        ("custom_palette_colors", &["mode", "token", "color"][..]),
        ("todos", &["date", "text", "done", "created_at"][..]),
        ("adjustments", &["type", "start_date", "start_period", "end_date", "end_period", "note", "compensation_required", "created_at"][..]),
        ("adjustment_counter_ranges", &["adjustment_id", "position", "type", "start_date", "start_period", "end_date", "end_period"][..]),
        ("holiday_cache", &["year", "date", "kind", "name", "start_day", "end_day", "legal_days", "makeup_days"][..]),
        ("holiday_overrides", &["date", "kind", "name", "start_day", "end_day", "legal_days", "makeup_days"][..]),
        ("preferences", &["locked", "window_x", "window_y"][..])
    ] {
        let has_table: i64 = connection
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", params![table], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if has_table == 0 { continue; }
        let columns = table_columns(connection, table)?;
        if expected.iter().any(|field| !columns.iter().any(|column| column == field)) {
            return Err(format!("旧版 {table} 表结构不兼容；请保留旧数据库，使用新的程序目录"));
        }
        if table == "settings" && !columns.iter().any(|column| column == "layout_density") {
            connection.execute_batch("ALTER TABLE settings ADD COLUMN layout_density TEXT NOT NULL DEFAULT 'spacious' CHECK (layout_density IN ('compact', 'spacious'));")
                .map_err(|error| error.to_string())?;
        }

        if table == "settings" && !columns.iter().any(|column| column == "monthly_max_adjustment_days") {
            connection.execute_batch("ALTER TABLE settings ADD COLUMN monthly_max_adjustment_days REAL NOT NULL DEFAULT 4 CHECK (monthly_max_adjustment_days BETWEEN 0 AND 31 AND monthly_max_adjustment_days * 2 = CAST(monthly_max_adjustment_days * 2 AS INTEGER));")
                .map_err(|error| error.to_string())?;
        }

        if table == "settings" && !columns.iter().any(|column| column == "allow_cross_month_adjustment") {
            connection.execute_batch("ALTER TABLE settings ADD COLUMN allow_cross_month_adjustment INTEGER NOT NULL DEFAULT 0 CHECK (allow_cross_month_adjustment IN (0, 1));")
                .map_err(|error| error.to_string())?;
        }

        if table == "preferences" {
            if !columns.iter().any(|column| column == "window_width") {
                connection.execute_batch("ALTER TABLE preferences ADD COLUMN window_width INTEGER CHECK (window_width IS NULL OR window_width > 0);")
                    .map_err(|error| error.to_string())?;
            }
            if !columns.iter().any(|column| column == "window_height") {
                connection.execute_batch("ALTER TABLE preferences ADD COLUMN window_height INTEGER CHECK (window_height IS NULL OR window_height > 0);")
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    connection.execute_batch(CREATE_SCHEMA_SQL).map_err(|error| error.to_string())?;
    connection.execute_batch("PRAGMA user_version = 10; PRAGMA foreign_keys = ON;")
        .map_err(|error| error.to_string())
}

fn open_database_at_path(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    match initialize_database(&connection) {
        Ok(()) => Ok(connection),
        Err(initial_error) => {
            drop(connection);
            let backup = move_database_to_backup(path)?;
            let fresh = Connection::open(path).map_err(|error| error.to_string())?;
            initialize_database(&fresh).map_err(|error| {
                format!("数据库重置失败：{error}；原错误：{initial_error}")
            })?;
            let recovered = salvage_database(&fresh, &backup);
            let backup_name = backup
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| backup.display().to_string());
            if let Ok(mut notice) = DATABASE_RECOVERY_NOTICE.lock() {
                *notice = Some(format!(
                    "数据库已自动重置，恢复 {recovered} 条记录；原文件：{backup_name}"
                ));
            }
            Ok(fresh)
        }
    }
}

fn open_database() -> Result<Connection, String> {
    open_database_at_path(&portable_file_path(DATABASE_FILE)?)
}

fn load_preferences_from_connection(connection: &Connection) -> Result<StoredPreferences, String> {
    connection
        .query_row("SELECT locked, window_x, window_y, window_width, window_height FROM preferences WHERE id = 1", [], |row| {
            let locked = row.get::<_, i64>(0)? != 0;
            let x = row.get::<_, Option<i32>>(1)?;
            let y = row.get::<_, Option<i32>>(2)?;
            let width = row.get::<_, Option<i32>>(3)?;
            let height = row.get::<_, Option<i32>>(4)?;
            Ok(StoredPreferences {
                locked,
                position: x.zip(y),
                size: width.zip(height),
            })
        })
        .optional()
        .map(|preferences| preferences.unwrap_or_default())
        .map_err(|error| error.to_string())
}

fn load_preferences() -> StoredPreferences {
    open_database()
        .and_then(|connection| load_preferences_from_connection(&connection))
        .unwrap_or_default()
}

fn save_preferences_to_connection(
    connection: &Connection,
    preferences: &StoredPreferences,
) -> Result<(), String> {
    let locked = if preferences.locked { 1 } else { 0 };
    let (x, y) = preferences
        .position
        .map(|(x, y)| (Some(x), Some(y)))
        .unwrap_or((None, None));
    let (width, height) = preferences
        .size
        .map(|(width, height)| (Some(width), Some(height)))
        .unwrap_or((None, None));
    connection
        .execute(UPSERT_PREFERENCES_SQL, params![locked, x, y, width, height])
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn save_preferences(preferences: &StoredPreferences) -> Result<(), String> {
    save_preferences_to_connection(&open_database()?, preferences)
}

fn load_todos(connection: &Connection) -> Result<Vec<Value>, String> {
    let mut statement = connection.prepare("SELECT id, date, text, done, created_at FROM todos ORDER BY rowid")
        .map_err(|error| error.to_string())?;
    let records = statement.query_map([], |row| Ok(json!({
        "id": row.get::<_, String>(0)?, "date": row.get::<_, String>(1)?,
        "text": row.get::<_, String>(2)?, "done": row.get::<_, i64>(3)? != 0,
        "createdAt": row.get::<_, i64>(4)?
    }))).map_err(|error| error.to_string())?;
    records.map(|record| record.map_err(|error| error.to_string())).collect()
}

fn load_adjustments(connection: &Connection) -> Result<Vec<Value>, String> {
    let mut counter_ranges = std::collections::HashMap::<String, Vec<Value>>::new();
    let mut counters = connection.prepare("SELECT adjustment_id, type, start_date, start_period, end_date, end_period
        FROM adjustment_counter_ranges ORDER BY adjustment_id, position").map_err(|error| error.to_string())?;
    for row in counters.query_map([], |row| Ok((row.get::<_, String>(0)?, json!({
        "type": row.get::<_, String>(1)?, "startDate": row.get::<_, String>(2)?,
        "startPeriod": row.get::<_, String>(3)?, "endDate": row.get::<_, String>(4)?,
        "endPeriod": row.get::<_, String>(5)?
    })))).map_err(|error| error.to_string())? {
        let (id, range) = row.map_err(|error| error.to_string())?;
        counter_ranges.entry(id).or_default().push(range);
    }
    let mut statement = connection.prepare("SELECT id, type, start_date, start_period, end_date, end_period, note, compensation_required, created_at FROM adjustments ORDER BY rowid")
        .map_err(|error| error.to_string())?;
    let records = statement.query_map([], |row| Ok(json!({
        "id": row.get::<_, String>(0)?, "type": row.get::<_, String>(1)?,
        "startDate": row.get::<_, String>(2)?, "startPeriod": row.get::<_, String>(3)?,
        "endDate": row.get::<_, String>(4)?, "endPeriod": row.get::<_, String>(5)?,
        "note": row.get::<_, String>(6)?, "compensationRequired": row.get::<_, i64>(7)? != 0,
        "createdAt": row.get::<_, i64>(8)?
    }))).map_err(|error| error.to_string())?;
    records.map(|record| {
        let mut record = record.map_err(|error| error.to_string())?;
        let id = required_string(&record, "id")?.to_owned();
        record.as_object_mut().ok_or("无效调班记录")?.insert(
            "counterRanges".to_string(), json!(counter_ranges.remove(&id).unwrap_or_default()));
        Ok(record)
    }).collect()
}

fn holiday_from_row(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<Value> {
    let kind: Option<String> = row.get(offset)?;
    let Some(kind) = kind else { return Ok(Value::Null); };
    let name: String = row.get(offset + 1)?;
    if kind == "block" {
        Ok(json!({
            "kind": kind, "name": name,
            "startDay": row.get::<_, String>(offset + 2)?,
            "endDay": row.get::<_, String>(offset + 3)?,
            "legalDays": row.get::<_, i64>(offset + 4)?,
            "makeupDays": row.get::<_, i64>(offset + 5)?
        }))
    } else {
        Ok(json!({ "kind": kind, "name": name }))
    }
}

fn load_holiday_cache(connection: &Connection) -> Result<serde_json::Map<String, Value>, String> {
    let mut cache = serde_json::Map::new();
    let mut years = connection.prepare("SELECT year FROM holiday_cache_years ORDER BY year")
        .map_err(|error| error.to_string())?;
    for year in years.query_map([], |row| row.get::<_, i64>(0)).map_err(|error| error.to_string())? {
        cache.insert(year.map_err(|error| error.to_string())?.to_string(), json!({}));
    }
    let mut statement = connection.prepare("SELECT year, date, kind, name, start_day, end_day, legal_days, makeup_days FROM holiday_cache ORDER BY year, date")
        .map_err(|error| error.to_string())?;
    for record in statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, holiday_from_row(row, 2)?)))
        .map_err(|error| error.to_string())? {
        let (year, date, holiday) = record.map_err(|error| error.to_string())?;
        cache.entry(year.to_string()).or_insert_with(|| json!({})).as_object_mut()
            .ok_or("无效节假日年度")?.insert(date, holiday);
    }
    Ok(cache)
}

fn load_holiday_overrides(connection: &Connection) -> Result<serde_json::Map<String, Value>, String> {
    let mut result = serde_json::Map::new();
    let mut statement = connection.prepare("SELECT date, kind, name, start_day, end_day, legal_days, makeup_days FROM holiday_overrides ORDER BY date")
        .map_err(|error| error.to_string())?;
    for record in statement.query_map([], |row| Ok((row.get::<_, String>(0)?, holiday_from_row(row, 1)?)))
        .map_err(|error| error.to_string())? {
        let (date, holiday) = record.map_err(|error| error.to_string())?;
        result.insert(date, holiday);
    }
    Ok(result)
}

fn load_palettes_from_connection(connection: &Connection, table: &str) -> Result<Value, String> {
    let mut palettes = json!({ "light": {}, "dark": {} });
    let sql = format!("SELECT mode, token, color FROM {table} ORDER BY mode, token");
    let mut statement = connection.prepare(&sql)
        .map_err(|error| error.to_string())?;
    for row in statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
        .map_err(|error| error.to_string())? {
        let (mode, token, color) = row.map_err(|error| error.to_string())?;
        if !["light", "dark"].contains(&mode.as_str()) || !PALETTE_TOKENS.contains(&token.as_str()) {
            return Err("数据库包含未知配色字段".into());
        }
        palettes[mode.as_str()][token.as_str()] = json!(color);
    }
    Ok(palettes)
}

fn load_settings_from_connection(connection: &Connection) -> Result<Option<Value>, String> {
    let mut settings = connection.query_row(
        "SELECT anchor_monday, week_starts_on, saturday_rest_period, saturday_repeat_interval_weeks,
            sunday_rest_period, sunday_repeat_interval_weeks, background_transparency, brightness,
            font_size_offset, theme, layout_density, monthly_max_adjustment_days,
            allow_cross_month_adjustment FROM settings WHERE id = 1",
        [],
        |row| Ok(json!({
            "anchorMonday": row.get::<_, String>(0)?,
            "weekStartsOn": row.get::<_, i64>(1)?,
            "weekendRules": {
                "5": { "restPeriod": row.get::<_, String>(2)?, "repeatIntervalWeeks": row.get::<_, i64>(3)? },
                "6": { "restPeriod": row.get::<_, String>(4)?, "repeatIntervalWeeks": row.get::<_, i64>(5)? }
            },
            "backgroundTransparency": row.get::<_, i64>(6)?,
            "brightness": row.get::<_, i64>(7)?,
            "fontSizeOffset": row.get::<_, i64>(8)?,
            "theme": row.get::<_, String>(9)?,
            "layoutDensity": row.get::<_, String>(10)?,
            "monthlyMaxAdjustmentDays": row.get::<_, f64>(11)?,
            "allowCrossMonthAdjustment": row.get::<_, bool>(12)?
        }))
    ).optional().map_err(|error| error.to_string())?;
    if let Some(ref mut settings) = settings {
        settings["palettes"] = load_palettes_from_connection(connection, "palette_colors")?;
        settings["customPalettes"] = load_palettes_from_connection(connection, "custom_palette_colors")?;
        settings["paletteScheme"] = json!(connection.query_row(
            "SELECT scheme_id FROM palette_scheme_selection WHERE id = 1", [], |row| row.get::<_, String>(0)
        ).optional().map_err(|error| error.to_string())?.unwrap_or_else(|| "default".to_string()));
    }
    Ok(settings)
}

fn load_split_state(connection: &Connection) -> Result<Option<Value>, String> {
    let settings = load_settings_from_connection(connection)?;
    let Some(settings) = settings else { return Ok(None); };
    let cache = load_holiday_cache(connection)?;
    let overrides = load_holiday_overrides(connection)?;
    Ok(Some(json!({
        "version": 12,
        "settings": settings,
        "todos": load_todos(connection)?,
        "adjustments": load_adjustments(connection)?,
        "holidayCache": cache,
        "holidayOverrides": overrides
    })))
}

fn load_state_from_connection(connection: &Connection) -> Result<Option<Value>, String> {
    load_split_state(connection)
}

fn required_string<'a>(record: &'a Value, field: &str) -> Result<&'a str, String> {
    record.get(field).and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("缺少有效字段 {field}"))
}

fn required_integer(record: &Value, field: &str) -> Result<i64, String> {
    record.get(field).and_then(Value::as_i64)
        .ok_or_else(|| format!("缺少有效整数 {field}"))
}

fn required_color<'a>(record: &'a Value, field: &str) -> Result<&'a str, String> {
    let color = required_string(record, field)?;
    let optional_alpha = ["rest-bg", "holiday-bg", "manual-rest-bg", "manual-work-bg"].contains(&field);
    let valid_length = if ALPHA_PALETTE_TOKENS.contains(&field) {
        color.len() == 9
    } else if optional_alpha {
        color.len() == 7 || color.len() == 9
    } else {
        color.len() == 7
    };

    if !valid_length || !color.starts_with('#') || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("无效配色字段 {field}"));
    }
    Ok(color)
}

fn text_field<'a>(record: &'a Value, field: &str) -> Result<&'a str, String> {
    record.get(field).and_then(Value::as_str)
        .ok_or_else(|| format!("缺少文本字段 {field}"))
}

fn holiday_fields(record: &Value) -> Result<(Option<&str>, Option<&str>, Option<&str>, Option<&str>, Option<i64>, Option<i64>), String> {
    if record.is_null() { return Ok((None, None, None, None, None, None)); }
    let kind = required_string(record, "kind")?;
    if !["block", "legal", "off", "work"].contains(&kind) { return Err("无效节假日类型".into()); }
    let name = text_field(record, "name")?;
    if kind == "block" {
        Ok((Some(kind), Some(name), Some(required_string(record, "startDay")?),
            Some(required_string(record, "endDay")?), Some(required_integer(record, "legalDays")?),
            Some(required_integer(record, "makeupDays")?)))
    } else {
        Ok((Some(kind), Some(name), None, None, None, None))
    }
}

fn save_state_to_connection(connection: &Connection, state: &Value) -> Result<(), String> {
    let settings = state.get("settings").filter(|value| value.is_object()).ok_or("缺少设置")?;
    let rules = settings.get("weekendRules").ok_or("缺少周末规则")?;
    let saturday = rules.get("5").filter(|value| value.is_object()).ok_or("缺少周六规则")?;
    let sunday = rules.get("6").filter(|value| value.is_object()).ok_or("缺少周日规则")?;
    let anchor = required_string(settings, "anchorMonday")?;
    let week_start = required_integer(settings, "weekStartsOn")?;
    let saturday_period = required_string(saturday, "restPeriod")?;
    let saturday_interval = required_integer(saturday, "repeatIntervalWeeks")?;
    let sunday_period = required_string(sunday, "restPeriod")?;
    let sunday_interval = required_integer(sunday, "repeatIntervalWeeks")?;
    let transparency = required_integer(settings, "backgroundTransparency")?;
    let brightness = required_integer(settings, "brightness")?;
    let font_size = required_integer(settings, "fontSizeOffset")?;
    let theme = required_string(settings, "theme")?;
    let layout_density = match settings.get("layoutDensity") {
        None => "spacious",
        Some(_) => required_string(settings, "layoutDensity")?,
    };

    if !["compact", "spacious"].contains(&layout_density) {
        return Err("无效排版密度".into());
    }

    let monthly_maximum = match settings.get("monthlyMaxAdjustmentDays") {
        None => 4.0,
        Some(value) => value.as_f64().ok_or("无效调休上限")?,
    };

    if !monthly_maximum.is_finite()
        || !(0.0..=31.0).contains(&monthly_maximum)
        || (monthly_maximum * 2.0).fract() != 0.0
    {
        return Err("无效调休上限".into());
    }

    let allow_cross_month = match settings.get("allowCrossMonthAdjustment") {
        None => false,
        Some(value) => value.as_bool().ok_or("无效跨月调休设置")?,
    };

    let scheme = required_string(settings, "paletteScheme")?;
    let scheme_name = scheme.strip_suffix(".json").unwrap_or(scheme);

    if scheme_name.is_empty() || scheme.len() > 120
        || !scheme_name.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-') {
        return Err("无效配色方案标识".into());
    }
    let palettes = settings.get("palettes").filter(|value| value.is_object()).ok_or("缺少两套配色")?;
    let custom_palettes = settings.get("customPalettes").filter(|value| value.is_object()).ok_or("缺少自定义配色")?;
    for mode in ["light", "dark"] {
        let palette = palettes.get(mode).filter(|value| value.is_object()).ok_or("缺少主题配色")?;
        let custom_palette = custom_palettes.get(mode).filter(|value| value.is_object()).ok_or("缺少自定义主题配色")?;
        for token in PALETTE_TOKENS {
            required_color(palette, token)?;

            if custom_palette.get(*token).is_some() {
                required_color(custom_palette, token)?;
            }
        }
    }
    let todos = state.get("todos").and_then(Value::as_array).ok_or("缺少待办")?;
    let adjustments = state.get("adjustments").and_then(Value::as_array).ok_or("缺少调班")?;
    let cache = state.get("holidayCache").and_then(Value::as_object).ok_or("缺少节假日缓存")?;
    let overrides = state.get("holidayOverrides").and_then(Value::as_object).ok_or("缺少日期修正")?;
    for todo in todos {
        required_string(todo, "id")?;
        required_string(todo, "date")?;
        text_field(todo, "text")?;
        todo.get("done").and_then(Value::as_bool).ok_or("缺少待办状态")?;
        required_integer(todo, "createdAt")?;
    }
    for record in adjustments {
        required_string(record, "id")?;
        required_string(record, "type")?;
        required_string(record, "startDate")?;
        required_string(record, "startPeriod")?;
        required_string(record, "endDate")?;
        required_string(record, "endPeriod")?;
        text_field(record, "note")?;
        record.get("compensationRequired").and_then(Value::as_bool).ok_or("缺少关联调班类型")?;
        let ranges = record.get("counterRanges").and_then(Value::as_array).ok_or("缺少关联日期范围")?;
        for range in ranges {
            let range_type = required_string(range, "type")?;
            if !["rest", "work"].contains(&range_type) { return Err("无效关联范围类型".into()); }
            required_string(range, "startDate")?;
            required_string(range, "startPeriod")?;
            required_string(range, "endDate")?;
            required_string(range, "endPeriod")?;
        }
        required_integer(record, "createdAt")?;
    }
    for (year, records) in cache {
        let year_number = year.parse::<i32>().map_err(|_| "无效年度")?;
        if !(1900..=2200).contains(&year_number) { return Err("无效年度".into()); }
        let records = records.as_object().ok_or("无效年度缓存")?;
        for (date, holiday) in records {
            if !date.starts_with(&format!("{year}-")) { return Err("节假日日期与缓存年份不一致".into()); }
            if holiday.is_null() { return Err("年度缓存不能包含空记录".into()); }
            holiday_fields(holiday)?;
        }
    }
    for (date, holiday) in overrides {
        if date.len() != 10 { return Err("无效修正日期".into()); }
        holiday_fields(holiday)?;
    }
    let previous = load_split_state(connection)?;
    let transaction = connection.unchecked_transaction().map_err(|error| error.to_string())?;
    if previous.as_ref().and_then(|saved| saved.get("settings")) != Some(settings) {
        let settings_parameters = params![
            anchor,
            week_start,
            saturday_period,
            saturday_interval,
            sunday_period,
            sunday_interval,
            transparency,
            brightness,
            font_size,
            theme,
            layout_density,
            monthly_maximum,
            allow_cross_month,
        ];

        transaction.execute(
            "INSERT INTO settings (id, anchor_monday, week_starts_on, saturday_rest_period,
                saturday_repeat_interval_weeks, sunday_rest_period, sunday_repeat_interval_weeks,
                background_transparency, brightness, font_size_offset, theme, layout_density,
                monthly_max_adjustment_days, allow_cross_month_adjustment)
                VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                ON CONFLICT(id) DO UPDATE SET
                    anchor_monday = excluded.anchor_monday,
                    week_starts_on = excluded.week_starts_on,
                    saturday_rest_period = excluded.saturday_rest_period,
                    saturday_repeat_interval_weeks = excluded.saturday_repeat_interval_weeks,
                    sunday_rest_period = excluded.sunday_rest_period,
                    sunday_repeat_interval_weeks = excluded.sunday_repeat_interval_weeks,
                    background_transparency = excluded.background_transparency,
                    brightness = excluded.brightness,
                    font_size_offset = excluded.font_size_offset,
                    theme = excluded.theme,
                    layout_density = excluded.layout_density,
                    monthly_max_adjustment_days = excluded.monthly_max_adjustment_days,
                    allow_cross_month_adjustment = excluded.allow_cross_month_adjustment",
            settings_parameters
        ).map_err(|error| error.to_string())?;
    }
    if previous.as_ref().and_then(|saved| saved["settings"]["paletteScheme"].as_str()) != Some(scheme) {
        transaction.execute("INSERT INTO palette_scheme_selection (id, scheme_id) VALUES (1, ?1)
            ON CONFLICT(id) DO UPDATE SET scheme_id = excluded.scheme_id", params![scheme])
            .map_err(|error| error.to_string())?;
    }
    for (table, key, colors) in [("palette_colors", "palettes", palettes), ("custom_palette_colors", "customPalettes", custom_palettes)] {
        let old = previous.as_ref().and_then(|saved| saved["settings"][key].as_object());
        for mode in ["light", "dark"] {
            let palette = &colors[mode];
            for token in PALETTE_TOKENS {
                if table == "custom_palette_colors" && palette.get(*token).is_none() {
                    let sql = "DELETE FROM custom_palette_colors WHERE mode = ?1 AND token = ?2";
                    let parameters = params![mode, token];
                    transaction.execute(sql, parameters).map_err(|error| error.to_string())?;
                    continue;
                }

                let color = required_color(palette, token)?;
                if old.and_then(|saved| saved.get(mode)).and_then(|old| old.get(*token)).and_then(Value::as_str) != Some(color) {
                    let sql = format!("INSERT INTO {table} (mode, token, color) VALUES (?1, ?2, ?3)
                        ON CONFLICT(mode, token) DO UPDATE SET color = excluded.color");
                    transaction.execute(&sql, params![mode, token, color]).map_err(|error| error.to_string())?;
                }
            }
        }
    }
    let old_todos = previous.as_ref().and_then(|saved| saved["todos"].as_array());
    for todo in old_todos.into_iter().flatten() {
        let id = required_string(todo, "id")?;
        if !todos.iter().any(|record| record["id"] == id) {
            transaction.execute("DELETE FROM todos WHERE id = ?1", params![id])
                .map_err(|error| error.to_string())?;
        }
    }
    for todo in todos {
        let id = required_string(todo, "id")?;
        if !old_todos.into_iter().flatten().any(|record| record["id"] == id && record == todo) {
            transaction.execute("INSERT INTO todos (id, date, text, done, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(id) DO UPDATE SET date = excluded.date, text = excluded.text,
                    done = excluded.done, created_at = excluded.created_at",
                params![id, required_string(todo, "date")?, text_field(todo, "text")?,
                    i64::from(todo["done"].as_bool().ok_or("缺少待办状态")?), required_integer(todo, "createdAt")?]
            ).map_err(|error| error.to_string())?;
        }
    }
    let old_adjustments = previous.as_ref().and_then(|saved| saved["adjustments"].as_array());
    for record in old_adjustments.into_iter().flatten() {
        let id = required_string(record, "id")?;
        if !adjustments.iter().any(|item| item["id"] == id) {
            transaction.execute("DELETE FROM adjustment_counter_ranges WHERE adjustment_id = ?1", params![id])
                .map_err(|error| error.to_string())?;
            transaction.execute("DELETE FROM adjustments WHERE id = ?1", params![id])
                .map_err(|error| error.to_string())?;
        }
    }
    for record in adjustments {
        let id = required_string(record, "id")?;
        if !old_adjustments.into_iter().flatten().any(|item| item["id"] == id && item == record) {
            transaction.execute("INSERT INTO adjustments
                (id, type, start_date, start_period, end_date, end_period, note, compensation_required, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(id) DO UPDATE SET type = excluded.type, start_date = excluded.start_date,
                    start_period = excluded.start_period, end_date = excluded.end_date,
                    end_period = excluded.end_period, note = excluded.note,
                    compensation_required = excluded.compensation_required, created_at = excluded.created_at",
                params![id, required_string(record, "type")?, required_string(record, "startDate")?,
                    required_string(record, "startPeriod")?, required_string(record, "endDate")?,
                    required_string(record, "endPeriod")?, text_field(record, "note")?,
                    i64::from(record["compensationRequired"].as_bool().ok_or("缺少关联调班类型")?),
                    required_integer(record, "createdAt")?]
            ).map_err(|error| error.to_string())?;
            transaction.execute("DELETE FROM adjustment_counter_ranges WHERE adjustment_id = ?1", params![id])
                .map_err(|error| error.to_string())?;
            for (position, range) in record["counterRanges"].as_array().ok_or("缺少关联日期范围")?.iter().enumerate() {
                transaction.execute("INSERT INTO adjustment_counter_ranges
                    (adjustment_id, position, type, start_date, start_period, end_date, end_period)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![id, position as i64, required_string(range, "type")?, required_string(range, "startDate")?,
                        required_string(range, "startPeriod")?, required_string(range, "endDate")?, required_string(range, "endPeriod")?]
                ).map_err(|error| error.to_string())?;
            }
        }
    }
    let old_cache = previous.as_ref().and_then(|saved| saved["holidayCache"].as_object());
    for year in old_cache.into_iter().flatten().map(|(year, _)| year) {
        if !cache.contains_key(year) {
            let year: i32 = year.parse().map_err(|_| "无效年度")?;
            transaction.execute("DELETE FROM holiday_cache WHERE year = ?1", params![year])
                .map_err(|error| error.to_string())?;
            transaction.execute("DELETE FROM holiday_cache_years WHERE year = ?1", params![year])
                .map_err(|error| error.to_string())?;
        }
    }
    for (year, records) in cache {
        if old_cache.and_then(|old| old.get(year)) != Some(records) {
            let year: i32 = year.parse().map_err(|_| "无效年度")?;
            transaction.execute("INSERT OR IGNORE INTO holiday_cache_years (year) VALUES (?1)", params![year])
                .map_err(|error| error.to_string())?;
            transaction.execute("DELETE FROM holiday_cache WHERE year = ?1", params![year])
                .map_err(|error| error.to_string())?;
            for (date, holiday) in records.as_object().ok_or("无效年度缓存")? {
                let (kind, name, start_day, end_day, legal_days, makeup_days) = holiday_fields(holiday)?;
                transaction.execute("INSERT INTO holiday_cache
                    (year, date, kind, name, start_day, end_day, legal_days, makeup_days)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![year, date, kind, name, start_day, end_day, legal_days, makeup_days]
                ).map_err(|error| error.to_string())?;
            }
        }
    }
    let old_overrides = previous.as_ref().and_then(|saved| saved["holidayOverrides"].as_object());
    for date in old_overrides.into_iter().flatten().map(|(date, _)| date) {
        if !overrides.contains_key(date) {
            transaction.execute("DELETE FROM holiday_overrides WHERE date = ?1", params![date])
                .map_err(|error| error.to_string())?;
        }
    }
    for (date, record) in overrides {
        if old_overrides.and_then(|old| old.get(date)) != Some(record) {
            let (kind, name, start_day, end_day, legal_days, makeup_days) = holiday_fields(record)?;
            transaction.execute("INSERT INTO holiday_overrides
                (date, kind, name, start_day, end_day, legal_days, makeup_days)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(date) DO UPDATE SET kind = excluded.kind, name = excluded.name,
                    start_day = excluded.start_day, end_day = excluded.end_day,
                    legal_days = excluded.legal_days, makeup_days = excluded.makeup_days",
                params![date, kind, name, start_day, end_day, legal_days, makeup_days]
            ).map_err(|error| error.to_string())?;
        }
    }
    transaction.execute_batch("PRAGMA user_version = 10;")
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn persist_current_window_size<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "无法获取主窗口".to_string())?;
    let connection = open_database()?;
    let mut preferences = load_preferences_from_connection(&connection)?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    preferences.size = Some((size.width as i32, size.height as i32));
    save_preferences_to_connection(&connection, &preferences)
}

#[tauri::command]
fn exit_app(window: WebviewWindow) {
    let _ = persist_current_window_size(window.app_handle());
    window.app_handle().exit(0);
}

#[tauri::command]
fn load_state() -> Result<Option<Value>, String> {
    load_state_from_connection(&open_database()?)
}

#[tauri::command]
fn save_state(state: Value) -> Result<(), String> {
    save_state_to_connection(&open_database()?, &state)
}

#[tauri::command]
fn get_preferences(app: AppHandle) -> Result<WindowPreferences, String> {
    let preferences = load_preferences();
    let auto_launch = app
        .autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())?;
    Ok(WindowPreferences {
        locked: preferences.locked,
        auto_launch,
        database_recovery_notice: DATABASE_RECOVERY_NOTICE
            .lock()
            .ok()
            .and_then(|notice| notice.clone()),
    })
}

#[tauri::command]
fn set_locked(window: WebviewWindow, locked: bool) -> Result<bool, String> {
    let window = window.app_handle().get_webview_window("main").ok_or("无法获取主窗口")?;
    let position = if locked {
        let position = window.outer_position().map_err(|error| error.to_string())?;
        Some((position.x, position.y))
    } else {
        None
    };
    window
        .set_resizable(!locked)
        .map_err(|error| error.to_string())?;
    save_preferences(&StoredPreferences {
        locked,
        position,
        size: None,
    })?;
    attachment::set_locked(window.app_handle(), locked);
    Ok(locked)
}

#[tauri::command]
fn save_window_size(window: WebviewWindow) -> Result<(), String> {
    persist_current_window_size(window.app_handle())
}

#[tauri::command]
fn set_auto_launch(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())?;
    } else {
        manager.disable().map_err(|error| error.to_string())?;
    }
    manager.is_enabled().map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _working_directory| show_main_window(app),
        ))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            exit_app,
            load_state,
            save_state,
            get_preferences,
            set_locked,
            save_window_size,
            set_auto_launch,
            attachment::set_attachment_visible,
            attachment::hide_attachment,
            attachment::begin_attachment_drag,
            attachment::move_attachment_drag,
            attachment::finish_attachment_drag,
            attachment::focus_calendar,
            recommendation::show_vacation_recommendations,
            recommendation::hide_vacation_recommendations
        ])
        .on_window_event(|window, event| {
            if attachment::handle_event(window, event) { return; }

            if recommendation::handle_event(window, event) { return; }

            if window.label() == "main" && matches!(event, WindowEvent::CloseRequested { .. }) {
                let _ = persist_current_window_size(window.app_handle());
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            let preferences = load_preferences();
            attachment::setup(app, preferences.locked)?;
            recommendation::setup(app)?;
            if let Some(window) = app.get_webview_window("main") {
                if let Some((width, height)) = preferences.size {
                    window.set_size(PhysicalSize::new(width as u32, height as u32))?;
                }
                if preferences.locked {
                    if let Some((x, y)) = preferences.position {
                        window.set_position(PhysicalPosition::new(x, y))?;
                    }
                }
                window.set_resizable(!preferences.locked)?;
            }

            let show = MenuItem::with_id(app, "show", "显示桌面日历", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &separator, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("桌面日历")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => {
                        let _ = persist_current_window_size(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run desktop calendar");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn default_palettes() -> Value {
        let mut palettes = json!({ "light": {}, "dark": {} });
        for mode in ["light", "dark"] {
            for token in PALETTE_TOKENS {
                palettes[mode][*token] = json!(if ALPHA_PALETTE_TOKENS.contains(token) { "#445566ff" } else { "#445566" });
            }
        }
        palettes
    }

    fn test_database() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        initialize_database(&connection).expect("initialize schema");
        connection
    }

    #[test]
    fn shared_sparse_colors_round_trip() {
        let connection = test_database();
        let mut state = json!({
            "settings": {
                "anchorMonday": "2026-09-14", "weekStartsOn": 6,
                "weekendRules": {
                    "5": { "restPeriod": "full", "repeatIntervalWeeks": 1 },
                    "6": { "restPeriod": "full", "repeatIntervalWeeks": 0 }
                },
                "backgroundTransparency": 30, "brightness": 100, "fontSizeOffset": 0,
                "theme": "system", "paletteScheme": "calendar-colors-08-fresh-v2.json",
                "palettes": default_palettes(),
                "customPalettes": { "light": {}, "dark": { "rest-bg": "#11223344" } }
            },
            "todos": [], "adjustments": [],
            "holidayCache": { "2027": {} }, "holidayOverrides": { "2026-01-01": null }
        });

        state["settings"]["palettes"]["dark"]["rest-bg"] = json!("#11223344");
        save_state_to_connection(&connection, &state).unwrap();
        let stored = load_state_from_connection(&connection).unwrap().unwrap();
        assert_eq!(stored["version"], 12);
        assert_eq!(stored["settings"]["customPalettes"], state["settings"]["customPalettes"]);
        assert_eq!(stored["settings"]["paletteScheme"], "calendar-colors-08-fresh-v2.json");
        assert_eq!(stored["holidayOverrides"]["2026-01-01"], Value::Null);
        state["settings"]["customPalettes"] = json!({ "light": {}, "dark": {} });
        save_state_to_connection(&connection, &state).unwrap();
        let restored = load_state_from_connection(&connection).unwrap().unwrap();
        assert_eq!(restored["settings"]["customPalettes"], state["settings"]["customPalettes"]);
    }

    #[test]
    fn sqlite_state_round_trip_and_unchanged_groups() {
        let connection = test_database();
        assert_eq!(load_state_from_connection(&connection).unwrap(), None);
        let mut state = json!({
            "settings": {
                "anchorMonday": "2026-09-14", "weekStartsOn": 6,
                "weekendRules": {
                    "5": { "restPeriod": "full", "repeatIntervalWeeks": 1 },
                    "6": { "restPeriod": "full", "repeatIntervalWeeks": 0 }
                },
                "backgroundTransparency": 100, "brightness": 100,
                "fontSizeOffset": 1, "theme": "system", "layoutDensity": "compact", "paletteScheme": "default",
                "monthlyMaxAdjustmentDays": 2.5, "allowCrossMonthAdjustment": true,
                "palettes": default_palettes(), "customPalettes": default_palettes()
            },
            "todos": [{ "id": "todo-1", "date": "2026-09-15", "done": false, "text": "任务", "createdAt": 1 }],
            "adjustments": [{ "id": "adj-1", "type": "rest", "startDate": "2026-09-16", "startPeriod": "am", "endDate": "2026-09-16", "endPeriod": "pm", "compensationRequired": true, "counterRanges": [
                { "type": "work", "startDate": "2026-09-20", "startPeriod": "am", "endDate": "2026-09-20", "endPeriod": "pm" },
                { "type": "work", "startDate": "2026-09-26", "startPeriod": "am", "endDate": "2026-09-26", "endPeriod": "am" }
            ], "note": "", "createdAt": 2 }],
            "holidayCache": {
                "2027": {
                    "2027-01-01": { "kind": "legal", "name": "元旦" },
                    "2027-02-01": { "kind": "block", "name": "春节", "startDay": "2027-02-01", "endDay": "2027-02-03", "legalDays": 1, "makeupDays": 0 }
                },
                "2028": {}
            },
            "holidayOverrides": { "2026-10-01": null, "2026-10-02": { "kind": "legal", "name": "调休" } }
        });
        save_state_to_connection(&connection, &state).unwrap();
        let stored = load_state_from_connection(&connection).unwrap().unwrap();
        assert_eq!(stored["settings"]["theme"], "system");
        assert_eq!(stored["settings"]["layoutDensity"], "compact");
        assert_eq!(stored["settings"]["monthlyMaxAdjustmentDays"], 2.5);
        assert_eq!(stored["settings"]["allowCrossMonthAdjustment"], true);
        assert_eq!(stored["settings"]["palettes"], state["settings"]["palettes"]);
        assert_eq!(stored["settings"]["backgroundTransparency"], 100);
        assert_eq!(stored["todos"], state["todos"]);
        assert_eq!(stored["adjustments"], state["adjustments"]);
        assert_eq!(stored["holidayCache"], state["holidayCache"]);
        assert_eq!(stored["holidayOverrides"], state["holidayOverrides"]);
        let palette_count: i64 = connection.query_row("SELECT COUNT(*) FROM palette_colors", [], |row| row.get(0)).unwrap();
        assert_eq!(palette_count, (PALETTE_TOKENS.len() * 2) as i64);
        let custom_count: i64 = connection.query_row("SELECT COUNT(*) FROM custom_palette_colors", [], |row| row.get(0)).unwrap();
        assert_eq!(custom_count, (PALETTE_TOKENS.len() * 2) as i64);
        let palette_rowid: i64 = connection.query_row("SELECT rowid FROM palette_colors WHERE mode = 'dark' AND token = 'toc-bg'", [], |row| row.get(0)).unwrap();
        let todo_rowid: i64 = connection.query_row("SELECT rowid FROM todos WHERE id = 'todo-1'", [], |row| row.get(0)).unwrap();
        state["settings"]["theme"] = json!("light");
        state["settings"]["layoutDensity"] = json!("spacious");
        state["settings"]["paletteScheme"] = json!("calendar-colors-01-minimal-20260915");
        state["settings"]["palettes"]["dark"]["rest-bg"] = json!("#334455");
        state["settings"]["palettes"]["light"]["primary"] = json!("#aabbcc");
        state["settings"]["palettes"]["light"]["stripe"] = json!("#aabbcc44");
        save_state_to_connection(&connection, &state).unwrap();
        let untouched_palette_rowid: i64 = connection.query_row("SELECT rowid FROM palette_colors WHERE mode = 'dark' AND token = 'toc-bg'", [], |row| row.get(0)).unwrap();
        assert_eq!(palette_rowid, untouched_palette_rowid);
        assert_eq!(load_state_from_connection(&connection).unwrap().unwrap()["settings"]["palettes"]["light"]["stripe"], "#aabbcc44");
        assert_eq!(load_state_from_connection(&connection).unwrap().unwrap()["settings"]["paletteScheme"], "calendar-colors-01-minimal-20260915");
        state["settings"]["paletteScheme"] = json!("custom");
        state["settings"]["customPalettes"]["light"]["primary"] = json!("#123456");
        save_state_to_connection(&connection, &state).unwrap();
        assert_eq!(load_state_from_connection(&connection).unwrap().unwrap()["settings"]["customPalettes"]["light"]["primary"], "#123456");
        let unchanged_rowid: i64 = connection.query_row("SELECT rowid FROM todos WHERE id = 'todo-1'", [], |row| row.get(0)).unwrap();
        assert_eq!(todo_rowid, unchanged_rowid);
        state["todos"].as_array_mut().unwrap().push(json!({"id":"todo-2", "date":"2026-09-16", "done":false, "text":"另一项", "createdAt":3}));
        save_state_to_connection(&connection, &state).unwrap();
        let other_rowid: i64 = connection.query_row("SELECT rowid FROM todos WHERE id = 'todo-2'", [], |row| row.get(0)).unwrap();
        state["todos"][0]["done"] = json!(true);
        state["holidayOverrides"].as_object_mut().unwrap().remove("2026-10-01");
        save_state_to_connection(&connection, &state).unwrap();
        let stable_rowid: i64 = connection.query_row("SELECT rowid FROM todos WHERE id = 'todo-2'", [], |row| row.get(0)).unwrap();
        assert_eq!(other_rowid, stable_rowid);
        assert_eq!(load_state_from_connection(&connection).unwrap().unwrap()["holidayOverrides"], state["holidayOverrides"]);
        assert_eq!(load_state_from_connection(&connection).unwrap().unwrap()["settings"], state["settings"]);
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 10);
    }

    #[test]
    fn counter_ranges_edit_and_delete_with_parent() {
        let connection = test_database();
        let mut state = json!({
            "settings": { "anchorMonday":"2026-09-14", "weekStartsOn":6,
                "weekendRules":{"5":{"restPeriod":"full","repeatIntervalWeeks":0},"6":{"restPeriod":"full","repeatIntervalWeeks":0}},
                "backgroundTransparency":100,"brightness":100,"fontSizeOffset":1,"theme":"dark","paletteScheme":"default",
                "palettes":default_palettes(),"customPalettes":default_palettes() },
            "todos":[], "adjustments":[{"id":"adjust-1","type":"work","startDate":"2026-09-20","startPeriod":"am",
                "endDate":"2026-09-20","endPeriod":"pm","note":"", "createdAt":1,
                "compensationRequired":true,"counterRanges":[{"type":"work","startDate":"2026-09-21","startPeriod":"am","endDate":"2026-09-21","endPeriod":"pm"}]}],
            "holidayCache":{}, "holidayOverrides":{}
        });
        save_state_to_connection(&connection, &state).unwrap();
        state["adjustments"][0]["counterRanges"] = json!([]);
        state["adjustments"][0]["compensationRequired"] = json!(false);
        save_state_to_connection(&connection, &state).unwrap();
        assert_eq!(load_state_from_connection(&connection).unwrap().unwrap()["adjustments"], state["adjustments"]);
        let ranges: i64 = connection.query_row("SELECT COUNT(*) FROM adjustment_counter_ranges", [], |row| row.get(0)).unwrap();
        assert_eq!(ranges, 0);
        state["adjustments"] = json!([]);
        save_state_to_connection(&connection, &state).unwrap();
        let parents: i64 = connection.query_row("SELECT COUNT(*) FROM adjustments", [], |row| row.get(0)).unwrap();
        assert_eq!(parents, 0);
    }

    #[test]
    fn old_wide_palette_schema_is_rejected_without_migration() {
        let connection = test_database();
        connection.execute_batch("PRAGMA user_version = 7;").unwrap();
        assert!(initialize_database(&connection).unwrap_err().contains("旧版"));
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 7);
    }

    #[test]
    fn previous_typed_adjustment_schema_is_rejected_without_migration() {
        let connection = test_database();
        connection.execute_batch("PRAGMA user_version = 8;").unwrap();
        assert!(initialize_database(&connection).unwrap_err().contains("旧版"));
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 8);
    }

    #[test]
    fn previous_window_geometry_schema_is_repaired_without_losing_preferences() {
        let connection = Connection::open_in_memory().unwrap();
        let previous_schema = CREATE_SCHEMA_SQL.replace(
            "    window_y INTEGER,\n    window_width INTEGER CHECK (window_width IS NULL OR window_width > 0),\n    window_height INTEGER CHECK (window_height IS NULL OR window_height > 0),\n",
            "    window_y INTEGER,\n",
        );
        connection.execute_batch(&previous_schema).unwrap();
        connection.execute(
            "INSERT INTO preferences (id, locked, window_x, window_y) VALUES (1, 1, 120, -40)",
            [],
        ).unwrap();
        connection.execute_batch("PRAGMA user_version = 9;").unwrap();

        initialize_database(&connection).unwrap();

        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 10);
        let preferences = load_preferences_from_connection(&connection).unwrap();
        assert!(preferences.locked);
        assert_eq!(preferences.position, Some((120, -40)));
        assert_eq!(preferences.size, None);
    }

    #[test]
    fn previous_settings_gain_spacious_density_without_losing_data() {
        let connection = Connection::open_in_memory().unwrap();
        let previous_schema = CREATE_SCHEMA_SQL.replace(
            ",\n    layout_density TEXT NOT NULL DEFAULT 'spacious' CHECK (layout_density IN ('compact', 'spacious'))",
            "",
        ).replace(
            ",\n    monthly_max_adjustment_days REAL NOT NULL DEFAULT 4 CHECK (monthly_max_adjustment_days BETWEEN 0 AND 31 AND monthly_max_adjustment_days * 2 = CAST(monthly_max_adjustment_days * 2 AS INTEGER))",
            "",
        ).replace(
            ",\n    allow_cross_month_adjustment INTEGER NOT NULL DEFAULT 0 CHECK (allow_cross_month_adjustment IN (0, 1))",
            "",
        );
        connection.execute_batch(&previous_schema).unwrap();
        connection.execute_batch(
            "INSERT INTO settings VALUES (1, '2026-09-14', 6, 'full', 1, 'none', 0, 30, 100, 0, 'dark');
            INSERT INTO todos VALUES ('kept', '2026-10-28', '保留待办', 0, 1);
            PRAGMA user_version = 10;",
        ).unwrap();

        initialize_database(&connection).unwrap();
        initialize_database(&connection).unwrap();

        let settings = load_settings_from_connection(&connection).unwrap().unwrap();
        assert_eq!(settings["layoutDensity"], "spacious");
        assert_eq!(settings["monthlyMaxAdjustmentDays"], 4.0);
        assert_eq!(settings["allowCrossMonthAdjustment"], false);
        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["weekendRules"]["6"]["restPeriod"], "none");
        let text: String = connection.query_row("SELECT text FROM todos WHERE id = 'kept'", [], |row| row.get(0)).unwrap();
        assert_eq!(text, "保留待办");
    }

    #[test]
    fn previous_adjustment_schema_is_rejected_without_migration() {
        let connection = test_database();
        connection.execute_batch("PRAGMA user_version = 6;").unwrap();
        assert!(initialize_database(&connection).unwrap_err().contains("旧版"));
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 6);
    }

    #[test]
    fn business_tables_use_columns_and_reject_invalid_settings() {
        let connection = test_database();
        let mut columns = connection.prepare("PRAGMA table_info(settings)").unwrap();
        let names = columns.query_map([], |row| row.get::<_, String>(1)).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap();
        assert!(names.contains(&"anchor_monday".to_string()));
        assert!(names.contains(&"brightness".to_string()));
        assert!(!names.contains(&"dark_cell_color".to_string()));
        let mut palette_columns = connection.prepare("PRAGMA table_info(palette_colors)").unwrap();
        let palette_names = palette_columns.query_map([], |row| row.get::<_, String>(1)).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap();
        assert!(palette_names.contains(&"mode".to_string()));
        assert!(palette_names.contains(&"token".to_string()));
        assert!(palette_names.contains(&"color".to_string()));
        assert!(!names.contains(&"settings_json".to_string()));
        for (table, legacy_column) in [
            ("todos", "todo_json"), ("adjustments", "adjustment_json"),
            ("holiday_cache", "holidays_json"), ("holiday_overrides", "holiday_json")
        ] {
            let sql = format!("PRAGMA table_info({table})");
            let mut statement = connection.prepare(&sql).unwrap();
            let fields = statement.query_map([], |row| row.get::<_, String>(1)).unwrap()
                .collect::<Result<Vec<_>, _>>().unwrap();
            assert!(!fields.contains(&legacy_column.to_string()));
        }
        let state = json!({
            "settings": {
                "anchorMonday":"2026-09-14", "weekStartsOn":6,
                "weekendRules":{"5":{"restPeriod":"full","repeatIntervalWeeks":1},"6":{"restPeriod":"full","repeatIntervalWeeks":0}},
                "backgroundTransparency":100,"brightness":100,"fontSizeOffset":1,"theme":"dark","paletteScheme":"default",
                "layoutDensity":"spacious","palettes":default_palettes(),"customPalettes":default_palettes()
            },
            "todos": [], "adjustments": [], "holidayCache": {}, "holidayOverrides": {}
        });
        save_state_to_connection(&connection, &state).unwrap();
        let mut invalid_density = state.clone();
        let mut expected_settings = state["settings"].clone();
        expected_settings["monthlyMaxAdjustmentDays"] = json!(4.0);
        expected_settings["allowCrossMonthAdjustment"] = json!(false);

        for maximum in [json!(-1), json!(31.5), json!(0.1), json!(null), json!("4")] {
            let mut invalid = state.clone();
            invalid["settings"]["monthlyMaxAdjustmentDays"] = maximum;
            assert!(save_state_to_connection(&connection, &invalid).is_err());
        }

        for allow in [json!(1), json!(null), json!("true")] {
            let mut invalid = state.clone();
            invalid["settings"]["allowCrossMonthAdjustment"] = allow;
            assert!(save_state_to_connection(&connection, &invalid).is_err());
        }

        for density in [json!("dense"), json!(null), json!(1)] {
            invalid_density["settings"]["layoutDensity"] = density;
            assert!(save_state_to_connection(&connection, &invalid_density).is_err());
        }

        assert!(connection.execute("UPDATE settings SET layout_density = 'dense' WHERE id = 1", []).is_err());
        let mut invalid = state.clone();
        invalid["settings"]["brightness"] = json!(200);
        assert!(save_state_to_connection(&connection, &invalid).is_err());
        invalid["settings"]["brightness"] = json!(100);
        invalid["settings"]["backgroundTransparency"] = json!(101);
        assert!(save_state_to_connection(&connection, &invalid).is_err());
        invalid["settings"]["backgroundTransparency"] = json!(100);
        invalid["settings"]["palettes"]["light"]["green"] = json!("not-a-color");
        assert!(save_state_to_connection(&connection, &invalid).is_err());
        invalid["settings"]["palettes"]["light"]["stripe"] = json!("#aabbcc");
        assert!(save_state_to_connection(&connection, &invalid).is_err());
        assert_eq!(load_state_from_connection(&connection).unwrap().unwrap()["settings"], expected_settings);
    }

    #[test]
    fn old_palette_schema_is_rejected_without_modifying_data() {
        let connection = test_database();
        connection.execute_batch("PRAGMA user_version = 5;").unwrap();
        let error = initialize_database(&connection).unwrap_err();
        assert!(error.contains("旧版 settings"));
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 5);
    }

    #[test]
    fn old_json_tables_are_rejected_without_modifying_data() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(r#"CREATE TABLE settings (id INTEGER PRIMARY KEY, settings_json TEXT NOT NULL); INSERT INTO settings VALUES (1, '{"theme":"light"}');"#).unwrap();
        let error = initialize_database(&connection).unwrap_err();
        assert!(error.contains("旧版 settings"));
        let old: String = connection.query_row("SELECT settings_json FROM settings WHERE id = 1", [], |row| row.get(0)).unwrap();
        assert_eq!(old, r#"{"theme":"light"}"#);
        let other_tables: i64 = connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'todos'", [], |row| row.get(0)).unwrap();
        assert_eq!(other_tables, 0);
    }

    #[test]
    fn old_theme_constraint_is_rejected_without_modifying_data() {
        let connection = test_database();
        connection.execute_batch("PRAGMA user_version = 3;").unwrap();
        let error = initialize_database(&connection).unwrap_err();
        assert!(error.contains("旧版 settings"));
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 3);
    }

    #[test]
    fn old_transparency_constraint_is_rejected_without_modifying_data() {
        let connection = Connection::open_in_memory().unwrap();
        let old_schema = CREATE_SCHEMA_SQL.replace(
            "background_transparency BETWEEN 0 AND 100",
            "background_transparency BETWEEN 0 AND 90",
        );
        connection.execute_batch(&old_schema).unwrap();
        connection.execute_batch("PRAGMA user_version = 4;").unwrap();
        let error = initialize_database(&connection).unwrap_err();
        assert!(error.contains("旧版 settings"));
        let schema: String = connection.query_row("SELECT sql FROM sqlite_master WHERE name = 'settings'", [], |row| row.get(0)).unwrap();
        assert!(schema.contains("background_transparency BETWEEN 0 AND 90"));
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 4);
    }

    #[test]
    fn old_monolithic_table_is_not_read() {
        let connection = test_database();
        connection.execute_batch("CREATE TABLE app_state (id INTEGER PRIMARY KEY, state_json TEXT NOT NULL);").unwrap();
        connection.execute("INSERT INTO app_state (id, state_json) VALUES (1, ?1)", params![r#"{"todos":[{"id":"old"}]}"#]).unwrap();
        assert_eq!(load_state_from_connection(&connection).unwrap(), None);
    }

    #[test]
    fn old_preferences_without_window_geometry_are_rejected() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE preferences (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                locked INTEGER NOT NULL CHECK (locked IN (0, 1)),
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );",
        ).unwrap();

        let error = initialize_database(&connection).unwrap_err();
        assert!(error.contains("preferences"));
        let columns: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('preferences')",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(columns, 3);
    }

    #[test]
    fn missing_indexes_are_recreated_during_startup_check() {
        let connection = test_database();
        connection.execute_batch("DROP INDEX idx_todos_date_done;").unwrap();

        initialize_database(&connection).unwrap();

        let indexes: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_todos_date_done'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(indexes, 1);
    }

    #[test]
    fn forced_database_reset_preserves_valid_rows_and_keeps_backup() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "desktop-calendar-todo-recovery-{}-{unique}.db",
            std::process::id()
        ));
        let old = Connection::open(&path).unwrap();
        old.execute_batch(
            "CREATE TABLE todos (
                id TEXT PRIMARY KEY,
                date TEXT NOT NULL,
                text TEXT NOT NULL,
                done INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            INSERT INTO todos VALUES ('valid', '2026-09-16', '保留', 0, 1);
            INSERT INTO todos VALUES ('invalid', '2026-09-16', '跳过', 2, 2);
            PRAGMA user_version = 8;",
        ).unwrap();
        drop(old);

        let recovered = open_database_at_path(&path).unwrap();
        let version: i64 = recovered.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        let valid: i64 = recovered.query_row(
            "SELECT COUNT(*) FROM todos WHERE id = 'valid'",
            [],
            |row| row.get(0),
        ).unwrap();
        let invalid: i64 = recovered.query_row(
            "SELECT COUNT(*) FROM todos WHERE id = 'invalid'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(version, 10);
        assert_eq!(valid, 1);
        assert_eq!(invalid, 0);
        drop(recovered);

        let file_name = path.file_name().unwrap().to_string_lossy();
        let backup_prefix = format!("{file_name}.recovery-");
        let backups = fs::read_dir(path.parent().unwrap()).unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|candidate| {
                candidate.file_name()
                    .map(|name| name.to_string_lossy().starts_with(&backup_prefix))
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);

        fs::remove_file(&path).unwrap();
        for backup in backups {
            fs::remove_file(backup).unwrap();
        }
    }

    #[test]
    fn sqlite_preferences_round_trip() {
        let connection = test_database();
        let initial = load_preferences_from_connection(&connection).unwrap();
        assert!(!initial.locked);
        assert_eq!(initial.position, None);
        assert_eq!(initial.size, None);

        save_preferences_to_connection(
            &connection,
            &StoredPreferences {
                locked: true,
                position: Some((120, -40)),
                size: Some((612, 744)),
            },
        )
        .unwrap();

        let locked = load_preferences_from_connection(&connection).unwrap();
        assert!(locked.locked);
        assert_eq!(locked.position, Some((120, -40)));
        assert_eq!(locked.size, Some((612, 744)));

        save_preferences_to_connection(
            &connection,
            &StoredPreferences {
                locked: false,
                position: None,
                size: None,
            },
        )
        .unwrap();

        let unlocked = load_preferences_from_connection(&connection).unwrap();
        assert!(!unlocked.locked);
        assert_eq!(unlocked.position, Some((120, -40)));
        assert_eq!(unlocked.size, Some((612, 744)));
    }
}
