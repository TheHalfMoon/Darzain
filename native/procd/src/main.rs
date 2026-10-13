//! yamakan-procd — owns the media workers the Yamakan service launches.
//!
//! The service starts one procd and speaks a line protocol over its stdin and
//! stdout. Each worker is created suspended and already inside its own Job
//! Object (PROC_THREAD_ATTRIBUTE_JOB_LIST), so it never exists outside
//! ownership. Jobs are KILL_ON_JOB_CLOSE, allow exactly one active process and
//! no breakaway, and only procd holds their handles. Therefore:
//!   * procd dies (any cause)     -> the OS closes the job handles -> workers die;
//!   * the service dies           -> procd's stdin closes -> procd terminates
//!                                   every job and exits;
//!   * a worker is never resumed before the service has recorded its identity;
//!   * a worker runs with a restricted, low-integrity copy of procd's token
//!     (no privileges, Administrators deny-only), so it cannot reach services
//!     such as WMI that would start a process outside its job, and it can
//!     write only to the folders its request names (labelled low integrity
//!     while it runs, restored when it exits);
//!   * a worker runs inside an AppContainer with no network capability and
//!     reads only what its request names (container.rs).
//! Worker output travels through anonymous pipes that only procd can read and
//! is relayed to the service; no named object is ever opened.
//!
//! Protocol (tab-separated; strings and data are hex-encoded):
//!   SPAWN id exe cwd jobMemoryBytes writableCount dir... readableCount path... argc arg...
//!       -> CREATED id pid       (suspended, inside its job)
//!   RESUME id                   -> RESUMED id
//!   KILL id                     -> (EXITED follows)
//!   (worker output)             -> OUT id hexChunk | ERR id hexChunk
//!   (process end, after output) -> EXITED id exitCode restored(1|0) peakJobBytes
//!   errors                      -> ERROR id hexMessage
//! Executables must be on the allowlist given as arguments at startup.

use std::collections::HashMap;
use std::ffi::c_void;
use std::io::{BufRead, BufReader, Read, Write};
use std::ptr::null_mut;
use std::sync::{Arc, Mutex};

mod container;

type Handle = *mut c_void;
type Bool = i32;

const CREATE_SUSPENDED: u32 = 0x0000_0004;
const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;
const PROC_THREAD_ATTRIBUTE_JOB_LIST: usize = 0x0002_000D;
const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: u32 = 0x0000_0008;
const JOB_OBJECT_LIMIT_JOB_MEMORY: u32 = 0x0000_0200;
const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION: u32 = 0x0000_0400;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;
const GENERIC_READ: u32 = 0x8000_0000;
const OPEN_EXISTING: u32 = 3;
const INFINITE: u32 = 0xFFFF_FFFF;
const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
const MAX_COMMAND_LINE: usize = 32_766;
const MAX_REQUEST_LINE: usize = 256 * 1024;
const MAX_LIVE_WORKERS: usize = 64;
const RELAY_CHUNK: usize = 16 * 1024;
const MAX_WRITABLE: usize = 8;
const MAX_READABLE: usize = 64;
const TOKEN_ASSIGN_PRIMARY: u32 = 0x0001;
const TOKEN_DUPLICATE: u32 = 0x0002;
const TOKEN_QUERY: u32 = 0x0008;
const TOKEN_ADJUST_DEFAULT: u32 = 0x0080;
const DISABLE_MAX_PRIVILEGE: u32 = 0x1;
const TOKEN_INTEGRITY_LEVEL_CLASS: i32 = 25;
const SE_GROUP_INTEGRITY: u32 = 0x0000_0020;
const WIN_BUILTIN_ADMINISTRATORS_SID: i32 = 26;
const WIN_LOW_LABEL_SID: i32 = 66;
const SECURITY_MAX_SID_SIZE: usize = 68;
const SE_FILE_OBJECT: i32 = 1;
const LABEL_SECURITY_INFORMATION: u32 = 0x0000_0010;
const ACL_REVISION: u32 = 2;
const OBJECT_INHERIT_ACE: u32 = 0x1;
const CONTAINER_INHERIT_ACE: u32 = 0x2;
const SYSTEM_MANDATORY_LABEL_NO_WRITE_UP: u32 = 0x1;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
const FILE_ALL_ACCESS: u32 = 0x001F_01FF;
const TOKEN_USER_CLASS: i32 = 1;
const ERROR_ACCESS_DENIED: u32 = 5;
const UNPROTECTED_DACL_SECURITY_INFORMATION: u32 = 0x2000_0000;
const PROGRESS_INVOKE_NEVER: i32 = 1;

#[repr(C)]
struct SecurityAttributes {
    n_length: u32,
    security_descriptor: *mut c_void,
    inherit_handle: Bool,
}

#[repr(C)]
struct SidAndAttributes {
    sid: *mut c_void,
    attributes: u32,
}

#[repr(C)]
struct StartupInfoW {
    cb: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    x_size: u32,
    y_size: u32,
    x_count_chars: u32,
    y_count_chars: u32,
    fill_attribute: u32,
    flags: u32,
    show_window: u16,
    cb_reserved2: u16,
    reserved2: *mut u8,
    std_input: Handle,
    std_output: Handle,
    std_error: Handle,
}

#[repr(C)]
struct StartupInfoExW {
    startup_info: StartupInfoW,
    attribute_list: *mut c_void,
}

#[repr(C)]
struct ProcessInformation {
    process: Handle,
    thread: Handle,
    process_id: u32,
    thread_id: u32,
}

#[repr(C)]
#[derive(Default)]
struct BasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
#[derive(Default)]
struct IoCounters {
    counts: [u64; 6],
}

#[repr(C)]
#[derive(Default)]
struct ExtendedLimitInformation {
    basic: BasicLimitInformation,
    io: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

// x64 layouts, checked against the Windows SDK definitions.
#[cfg(target_pointer_width = "64")]
const _: () = {
    assert!(std::mem::size_of::<SecurityAttributes>() == 24);
    assert!(std::mem::size_of::<SidAndAttributes>() == 16);
    assert!(std::mem::size_of::<StartupInfoW>() == 104);
    assert!(std::mem::size_of::<StartupInfoExW>() == 112);
    assert!(std::mem::size_of::<ProcessInformation>() == 24);
    assert!(std::mem::size_of::<BasicLimitInformation>() == 64);
    assert!(std::mem::size_of::<ExtendedLimitInformation>() == 144);
};

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: i32, info: *mut c_void, size: u32) -> Bool;
    fn QueryInformationJobObject(job: Handle, class: i32, info: *mut c_void, size: u32, returned: *mut u32) -> Bool;
    fn TerminateJobObject(job: Handle, exit_code: u32) -> Bool;
    fn InitializeProcThreadAttributeList(list: *mut c_void, count: u32, flags: u32, size: *mut usize) -> Bool;
    fn UpdateProcThreadAttribute(
        list: *mut c_void,
        flags: u32,
        attribute: usize,
        value: *mut c_void,
        size: usize,
        previous: *mut c_void,
        return_size: *mut usize,
    ) -> Bool;
    fn DeleteProcThreadAttributeList(list: *mut c_void);
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: *mut SecurityAttributes,
        disposition: u32,
        flags: u32,
        template: Handle,
    ) -> Handle;
    fn CreatePipe(read: *mut Handle, write: *mut Handle, security: *mut SecurityAttributes, size: u32) -> Bool;
    fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> Bool;
    fn ReadFile(file: Handle, buffer: *mut u8, size: u32, read: *mut u32, overlapped: *mut c_void) -> Bool;
    fn ResumeThread(thread: Handle) -> u32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(process: Handle, code: *mut u32) -> Bool;
    fn CloseHandle(handle: Handle) -> Bool;
    fn GetLastError() -> u32;
    fn CancelSynchronousIo(thread: Handle) -> Bool;
    fn GetCurrentProcess() -> Handle;
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
}

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> Bool;
    fn CreateRestrictedToken(
        token: Handle,
        flags: u32,
        disable_count: u32,
        disable: *mut SidAndAttributes,
        delete_count: u32,
        delete: *mut c_void,
        restrict_count: u32,
        restrict: *mut SidAndAttributes,
        restricted: *mut Handle,
    ) -> Bool;
    fn SetTokenInformation(token: Handle, class: i32, info: *mut c_void, length: u32) -> Bool;
    fn CreateWellKnownSid(kind: i32, domain: *mut c_void, sid: *mut c_void, size: *mut u32) -> Bool;
    fn GetLengthSid(sid: *mut c_void) -> u32;
    fn InitializeAcl(acl: *mut c_void, length: u32, revision: u32) -> Bool;
    fn AddMandatoryAce(acl: *mut c_void, revision: u32, flags: u32, policy: u32, sid: *mut c_void) -> Bool;
    fn AddAccessAllowedAceEx(acl: *mut c_void, revision: u32, flags: u32, mask: u32, sid: *mut c_void) -> Bool;
    fn GetAce(acl: *mut c_void, index: u32, ace: *mut *mut c_void) -> Bool;
    fn AddAce(acl: *mut c_void, revision: u32, start: u32, list: *mut c_void, length: u32) -> Bool;
    fn GetTokenInformation(token: Handle, class: i32, info: *mut c_void, length: u32, returned: *mut u32) -> Bool;
    fn GetSecurityDescriptorControl(descriptor: *mut c_void, control: *mut u16, revision: *mut u32) -> Bool;
    fn GetNamedSecurityInfoW(
        name: *const u16,
        kind: i32,
        info: u32,
        owner: *mut *mut c_void,
        group: *mut *mut c_void,
        dacl: *mut *mut c_void,
        sacl: *mut *mut c_void,
        descriptor: *mut *mut c_void,
    ) -> u32;
    fn SetNamedSecurityInfoW(
        name: *mut u16,
        kind: i32,
        info: u32,
        owner: *mut c_void,
        group: *mut c_void,
        dacl: *mut c_void,
        sacl: *mut c_void,
    ) -> u32;
    fn TreeResetNamedSecurityInfoW(
        name: *mut u16,
        kind: i32,
        info: u32,
        owner: *mut c_void,
        group: *mut c_void,
        dacl: *mut c_void,
        sacl: *mut c_void,
        keep_explicit: Bool,
        progress: *mut c_void,
        invoke: i32,
        args: *mut c_void,
    ) -> u32;
    fn CreateProcessAsUserW(
        token: Handle,
        application: *const u16,
        command_line: *mut u16,
        process_attributes: *mut c_void,
        thread_attributes: *mut c_void,
        inherit_handles: Bool,
        flags: u32,
        environment: *mut c_void,
        current_directory: *const u16,
        startup_info: *mut StartupInfoExW,
        process_information: *mut ProcessInformation,
    ) -> Bool;
}

/// A raw handle owned by exactly one value; closed when it drops.
struct Owned(Handle);
// SAFETY: a kernel handle is a process-wide value that may be used from any
// thread; ownership (and therefore closing) stays with exactly one `Owned`.
unsafe impl Send for Owned {}
// SAFETY: the operations performed through shared references (wait, read,
// terminate, resume) are thread-safe kernel calls on the same handle.
unsafe impl Sync for Owned {}
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.0) };
        }
    }
}

struct Worker {
    job: Owned,
    thread: Owned,
    writable: Vec<String>,
    // Paths granted to this worker's own capability, revoked when it exits.
    grants: Vec<String>,
    capability: container::Sid,
}

// Removes a worker's grants; whether every one was removed.
fn revoke(worker: &Worker) -> bool {
    let mut ok = true;
    for path in &worker.grants {
        ok &= container::set_access(path, &worker.capability, None).is_ok();
    }
    ok
}

type Out = Arc<Mutex<std::io::Stdout>>;

fn send(out: &Out, line: &str) {
    let mut stdout = out.lock().unwrap();
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn hex_decode(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    if bytes.len() % 2 != 0 || bytes.len() > 4 * MAX_COMMAND_LINE || !bytes.iter().all(u8::is_ascii_hexdigit) {
        return Err("bad hex field".into());
    }
    let digit = |b: u8| (b as char).to_digit(16).unwrap() as u8;
    let decoded: Vec<u8> = bytes.chunks(2).map(|p| digit(p[0]) << 4 | digit(p[1])).collect();
    String::from_utf8(decoded).map_err(|_| "field is not UTF-8".into())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Quotes one argument so CommandLineToArgvW / the MSVC runtime parse it back
/// exactly. No shell is involved; the string is never interpreted.
fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

fn last_error(what: &str) -> String {
    format!("{what} failed (Windows error {})", unsafe { GetLastError() })
}

fn inheritable() -> SecurityAttributes {
    SecurityAttributes {
        n_length: std::mem::size_of::<SecurityAttributes>() as u32,
        security_descriptor: null_mut(),
        inherit_handle: 1,
    }
}

/// An anonymous pipe: procd keeps the read end (not inheritable); the worker
/// gets the inheritable write end.
fn pipe() -> Result<(Owned, Owned), String> {
    let (mut read, mut write) = (null_mut(), null_mut());
    let mut sa = inheritable();
    if unsafe { CreatePipe(&mut read, &mut write, &mut sa, 0) } == 0 {
        return Err(last_error("CreatePipe"));
    }
    let (read, write) = (Owned(read), Owned(write));
    if unsafe { SetHandleInformation(read.0, HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(last_error("SetHandleInformation"));
    }
    Ok((read, write))
}

fn null_input() -> Result<Owned, String> {
    let name = wide("NUL");
    let mut sa = inheritable();
    let handle = unsafe { CreateFileW(name.as_ptr(), GENERIC_READ, 3, &mut sa, OPEN_EXISTING, 0, null_mut()) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(last_error("open NUL"));
    }
    Ok(Owned(handle))
}

fn environment(temp: Option<&str>) -> Vec<u16> {
    // A minimal, explicit environment: nothing from the service leaks
    // through. The worker's temporary folder is its own writable folder
    // (the user's is closed to the container), or none.
    let mut block = Vec::new();
    let mut add = |key: &str, value: &str| {
        block.extend(format!("{key}={value}").encode_utf16());
        block.push(0);
    };
    // Windows creates an AppContainer process only when the profile
    // locations are in its environment (it fails with error 203 without
    // them); they are paths the container cannot read anyway.
    for key in ["SystemRoot", "USERPROFILE", "LOCALAPPDATA"] {
        if let Ok(value) = std::env::var(key) {
            add(key, &value);
        }
    }
    if let Some(temp) = temp {
        add("TEMP", temp);
        add("TMP", temp);
    }
    block.push(0);
    block
}

fn well_known_sid(kind: i32) -> Result<Vec<u64>, String> {
    let mut buffer = vec![0u64; SECURITY_MAX_SID_SIZE.div_ceil(8)];
    let mut size = SECURITY_MAX_SID_SIZE as u32;
    if unsafe { CreateWellKnownSid(kind, null_mut(), buffer.as_mut_ptr() as *mut c_void, &mut size) } == 0 {
        return Err(last_error("CreateWellKnownSid"));
    }
    Ok(buffer)
}

// A restricted, low-integrity primary token derived from procd's own: every
// privilege removed (bar change-notify), Administrators deny-only, and the
// integrity level lowered to Low. Lowering one's own token needs no
// privilege, and CreateProcessAsUser accepts a restricted copy of the
// caller's token without SeAssignPrimaryToken.
fn sandbox_token() -> Result<Owned, String> {
    let mut own: Handle = null_mut();
    let access = TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT;
    if unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut own) } == 0 {
        return Err(last_error("OpenProcessToken"));
    }
    let own = Owned(own);
    let mut admins = well_known_sid(WIN_BUILTIN_ADMINISTRATORS_SID)?;
    let mut disable = [SidAndAttributes { sid: admins.as_mut_ptr() as *mut c_void, attributes: 0 }];
    let mut restricted: Handle = null_mut();
    if unsafe {
        CreateRestrictedToken(own.0, DISABLE_MAX_PRIVILEGE, 1, disable.as_mut_ptr(), 0, null_mut(), 0, null_mut(), &mut restricted)
    } == 0
    {
        return Err(last_error("CreateRestrictedToken"));
    }
    let restricted = Owned(restricted);
    let mut low = well_known_sid(WIN_LOW_LABEL_SID)?;
    let mut label = SidAndAttributes { sid: low.as_mut_ptr() as *mut c_void, attributes: SE_GROUP_INTEGRITY };
    let size = std::mem::size_of::<SidAndAttributes>() as u32 + unsafe { GetLengthSid(low.as_mut_ptr() as *mut c_void) };
    if unsafe { SetTokenInformation(restricted.0, TOKEN_INTEGRITY_LEVEL_CLASS, &mut label as *mut _ as *mut c_void, size) } == 0 {
        return Err(last_error("SetTokenInformation(integrity)"));
    }
    Ok(restricted)
}

// Grants the current user full control of a folder it owns, keeping every
// entry already there. Setting a label needs WRITE_OWNER, which an owner
// with only Modify (an unrestricted folder) lacks; an owner may always
// rewrite the DACL. A workspace the service opened already grants this.
fn grant_owner_full(dir: &str) -> Result<(), String> {
    unsafe {
        let mut own: Handle = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut own) == 0 {
            return Err(last_error("OpenProcessToken"));
        }
        let own = Owned(own);
        let mut needed = 0u32;
        GetTokenInformation(own.0, TOKEN_USER_CLASS, null_mut(), 0, &mut needed);
        let mut user = vec![0u64; (needed as usize).div_ceil(8)];
        if GetTokenInformation(own.0, TOKEN_USER_CLASS, user.as_mut_ptr() as *mut c_void, needed, &mut needed) == 0 {
            return Err(last_error("GetTokenInformation"));
        }
        let user_sid = (*(user.as_ptr() as *const SidAndAttributes)).sid;
        let name = wide(dir);
        let mut old: *mut c_void = null_mut();
        let mut descriptor: *mut c_void = null_mut();
        let code = GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old,
            null_mut(),
            &mut descriptor,
        );
        if code != 0 {
            return Err(format!("read access of {dir}: Windows error {code}"));
        }
        let result = (|| {
            let old_size = if old.is_null() { 8 } else { *((old as *const u8).add(2) as *const u16) as usize };
            let count = if old.is_null() { 0 } else { *((old as *const u8).add(4) as *const u16) as u32 };
            let needed = old_size + 8 + GetLengthSid(user_sid) as usize;
            if needed > 65_532 {
                return Err("the folder's access list is too large".into());
            }
            let mut acl = vec![0u64; needed.div_ceil(8)];
            let acl_ptr = acl.as_mut_ptr() as *mut c_void;
            if InitializeAcl(acl_ptr, ((acl.len() * 8) as u32).min(65_532), ACL_REVISION) == 0 {
                return Err(last_error("InitializeAcl"));
            }
            // Explicit denies keep their place first (canonical order), then
            // the user's grant, then every other entry in order.
            let entry = |i: u32| -> Result<(*mut c_void, u8, u8, u32), String> {
                let mut ace: *mut c_void = null_mut();
                if GetAce(old, i, &mut ace) == 0 {
                    return Err(last_error("GetAce"));
                }
                let bytes = ace as *const u8;
                Ok((ace, *bytes, *bytes.add(1), *(bytes.add(2) as *const u16) as u32))
            };
            let explicit_deny = |kind: u8, flags: u8| kind == 1 && flags & 0x10 == 0;
            for i in 0..count {
                let (ace, kind, flags, size) = entry(i)?;
                if explicit_deny(kind, flags) && AddAce(acl_ptr, ACL_REVISION, u32::MAX, ace, size) == 0 {
                    return Err(last_error("AddAce"));
                }
            }
            if AddAccessAllowedAceEx(
                acl_ptr,
                ACL_REVISION,
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                FILE_ALL_ACCESS,
                user_sid,
            ) == 0
            {
                return Err(last_error("AddAccessAllowedAceEx"));
            }
            for i in 0..count {
                let (ace, kind, flags, size) = entry(i)?;
                if !explicit_deny(kind, flags) && AddAce(acl_ptr, ACL_REVISION, u32::MAX, ace, size) == 0 {
                    return Err(last_error("AddAce"));
                }
            }
            let mut name = wide(dir);
            let code = SetNamedSecurityInfoW(
                name.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl_ptr,
                null_mut(),
            );
            if code != 0 {
                return Err(format!("grant {dir}: Windows error {code}"));
            }
            Ok(())
        })();
        LocalFree(descriptor);
        result
    }
}

// Sets a folder's mandatory label: Low (a low-integrity worker may write
// there, inherited by what it creates) or none (back to the default,
// Medium). Lowering a label on one's own folder needs no privilege.
fn set_label(dir: &str, low: bool) -> Result<(), String> {
    match apply_label(dir, low) {
        Err(code) if code == ERROR_ACCESS_DENIED => {
            grant_owner_full(dir)?;
            apply_label(dir, low).map_err(|code| format!("label {dir}: Windows error {code}"))
        }
        other => other.map_err(|code| format!("label {dir}: Windows error {code}")),
    }
}

fn apply_label(dir: &str, low: bool) -> Result<(), u32> {
    let mut acl = vec![0u64; 32];
    let acl_ptr = acl.as_mut_ptr() as *mut c_void;
    if unsafe { InitializeAcl(acl_ptr, (acl.len() * 8) as u32, ACL_REVISION) } == 0 {
        return Err(unsafe { GetLastError() });
    }
    if low {
        let mut sid = well_known_sid(WIN_LOW_LABEL_SID).map_err(|_| unsafe { GetLastError() })?;
        if unsafe {
            AddMandatoryAce(
                acl_ptr,
                ACL_REVISION,
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
                sid.as_mut_ptr() as *mut c_void,
            )
        } == 0
        {
            return Err(unsafe { GetLastError() });
        }
    }
    let mut name = wide(dir);
    let code = unsafe {
        SetNamedSecurityInfoW(name.as_mut_ptr(), SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, null_mut(), null_mut(), null_mut(), acl_ptr)
    };
    if code != 0 {
        return Err(code);
    }
    Ok(())
}

// Folders labelled Low for live workers, by case-folded path: the original
// spelling and how many live workers hold it. A folder keeps its label until
// the last of them exits, and every one is restored when procd shuts down.
fn labels() -> &'static Mutex<HashMap<String, (String, usize)>> {
    static LABELS: std::sync::OnceLock<Mutex<HashMap<String, (String, usize)>>> = std::sync::OnceLock::new();
    LABELS.get_or_init(Default::default)
}

// One key per folder however it is spelled (case, trailing separators).
fn label_key(dir: &str) -> String {
    dir.trim_end_matches(['\\', '/']).to_lowercase()
}

// Back to plain inheritance from the parent for the folder and everything
// below it: any access entry the worker added (it may change its own
// folder's DACL) is removed, as is the owner grant labelling may have added.
fn reset_access(dir: &str) -> bool {
    let mut empty = vec![0u64; 2];
    if unsafe { InitializeAcl(empty.as_mut_ptr() as *mut c_void, 16, ACL_REVISION) } == 0 {
        return false;
    }
    let mut name = wide(dir);
    let code = unsafe {
        TreeResetNamedSecurityInfoW(
            name.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            empty.as_mut_ptr() as *mut c_void,
            null_mut(),
            0,
            null_mut(),
            PROGRESS_INVOKE_NEVER,
            null_mut(),
        )
    };
    code == 0
}

// Restores a folder after its last worker: the default label first (that
// needs WRITE_OWNER, which the access reset may remove), then its access.
// Whether every object below `dir` can be read and holds only inherited
// access entries in an unprotected DACL. The tree reset can report success
// without reaching an object it was denied, so its result is checked.
fn inherits_only(path: &std::path::Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut dacl: *mut c_void = null_mut();
    let mut descriptor: *mut c_void = null_mut();
    let code = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if code != 0 {
        return false;
    }
    let ok = unsafe {
        let mut control = 0u16;
        let mut revision = 0u32;
        GetSecurityDescriptorControl(descriptor, &mut control, &mut revision);
        let unprotected = control & 0x1000 == 0;
        let count = if dacl.is_null() { 0 } else { *((dacl as *const u8).add(4) as *const u16) as u32 };
        let inherited = (0..count).all(|i| {
            let mut ace: *mut c_void = null_mut();
            GetAce(dacl, i, &mut ace) != 0 && *(ace as *const u8).add(1) & 0x10 != 0
        });
        !dacl.is_null() && unprotected && inherited
    };
    unsafe { LocalFree(descriptor) };
    ok
}

fn tree_inherits_only(dir: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    for entry in entries {
        let Ok(entry) = entry else { return false };
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { return false };
        if !inherits_only(&path) {
            return false;
        }
        if meta.is_dir() && !meta.file_type().is_symlink() && !tree_inherits_only(&path) {
            return false;
        }
    }
    true
}

// Whether the folder is back to its default label and inherited access. A
// folder that is now a link or junction is left alone (both calls would
// follow it) and reported as not restored.
fn restore_folder(dir: &str) -> bool {
    use std::os::windows::fs::MetadataExt;
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 => {}
        _ => return false,
    }
    let labelled = set_label(dir, false).is_ok();
    let reset = reset_access(dir);
    let path = std::path::Path::new(dir);
    labelled && reset && inherits_only(path) && tree_inherits_only(path)
}

fn hold_label(dir: &str) -> Result<(), String> {
    let mut held = labels().lock().unwrap();
    let key = label_key(dir);
    if let Some(entry) = held.get_mut(&key) {
        entry.1 += 1;
        return Ok(());
    }
    set_label(dir, true)?;
    held.insert(key, (dir.to_string(), 1));
    Ok(())
}

// Whether the folder was restored (true while another worker still holds it).
fn release_label(dir: &str) -> bool {
    let mut held = labels().lock().unwrap();
    let key = label_key(dir);
    let last = match held.get_mut(&key) {
        Some(entry) => {
            entry.1 -= 1;
            entry.1 == 0
        }
        None => false,
    };
    if last {
        held.remove(&key);
        return restore_folder(dir);
    }
    true
}

fn release_all_labels() {
    let mut held = labels().lock().unwrap();
    for (_, (dir, _)) in held.drain() {
        let _ = restore_folder(&dir);
    }
}

// A readable path must be an existing, absolute file or folder that is not
// a link or junction (a grant would reach its target instead).
fn readable_path(path: &str) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    if !std::path::Path::new(path).is_absolute() {
        return Err("readable paths must be absolute".into());
    }
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 => Ok(()),
        _ => Err("a readable path is missing or is a link".into()),
    }
}

// A name no other worker of this or any later procd will repeat.
fn unique() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}.{}.{}", std::process::id(), nanos, NEXT.fetch_add(1, Ordering::Relaxed))
}

// A writable folder must be an existing, absolute, real directory (not a
// link or junction, which would label its target instead).
fn writable_dir(dir: &str) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    if !std::path::Path::new(dir).is_absolute() {
        return Err("writable folders must be absolute".into());
    }
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() && meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 => Ok(()),
        _ => Err("a writable folder is missing or is a link".into()),
    }
}

struct Spawned {
    worker: Worker,
    process: Owned,
    pid: u32,
    stdout: Owned,
    stderr: Owned,
}

fn spawn(id: &str, fields: &[&str], allow: &[String]) -> Result<Spawned, String> {
    if fields.len() < 5 {
        return Err("SPAWN needs exe, cwd, memory, writable folders and argc".into());
    }
    let exe = hex_decode(fields[0])?;
    let cwd = hex_decode(fields[1])?;
    let memory: usize = fields[2].parse().map_err(|_| "bad memory limit")?;
    let count: usize = fields[3].parse().map_err(|_| "bad writable count")?;
    if count > MAX_WRITABLE || fields.len() < 5 + count {
        return Err("writable folder count mismatch".into());
    }
    let writable = fields[4..4 + count].iter().map(|f| hex_decode(f)).collect::<Result<Vec<_>, _>>()?;
    let fields = &fields[4 + count..];
    if fields.is_empty() {
        return Err("SPAWN needs a readable count".into());
    }
    let readable_count: usize = fields[0].parse().map_err(|_| "bad readable count")?;
    if readable_count > MAX_READABLE || fields.len() < 1 + readable_count {
        return Err("readable path count mismatch".into());
    }
    let readable = fields[1..1 + readable_count].iter().map(|f| hex_decode(f)).collect::<Result<Vec<_>, _>>()?;
    let fields = &fields[1 + readable_count..];
    if fields.is_empty() {
        return Err("SPAWN needs argc".into());
    }
    let argc: usize = fields[0].parse().map_err(|_| "bad argc")?;
    if argc > 4096 || fields.len() != 1 + argc {
        return Err("argument count mismatch".into());
    }
    for dir in &writable {
        writable_dir(dir)?;
    }
    for path in &readable {
        readable_path(path)?;
    }
    if !allow.iter().any(|a| a.eq_ignore_ascii_case(&exe)) {
        return Err("executable is not on the allowlist".into());
    }
    // The worker runs the container's copy of the allowlisted executable.
    let exe = container::staged_tool(&exe)?;
    let mut line = quote(&exe);
    for field in &fields[1..] {
        line.push(' ');
        line.push_str(&quote(&hex_decode(field)?));
    }
    if line.encode_utf16().count() > MAX_COMMAND_LINE {
        return Err("command line too long".into());
    }

    let token = sandbox_token()?;
    // This worker's own capability: what is granted to it no other worker
    // (or later process) can use.
    let capability = container::capability_sid(&format!("yamakan.worker.{id}.{}", unique()))?;
    let mut grants: Vec<String> = Vec::new();
    let grant = |path: &str, flags: u32, mask: u32, grants: &mut Vec<String>| -> Result<(), String> {
        container::set_access(path, &capability, Some((flags, mask))).map_err(|e| format!("grant {path}: {e}"))?;
        grants.push(path.to_string());
        Ok(())
    };
    let granted = (|| -> Result<(), String> {
        for path in &readable {
            grant(path, 0, container::FILE_GENERIC_READ, &mut grants)?;
            // A folder's grant reaches only its existing files when each is
            // granted too (grants do not re-propagate through a tree).
            if std::path::Path::new(path).is_dir() {
                let entries = std::fs::read_dir(path).map_err(|e| format!("list {path}: {e}"))?;
                for entry in entries.flatten() {
                    let child = entry.path().to_string_lossy().to_string();
                    readable_path(&child)?;
                    if entry.path().is_file() {
                        grant(&child, 0, container::FILE_GENERIC_READ, &mut grants)?;
                    }
                }
            }
        }
        for dir in &writable {
            grant(dir, container::INHERIT, container::FILE_MODIFY, &mut grants)?;
        }
        let named = |p: &str| readable.iter().chain(writable.iter()).any(|x| x.eq_ignore_ascii_case(p));
        if !named(&cwd) {
            grant(&cwd, 0, container::FILE_TRAVERSE_ONLY, &mut grants)?;
        }
        Ok(())
    })();
    let unwind = |grants: &[String]| {
        for path in grants {
            let _ = container::set_access(path, &capability, None);
        }
    };
    if let Err(e) = granted {
        unwind(&grants);
        return Err(e);
    }
    for (i, dir) in writable.iter().enumerate() {
        if let Err(e) = hold_label(dir) {
            for done in &writable[..i] {
                let _ = release_label(done);
            }
            unwind(&grants);
            return Err(e);
        }
    }
    let restore = |writable: &[String]| {
        for dir in writable {
            let _ = release_label(dir);
        }
    };
    let result = launch(&exe, &cwd, &line, memory, &token, &capability, writable.first().map(String::as_str));
    match result {
        Ok((job, process)) => {
            if std::env::var("YAMAKAN_PROCD_FAULT").as_deref() == Ok("after-create") {
                // Test seam: the launcher dies with a suspended worker in its job.
                std::process::abort();
            }
            Ok(Spawned {
                worker: Worker { job, thread: Owned(process.0.thread), writable, grants, capability },
                process: Owned(process.0.process),
                pid: process.0.process_id,
                stdout: process.1,
                stderr: process.2,
            })
        }
        Err(e) => {
            restore(&writable);
            unwind(&grants);
            Err(e)
        }
    }
}

type Launched = (ProcessInformation, Owned, Owned);

fn launch(
    exe: &str,
    cwd: &str,
    line: &str,
    memory: usize,
    token: &Owned,
    capability: &container::Sid,
    temp: Option<&str>,
) -> Result<(Owned, Launched), String> {
    unsafe {
        let job = Owned(CreateJobObjectW(null_mut(), std::ptr::null()));
        if job.0.is_null() {
            return Err(last_error("CreateJobObject"));
        }
        let mut limits = ExtendedLimitInformation::default();
        // One process only: media workers never start children.
        limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.basic.active_process_limit = 1;
        if memory > 0 {
            limits.basic.limit_flags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
            limits.job_memory_limit = memory;
        }
        if SetInformationJobObject(
            job.0,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            &mut limits as *mut _ as *mut c_void,
            std::mem::size_of::<ExtendedLimitInformation>() as u32,
        ) == 0
        {
            return Err(last_error("SetInformationJobObject"));
        }

        let stdin = null_input()?;
        let (stdout_read, stdout_write) = pipe()?;
        let (stderr_read, stderr_write) = pipe()?;
        // Only these three handles may be inherited, and only by this worker.
        let mut inherited = [stdin.0, stdout_write.0, stderr_write.0];
        let mut jobs = [job.0];

        // The worker's AppContainer and its one enabled capability.
        let mut capabilities = [SidAndAttributes { sid: capability.as_ptr(), attributes: container::SE_GROUP_ENABLED }];
        let mut security = container::SecurityCapabilities {
            app_container_sid: container::container_sid()?.as_ptr(),
            capabilities: capabilities.as_mut_ptr(),
            capability_count: 1,
            reserved: 0,
        };
        let mut size = 0usize;
        InitializeProcThreadAttributeList(null_mut(), 4, 0, &mut size);
        let mut storage = vec![0u8; size];
        let list = storage.as_mut_ptr() as *mut c_void;
        if InitializeProcThreadAttributeList(list, 4, 0, &mut size) == 0 {
            return Err(last_error("InitializeProcThreadAttributeList"));
        }
        let result = (|| {
            if UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                inherited.as_mut_ptr() as *mut c_void,
                std::mem::size_of_val(&inherited),
                null_mut(),
                null_mut(),
            ) == 0
            {
                return Err(last_error("handle list"));
            }
            // Atomic job assignment at creation: fail closed if unsupported.
            if UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST,
                jobs.as_mut_ptr() as *mut c_void,
                std::mem::size_of_val(&jobs),
                null_mut(),
                null_mut(),
            ) == 0
            {
                return Err(last_error("job list"));
            }
            // Fail closed: a worker is never started outside its container.
            if UpdateProcThreadAttribute(
                list,
                0,
                container::PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                &mut security as *mut _ as *mut c_void,
                std::mem::size_of::<container::SecurityCapabilities>(),
                null_mut(),
                null_mut(),
            ) == 0
            {
                return Err(last_error("AppContainer"));
            }
            // A less-privileged AppContainer: grants made to ALL APPLICATION
            // PACKAGES (much of the user's registry, for one) do not apply;
            // only grants to this container or its capability do.
            let mut opt_out: u32 = container::ALL_APPLICATION_PACKAGES_OPT_OUT;
            if UpdateProcThreadAttribute(
                list,
                0,
                container::PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
                &mut opt_out as *mut _ as *mut c_void,
                std::mem::size_of::<u32>(),
                null_mut(),
                null_mut(),
            ) == 0
            {
                return Err(last_error("less-privileged AppContainer"));
            }
            let mut info: StartupInfoExW = std::mem::zeroed();
            info.startup_info.cb = std::mem::size_of::<StartupInfoExW>() as u32;
            info.startup_info.flags = STARTF_USESTDHANDLES;
            info.startup_info.std_input = stdin.0;
            info.startup_info.std_output = stdout_write.0;
            info.startup_info.std_error = stderr_write.0;
            info.attribute_list = list;
            let mut process: ProcessInformation = std::mem::zeroed();
            let exe_w = wide(exe);
            let cwd_w = wide(cwd);
            let mut command = wide(line);
            let mut env = environment(temp);
            if CreateProcessAsUserW(
                token.0,
                exe_w.as_ptr(),
                command.as_mut_ptr(),
                null_mut(),
                null_mut(),
                1,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
                env.as_mut_ptr() as *mut c_void,
                cwd_w.as_ptr(),
                &mut info,
                &mut process,
            ) == 0
            {
                return Err(last_error("CreateProcess"));
            }
            Ok(process)
        })();
        DeleteProcThreadAttributeList(list);
        let process = result?;
        // procd's copies of the write ends close here, so readers see EOF
        // once the worker (the only other holder) exits.
        drop((stdin, stdout_write, stderr_write));
        Ok((job, (process, stdout_read, stderr_read)))
    }
}

/// Relays one output pipe to the service until the worker closes it.
fn relay(out: Out, id: String, kind: &'static str, pipe: Owned) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let pipe = pipe; // move the owned handle, not its raw field
        let mut buffer = vec![0u8; RELAY_CHUNK];
        loop {
            let mut read = 0u32;
            let ok = unsafe { ReadFile(pipe.0, buffer.as_mut_ptr(), buffer.len() as u32, &mut read, null_mut()) };
            if ok == 0 || read == 0 {
                break;
            }
            send(&out, &format!("{kind}\t{id}\t{}", hex_encode(&buffer[..read as usize])));
        }
    })
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn main() {
    let allow: Vec<String> = std::env::args().skip(1).collect();
    let out: Out = Arc::new(Mutex::new(std::io::stdout()));
    let workers: Arc<Mutex<HashMap<String, Worker>>> = Arc::new(Mutex::new(HashMap::new()));
    send(&out, "READY");
    let mut input = BufReader::new(std::io::stdin().lock());
    let mut raw = Vec::new();
    loop {
        raw.clear();
        // Bounded request lines; an oversized line is a protocol violation.
        match (&mut input).take(MAX_REQUEST_LINE as u64 + 1).read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => break,
            Ok(_) if raw.last() != Some(&b'\n') && raw.len() > MAX_REQUEST_LINE => break,
            Ok(_) => {}
        }
        let Ok(line) = std::str::from_utf8(&raw) else { break };
        let line = line.trim_end_matches(['\r', '\n']);
        let parts: Vec<&str> = line.split('\t').collect();
        let (command, id) = (parts[0], parts.get(1).copied().unwrap_or(""));
        if !valid_id(id) {
            send(&out, &format!("ERROR\t-\t{}", hex_encode(b"invalid request id")));
            continue;
        }
        match command {
            "SPAWN" => {
                {
                    let live = workers.lock().unwrap();
                    if live.contains_key(id) || live.len() >= MAX_LIVE_WORKERS {
                        send(&out, &format!("ERROR\t{id}\t{}", hex_encode(b"duplicate id or too many workers")));
                        continue;
                    }
                }
                match spawn(id, &parts[2..], &allow) {
                    Ok(spawned) => {
                        workers.lock().unwrap().insert(id.to_string(), spawned.worker);
                        send(&out, &format!("CREATED\t{id}\t{}", spawned.pid));
                        let readers = [
                            relay(Arc::clone(&out), id.to_string(), "OUT", spawned.stdout),
                            relay(Arc::clone(&out), id.to_string(), "ERR", spawned.stderr),
                        ];
                        let (out, workers, id, process) =
                            (Arc::clone(&out), Arc::clone(&workers), id.to_string(), spawned.process);
                        std::thread::spawn(move || {
                            let process = process; // move the owned handle
                            let mut code = 0u32;
                            unsafe {
                                WaitForSingleObject(process.0, INFINITE);
                                GetExitCodeProcess(process.0, &mut code);
                            }
                            // Output is relayed before the exit is reported. A write
                            // end smuggled outside the job could hold a pipe open
                            // forever, so readers get a bounded grace period and are
                            // then cancelled.
                            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                            while readers.iter().any(|r| !r.is_finished()) && std::time::Instant::now() < deadline {
                                std::thread::sleep(std::time::Duration::from_millis(10));
                            }
                            for reader in readers {
                                if !reader.is_finished() {
                                    use std::os::windows::io::AsRawHandle;
                                    unsafe { CancelSynchronousIo(reader.as_raw_handle() as Handle) };
                                }
                                let _ = reader.join();
                            }
                            // Dropping the worker closes its job; its folders
                            // return to the default label.
                            let worker = workers.lock().unwrap().remove(&id);
                            let mut restored = true;
                            // The job's peak committed memory, read before the
                            // job closes (0 if the query fails).
                            let mut peak = 0usize;
                            if let Some(worker) = &worker {
                                let mut info = ExtendedLimitInformation::default();
                                // SAFETY: the job handle is owned by `worker`, which is
                                // still alive; `info` is a writable repr(C) buffer of
                                // exactly the size passed (asserted at 144 bytes), and
                                // the returned-length pointer may be null.
                                let ok = unsafe {
                                    QueryInformationJobObject(
                                        worker.job.0,
                                        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                                        &mut info as *mut _ as *mut c_void,
                                        std::mem::size_of::<ExtendedLimitInformation>() as u32,
                                        std::ptr::null_mut(),
                                    )
                                };
                                if ok != 0 {
                                    peak = info.peak_job_memory_used;
                                }
                            }
                            if let Some(worker) = worker {
                                // The job closes first, so nothing in it can use a
                                // grant while the grants are removed.
                                let Worker { job, thread, writable: folders, grants, capability } = worker;
                                drop((job, thread));
                                for path in &grants {
                                    restored &= container::set_access(path, &capability, None).is_ok();
                                }
                                for dir in &folders {
                                    restored &= release_label(dir);
                                }
                            }
                            send(&out, &format!("EXITED\t{id}\t{code}\t{}\t{peak}", u8::from(restored)));
                        });
                    }
                    Err(message) => send(&out, &format!("ERROR\t{id}\t{}", hex_encode(message.as_bytes()))),
                }
            }
            "RESUME" => match workers.lock().unwrap().get(id) {
                Some(worker) if unsafe { ResumeThread(worker.thread.0) } != u32::MAX => {
                    send(&out, &format!("RESUMED\t{id}"))
                }
                _ => send(&out, &format!("ERROR\t{id}\t{}", hex_encode(b"cannot resume"))),
            },
            "KILL" => {
                if let Some(worker) = workers.lock().unwrap().get(id) {
                    unsafe { TerminateJobObject(worker.job.0, 1) };
                }
            }
            _ => send(&out, &format!("ERROR\t{id}\t{}", hex_encode(b"unknown command"))),
        }
    }
    // The service is gone (or broke the protocol): end every job, restore
    // every folder's label, then exit. (After a crash of procd itself the
    // service clears labels across the workspace when it next starts.)
    for worker in workers.lock().unwrap().values() {
        unsafe { TerminateJobObject(worker.job.0, 1) };
        let _ = revoke(worker);
    }
    release_all_labels();
    std::process::exit(0);
}
