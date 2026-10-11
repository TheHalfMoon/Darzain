//! yamakan-procd — owns every media worker the Yamakan service launches.
//!
//! The service starts one procd and speaks a line protocol over its stdin and
//! stdout. Each worker is created suspended and already inside its own Job
//! Object (PROC_THREAD_ATTRIBUTE_JOB_LIST), so there is no moment at which it
//! exists outside ownership. Jobs are KILL_ON_JOB_CLOSE without breakaway, and
//! only procd holds their handles. Therefore:
//!   * procd dies (any cause)     -> the OS closes the job handles -> workers die;
//!   * the service dies           -> procd's stdin closes -> procd terminates
//!                                   every job and exits;
//!   * a worker is never resumed before the service has recorded its identity.
//!
//! Protocol (tab-separated; strings are hex-encoded UTF-8):
//!   SPAWN id exe cwd stdoutPipe stderrPipe jobMemoryBytes argc arg...
//!       -> CREATED id pid       (suspended, inside its job)
//!   RESUME id                   -> RESUMED id
//!   KILL id                     -> (EXITED follows)
//!   (any)                       -> EXITED id exitCode   when the process ends
//!   errors                      -> ERROR id hexMessage
//! Executables must be on the allowlist given as arguments at startup, and
//! output pipes must be \\.\pipe\yamakan-* names created by the service.

use std::collections::HashMap;
use std::ffi::c_void;
use std::io::{BufRead, Write};
use std::ptr::null_mut;
use std::sync::{Arc, Mutex};

type Handle = *mut c_void;
type Bool = i32;

const CREATE_SUSPENDED: u32 = 0x0000_0004;
const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;
const PROC_THREAD_ATTRIBUTE_JOB_LIST: usize = 0x0002_000D;
const JOB_OBJECT_LIMIT_JOB_MEMORY: u32 = 0x0000_0200;
const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION: u32 = 0x0000_0400;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const OPEN_EXISTING: u32 = 3;
const INFINITE: u32 = 0xFFFF_FFFF;
const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
const MAX_COMMAND_LINE: usize = 32_766;

#[repr(C)]
struct SecurityAttributes {
    n_length: u32,
    security_descriptor: *mut c_void,
    inherit_handle: Bool,
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

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: i32, info: *mut c_void, size: u32) -> Bool;
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
    fn CreateProcessW(
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
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: *mut SecurityAttributes,
        disposition: u32,
        flags: u32,
        template: Handle,
    ) -> Handle;
    fn ResumeThread(thread: Handle) -> u32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(process: Handle, code: *mut u32) -> Bool;
    fn CloseHandle(handle: Handle) -> Bool;
    fn GetLastError() -> u32;
}

/// A raw handle owned by exactly one Worker; closed when the Worker drops.
struct Owned(Handle);
unsafe impl Send for Owned {}
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
    process: Arc<Owned>,
    thread: Owned,
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
    if text.len() % 2 != 0 || text.len() > 4 * MAX_COMMAND_LINE {
        return Err("bad hex field".into());
    }
    let bytes: Result<Vec<u8>, _> = (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16))
        .collect();
    String::from_utf8(bytes.map_err(|_| "bad hex field")?).map_err(|_| "field is not UTF-8".into())
}

fn hex_encode(text: &str) -> String {
    text.bytes().map(|b| format!("{b:02x}")).collect()
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

fn open(path: &str, access: u32) -> Result<Owned, String> {
    let name = wide(path);
    let mut sa = inheritable();
    let handle = unsafe { CreateFileW(name.as_ptr(), access, 3, &mut sa, OPEN_EXISTING, 0, null_mut()) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(last_error("open"));
    }
    Ok(Owned(handle))
}

fn environment() -> Vec<u16> {
    // A minimal, explicit environment: nothing from the service leaks through.
    let mut block = Vec::new();
    for key in ["SystemRoot", "TEMP", "TMP"] {
        if let Ok(value) = std::env::var(key) {
            block.extend(format!("{key}={value}").encode_utf16());
            block.push(0);
        }
    }
    block.push(0);
    block
}

fn spawn(fields: &[&str], allow: &[String]) -> Result<(Worker, u32), String> {
    if fields.len() < 7 {
        return Err("SPAWN needs exe, cwd, stdout, stderr, memory and argc".into());
    }
    let exe = hex_decode(fields[0])?;
    let cwd = hex_decode(fields[1])?;
    let stdout_pipe = hex_decode(fields[2])?;
    let stderr_pipe = hex_decode(fields[3])?;
    let memory: usize = fields[4].parse().map_err(|_| "bad memory limit")?;
    let argc: usize = fields[5].parse().map_err(|_| "bad argc")?;
    if fields.len() != 6 + argc || argc > 4096 {
        return Err("argument count mismatch".into());
    }
    if !allow.iter().any(|a| a.eq_ignore_ascii_case(&exe)) {
        return Err("executable is not on the allowlist".into());
    }
    for pipe in [&stdout_pipe, &stderr_pipe] {
        if !pipe.starts_with(r"\\.\pipe\yamakan-") || pipe.len() > 200 {
            return Err("output must be a Yamakan pipe".into());
        }
    }
    let mut line = quote(&exe);
    for field in &fields[6..] {
        line.push(' ');
        line.push_str(&quote(&hex_decode(field)?));
    }
    if line.encode_utf16().count() > MAX_COMMAND_LINE {
        return Err("command line too long".into());
    }

    unsafe {
        let job = Owned(CreateJobObjectW(null_mut(), std::ptr::null()));
        if job.0.is_null() {
            return Err(last_error("CreateJobObject"));
        }
        let mut limits = ExtendedLimitInformation::default();
        limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
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

        let stdin = open("NUL", GENERIC_READ)?;
        let stdout = open(&stdout_pipe, GENERIC_WRITE)?;
        let stderr = open(&stderr_pipe, GENERIC_WRITE)?;
        // Only these three handles may be inherited, and only by this worker.
        let mut inherited = [stdin.0, stdout.0, stderr.0];
        let mut jobs = [job.0];

        let mut size = 0usize;
        InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size);
        let mut storage = vec![0u8; size];
        let list = storage.as_mut_ptr() as *mut c_void;
        if InitializeProcThreadAttributeList(list, 2, 0, &mut size) == 0 {
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
            let mut info: StartupInfoExW = std::mem::zeroed();
            info.startup_info.cb = std::mem::size_of::<StartupInfoExW>() as u32;
            info.startup_info.flags = STARTF_USESTDHANDLES;
            info.startup_info.std_input = stdin.0;
            info.startup_info.std_output = stdout.0;
            info.startup_info.std_error = stderr.0;
            info.attribute_list = list;
            let mut process: ProcessInformation = std::mem::zeroed();
            let exe_w = wide(&exe);
            let cwd_w = wide(&cwd);
            let mut command = wide(&line);
            let mut env = environment();
            if CreateProcessW(
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
        if std::env::var("YAMAKAN_PROCD_FAULT").as_deref() == Ok("after-create") {
            // Test seam: the launcher dies with a suspended worker in its job.
            std::process::abort();
        }
        Ok((
            Worker { job, process: Arc::new(Owned(process.process)), thread: Owned(process.thread) },
            process.process_id,
        ))
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn main() {
    let allow: Vec<String> = std::env::args().skip(1).collect();
    let out: Out = Arc::new(Mutex::new(std::io::stdout()));
    let workers: Arc<Mutex<HashMap<String, Worker>>> = Arc::new(Mutex::new(HashMap::new()));
    send(&out, "READY");
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let parts: Vec<&str> = line.split('\t').collect();
        let (command, id) = (parts[0], parts.get(1).copied().unwrap_or(""));
        if !valid_id(id) {
            send(&out, &format!("ERROR\t-\t{}", hex_encode("invalid request id")));
            continue;
        }
        match command {
            "SPAWN" => {
                if workers.lock().unwrap().contains_key(id) {
                    send(&out, &format!("ERROR\t{id}\t{}", hex_encode("duplicate id")));
                    continue;
                }
                match spawn(&parts[2..], &allow) {
                    Ok((worker, pid)) => {
                        let process = Arc::clone(&worker.process);
                        workers.lock().unwrap().insert(id.to_string(), worker);
                        send(&out, &format!("CREATED\t{id}\t{pid}"));
                        let (out, workers, id) = (Arc::clone(&out), Arc::clone(&workers), id.to_string());
                        std::thread::spawn(move || {
                            let mut code = 0u32;
                            unsafe {
                                WaitForSingleObject(process.0, INFINITE);
                                GetExitCodeProcess(process.0, &mut code);
                            }
                            // Dropping the worker closes its job: any descendant dies too.
                            workers.lock().unwrap().remove(&id);
                            send(&out, &format!("EXITED\t{id}\t{code}"));
                        });
                    }
                    Err(message) => send(&out, &format!("ERROR\t{id}\t{}", hex_encode(&message))),
                }
            }
            "RESUME" => match workers.lock().unwrap().get(id) {
                Some(worker) if unsafe { ResumeThread(worker.thread.0) } != u32::MAX => {
                    send(&out, &format!("RESUMED\t{id}"))
                }
                _ => send(&out, &format!("ERROR\t{id}\t{}", hex_encode("cannot resume"))),
            },
            "KILL" => {
                if let Some(worker) = workers.lock().unwrap().get(id) {
                    unsafe { TerminateJobObject(worker.job.0, 1) };
                }
            }
            _ => send(&out, &format!("ERROR\t{id}\t{}", hex_encode("unknown command"))),
        }
    }
    // The service is gone: end every job before exiting.
    for worker in workers.lock().unwrap().values() {
        unsafe { TerminateJobObject(worker.job.0, 1) };
    }
}
