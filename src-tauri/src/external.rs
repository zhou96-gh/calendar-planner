/**
 * 原生边界只接受具有主机名的 HTTP/HTTPS 网页地址。
 */
fn parse_external_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|_| "网页链接无效".to_string())?;

    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("仅支持 HTTP/HTTPS 网页链接".to_string());
    }

    Ok(url)
}

/**
 * 通过默认浏览器打开网页，不在插件 WebView 内导航。
 */
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let url = parse_external_url(&url)?;

    #[cfg(windows)]
    {
        use std::ffi::c_void;
        use std::ptr::null;

        #[link(name = "shell32")]
        extern "system" {
            fn ShellExecuteW(window: *mut c_void, operation: *const u16, file: *const u16, parameters: *const u16, directory: *const u16, show: i32) -> *mut c_void;
        }

        let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let address: Vec<u16> = url.as_str().encode_utf16().chain(Some(0)).collect();
        let window = std::ptr::null_mut();
        let operation_pointer = operation.as_ptr();
        let address_pointer = address.as_ptr();
        let empty = null();

        // 两个字符串均以 NUL 结束，指针在同步系统调用期间保持有效。
        let result = unsafe {
            ShellExecuteW(window, operation_pointer, address_pointer, empty, empty, 1)
        } as isize;

        if result <= 32 {
            return Err(format!("无法打开默认浏览器（系统错误 {result}）"));
        }

        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = url;
        Err("当前桌面平台不支持打开外部链接".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webpage_urls_are_accepted_without_opening_a_browser() {
        let url = parse_external_url("https://www.shuyz.com/githubfiles/china-holiday-calender/master/holidayAPI.json").unwrap();
        assert_eq!(url.host_str(), Some("www.shuyz.com"));
        assert!(parse_external_url("http://www.gov.cn/").is_ok());
    }

    #[test]
    fn non_webpage_urls_are_rejected_before_native_launch() {
        for value in ["javascript:alert(1)", "file:///C:/test.txt", "mailto:test@example.com", "https://", "not a url"] {
            assert!(open_external_url(value.to_string()).is_err());
        }
    }
}
