//! Narrow Windows boundary. No screen capture, key logging or inference at startup.
use serde_json::{Value, json};
use std::{
    mem::{size_of, zeroed},
    ptr::null_mut,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc::SyncSender,
    },
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, FILETIME, HWND, INVALID_HANDLE_VALUE, LPARAM, POINT, RECT},
    System::{
        DataExchange::*, Diagnostics::ToolHelp::*, Memory::*, ProcessStatus::*,
        SystemInformation::*, Threading::*,
    },
    UI::{Accessibility::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

struct Handle(windows_sys::Win32::Foundation::HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn ticks(t: FILETIME) -> u64 {
    ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
}
pub fn process_ticks() -> Option<u64> {
    unsafe {
        let (mut c, mut e, mut k, mut u) = (zeroed(), zeroed(), zeroed(), zeroed());
        (GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u) != 0)
            .then(|| ticks(k) + ticks(u))
    }
}
pub fn process_memory() -> Value {
    unsafe {
        let mut m: PROCESS_MEMORY_COUNTERS_EX = zeroed();
        m.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        if GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut m as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
            m.cb,
        ) == 0
        {
            return Value::Null;
        }
        json!({"working_set_bytes":m.WorkingSetSize,"private_bytes":m.PrivateUsage})
    }
}
pub fn system_info() -> Value {
    let cpu = windows_registry::LOCAL_MACHINE
        .open(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
        .ok()
        .and_then(|k| k.get_string("ProcessorNameString").ok());
    let os = windows_registry::LOCAL_MACHINE
        .open(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        .ok();
    let field = |n| os.as_ref().and_then(|k| k.get_string(n).ok());
    let mut memory: MEMORYSTATUSEX = unsafe { zeroed() };
    memory.dwLength = size_of::<MEMORYSTATUSEX>() as u32;
    let valid = unsafe { GlobalMemoryStatusEx(&mut memory) != 0 };
    json!({"os":"Windows","build":field("CurrentBuildNumber"),"display_version":field("DisplayVersion"),"architecture":std::env::consts::ARCH,
        "cpu_name":cpu.map(|s|s.trim().to_owned()),"logical_processors":std::thread::available_parallelism().map(|v|v.get()).unwrap_or(1),
        "total_memory_bytes":valid.then_some(memory.ullTotalPhys),"available_memory_bytes":valid.then_some(memory.ullAvailPhys)})
}
unsafe fn window(hwnd: HWND) -> Value {
    unsafe {
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let mut title = [0u16; 512];
        let n = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32).max(0) as usize;
        let mut rect: RECT = zeroed();
        let has_rect = GetWindowRect(hwnd, &mut rect) != 0;
        json!({"window_id":format!("{:x}",hwnd as usize),"pid":pid,"title":String::from_utf16_lossy(&title[..n]),
            "foreground":hwnd==GetForegroundWindow(),"minimized":IsIconic(hwnd)!=0,
            "bounds":has_rect.then(||json!({"x":rect.left,"y":rect.top,"width":rect.right-rect.left,"height":rect.bottom-rect.top})),
            "coordinate_space":"screen_pixels","title_truncated":n==511})
    }
}
pub fn foreground() -> Value {
    unsafe {
        let h = GetForegroundWindow();
        if h.is_null() { Value::Null } else { window(h) }
    }
}
unsafe extern "system" fn enum_window(hwnd: HWND, param: LPARAM) -> i32 {
    unsafe {
        let list = &mut *(param as *mut Vec<Value>);
        if IsWindowVisible(hwnd) != 0 && GetWindowTextLengthW(hwnd) > 0 {
            list.push(window(hwnd));
        }
        (list.len() < 1000) as i32
    }
}
pub fn windows() -> Value {
    let mut list = Vec::<Value>::new();
    unsafe {
        EnumWindows(Some(enum_window), &mut list as *mut _ as LPARAM);
    }
    json!({"items":list,"truncated":list.len()>=1000,"identity_scope":"current observation; HWND may be reused"})
}
pub fn processes() -> Result<Value, String> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let snapshot = Handle(snapshot);
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut items = Vec::new();
        if Process32FirstW(snapshot.0, &mut entry) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        loop {
            let end = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            items.push(json!({"pid":entry.th32ProcessID,"parent_pid":entry.th32ParentProcessID,"name":String::from_utf16_lossy(&entry.szExeFile[..end]),"threads":entry.cntThreads}));
            if Process32NextW(snapshot.0, &mut entry) == 0 {
                break;
            }
        }
        items.sort_by_key(|v| v["name"].as_str().unwrap_or_default().to_lowercase());
        Ok(json!({"items":items,"identity_scope":"snapshot only; PID may be reused"}))
    }
}
pub fn input_state() -> Value {
    unsafe {
        let mut point: POINT = zeroed();
        let cursor = GetCursorPos(&mut point) != 0;
        let mut last = LASTINPUTINFO {
            cbSize: size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        let idle = GetLastInputInfo(&mut last) != 0;
        json!({"cursor":cursor.then(||json!({"x":point.x,"y":point.y})),"idle_ms":idle.then(||GetTickCount().wrapping_sub(last.dwTime)),"coordinate_space":"screen_pixels"})
    }
}
pub fn clipboard_sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}
pub fn clipboard(include_text: bool) -> Result<Value, String> {
    unsafe {
        let sequence = GetClipboardSequenceNumber();
        let has_text = IsClipboardFormatAvailable(13) != 0;
        if !include_text || !has_text {
            return Ok(json!({"sequence":sequence,"has_text":has_text,"text_collected":false}));
        }
        if OpenClipboard(null_mut()) == 0 {
            return Err("Clipboard ocupado ou indisponível. Tente novamente.".into());
        }
        struct Clipboard;
        impl Drop for Clipboard {
            fn drop(&mut self) {
                unsafe {
                    CloseClipboard();
                }
            }
        }
        let _guard = Clipboard;
        let handle = GetClipboardData(13);
        if handle.is_null() {
            return Err("Texto indisponível".into());
        }
        let bytes = GlobalSize(handle);
        let ptr = GlobalLock(handle) as *const u16;
        if ptr.is_null() {
            return Err("Não foi possível ler o clipboard".into());
        }
        let units = (bytes / 2).min(8192);
        let slice = std::slice::from_raw_parts(ptr, units);
        let end = slice.iter().position(|&v| v == 0).unwrap_or(units);
        let text = String::from_utf16_lossy(&slice[..end]);
        GlobalUnlock(handle);
        Ok(
            json!({"sequence":GetClipboardSequenceNumber(),"has_text":true,"text_collected":true,"text":text,"truncated":end==8192}),
        )
    }
}

static HOOK_TX: OnceLock<SyncSender<()>> = OnceLock::new();
unsafe extern "system" fn on_foreground(
    _: HWINEVENTHOOK,
    _: u32,
    _: HWND,
    _: i32,
    _: i32,
    _: u32,
    _: u32,
) {
    if let Some(tx) = HOOK_TX.get() {
        let _ = tx.try_send(());
    } // Coalesced wake; latest state is re-read.
}
pub fn start_foreground_hook(tx: SyncSender<()>, active: Arc<AtomicBool>) {
    let _ = HOOK_TX.set(tx);
    std::thread::Builder::new()
        .name("nervo-winevents".into())
        .spawn(move || unsafe {
            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                null_mut(),
                Some(on_foreground),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            if hook.is_null() {
                return;
            }
            active.store(true, Ordering::Relaxed);
            let mut msg: MSG = zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            UnhookWinEvent(hook);
            active.store(false, Ordering::Relaxed);
        })
        .expect("WinEvent thread");
}
