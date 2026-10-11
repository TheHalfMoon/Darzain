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
//!   * a worker is never resumed before the service has recorded its identity.
//! Worker output travels through anonymous pipes that only procd can read and
//! is relayed to the service; no named object is ever opened.
//!
//! Protocol (tab-separated; strings and data are hex-encoded):
//!   SPAWN id exe cwd jobMemoryBytes argc arg...
//!       -> CREATED id pid       (suspended, inside its job)
//!   RESUME id                   -> RESUMED id
//!   KILL id                     -> (EXITED follows)
//!   (worker output)             -> OUT id hexChunk | ERR id hexChunk
//!   (process end, after output) -> EXITED id exitCode
//!   errors                      -> ERROR id hexMessage
//! Executables must be on the allowlist given as arguments at startup.

use std::collections::HashMap;
use std::ffi::c_void;
use std::io::{BufRead, BufReader, Read, Write};
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

// x64 layouts, checked against the Windows SDK definitions.
#[cfg(target_pointer_width = "64")]
const _: () = {
    assert!(std::mem::size_of::<SecurityAttributes>() == 24);
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
    fn CreatePipe(read: *mut Handle, write: *mut Handle, security: *mut SecurityAttributes, size: u32) -> Bool;
    fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> Bool;
    fn ReadFile(file: Handle, buffer: *mut u8, size: u32, read: *mut u32, overlapped: *mut c_void) -> Bool;
    fn ResumeThread(thread: Handle) -> u32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(process: Handle, code: *mut u32) -> Bool;
    fn CloseHandle(handle: Handle) -> Bool;
    fn GetLastError() -> u32;
    fn CancelSynchronousIo(thread: Handle) -> Bool;
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

struct Spawned {
    worker: Worker,
    process: Owned,
    pid: u32,
    stdout: Owned,
    stderr: Owned,
}

fn spawn(fields: &[&str], allow: &[String]) -> Result<Spawned, String> {
    if fields.len() < 4 {
        return Err("SPAWN needs exe, cwd, memory and argc".into());
    }
    let exe = hex_decode(fields[0])?;
    let cwd = hex_decode(fields[1])?;
    let memory: usize = fields[2].parse().map_err(|_| "bad memory limit")?;
    let argc: usize = fields[3].parse().map_err(|_| "bad argc")?;
    if argc > 4096 || fields.len() != 4 + argc {
        return Err("argument count mismatch".into());
    }
    if !allow.iter().any(|a| a.eq_ignore_ascii_case(&exe)) {
        return Err("executable is not on the allowlist".into());
    }
    let mut line = quote(&exe);
    for field in &fields[4..] {
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
            info.startup_info.std_output = stdout_write.0;
            info.startup_info.std_error = stderr_write.0;
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
        // procd's copies of the write ends close here, so readers see EOF
        // once the worker (the only other holder) exits.
        drop((stdin, stdout_write, stderr_write));
        Ok(Spawned {
            worker: Worker { job, thread: Owned(process.thread) },
            process: Owned(process.process),
            pid: process.process_id,
            stdout: stdout_read,
            stderr: stderr_read,
        })
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
                match spawn(&parts[2..], &allow) {
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
                            // Dropping the worker closes its job.
                            workers.lock().unwrap().remove(&id);
                            send(&out, &format!("EXITED\t{id}\t{code}"));
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
    // The service is gone (or broke the protocol): end every job, then exit.
    for worker in workers.lock().unwrap().values() {
        unsafe { TerminateJobObject(worker.job.0, 1) };
    }
    std::process::exit(0);
}
