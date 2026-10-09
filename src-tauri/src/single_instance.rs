#[cfg(windows)]
use std::sync::OnceLock;

#[cfg(windows)]
static INSTANCE_MUTEX: OnceLock<usize> = OnceLock::new();

/// Keeps one Lume process per Windows user session. The pet window already has a
/// stable Tauri label; this guard also prevents a second process from creating
/// another window with the same pet.
#[cfg(windows)]
pub fn claim() -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS},
        System::Threading::CreateMutexW,
    };

    let name: Vec<u16> = "Local\\LumeDesktopSingleInstance\0"
        .encode_utf16()
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        // A mutex failure should not make the application unusable.
        return true;
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe {
            CloseHandle(handle);
        }
        return false;
    }
    let _ = INSTANCE_MUTEX.set(handle as usize);
    true
}

#[cfg(not(windows))]
pub fn claim() -> bool {
    true
}
