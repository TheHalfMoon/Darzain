//! Worker read containment (Windows AppContainer).
//!
//! Every worker runs inside one AppContainer ("Yamakan.MediaWorker") with no
//! capabilities except one of its own: a capability SID derived from a name
//! unique to that worker. An AppContainer process is denied every object
//! whose access list does not name its container, a capability it holds, or
//! ALL APPLICATION PACKAGES, and without network capabilities it cannot open
//! a connection, local or remote. So a worker can read only:
//!   * the executable it runs, from a tools folder granted to the container;
//!   * system files Windows grants to all application packages;
//!   * the files and folders its request names, granted to its own
//!     capability for its lifetime and revoked when it exits.
//! The capability is unique per worker, so concurrent workers cannot read
//! each other's inputs. A grant left by a crash names a capability no later
//! token holds, and the service's start-up tree reset removes it from the
//! workspace.

use super::{last_error, wide, Bool, Handle, SidAndAttributes};
use std::ffi::c_void;
use std::ptr::null_mut;
use std::sync::OnceLock;

pub const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: usize = 0x0002_0009;
pub const PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY: usize = 0x0002_000F;
pub const ALL_APPLICATION_PACKAGES_OPT_OUT: u32 = 0x1;
pub const SE_GROUP_ENABLED: u32 = 0x0000_0004;
pub const FILE_GENERIC_READ: u32 = 0x0012_0089;
pub const FILE_GENERIC_EXECUTE: u32 = 0x0012_00A0;
// Read, write, append, attributes and delete (the "Modify" right).
pub const FILE_MODIFY: u32 = 0x0013_01BF;
// Enough to use a folder as the current directory, nothing more.
pub const FILE_TRAVERSE_ONLY: u32 = 0x0010_00A0;
const OBJECT_INHERIT_ACE: u32 = 0x1;
const CONTAINER_INHERIT_ACE: u32 = 0x2;
pub const INHERIT: u32 = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
const SE_FILE_OBJECT: i32 = 1;
const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
const ACL_REVISION: u32 = 2;
const CONTAINER_NAME: &str = "Yamakan.MediaWorker";

#[repr(C)]
pub struct SecurityCapabilities {
    pub app_container_sid: *mut c_void,
    pub capabilities: *mut SidAndAttributes,
    pub capability_count: u32,
    pub reserved: u32,
}

#[link(name = "userenv")]
extern "system" {
    fn CreateAppContainerProfile(
        name: *const u16,
        display: *const u16,
        description: *const u16,
        capabilities: *mut c_void,
        count: u32,
        sid: *mut *mut c_void,
    ) -> i32;
    fn DeriveAppContainerSidFromAppContainerName(name: *const u16, sid: *mut *mut c_void) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn GetLengthSid(sid: *mut c_void) -> u32;
    fn EqualSid(a: *mut c_void, b: *mut c_void) -> Bool;
    fn FreeSid(sid: *mut c_void) -> *mut c_void;
    fn InitializeAcl(acl: *mut c_void, length: u32, revision: u32) -> Bool;
    fn AddAccessAllowedAceEx(acl: *mut c_void, revision: u32, flags: u32, mask: u32, sid: *mut c_void) -> Bool;
    fn GetAce(acl: *mut c_void, index: u32, ace: *mut *mut c_void) -> Bool;
    fn AddAce(acl: *mut c_void, revision: u32, start: u32, list: *mut c_void, length: u32) -> Bool;
    fn GetSecurityInfo(
        handle: Handle,
        kind: i32,
        info: u32,
        owner: *mut *mut c_void,
        group: *mut *mut c_void,
        dacl: *mut *mut c_void,
        sacl: *mut *mut c_void,
        descriptor: *mut *mut c_void,
    ) -> u32;
    fn GetSecurityDescriptorControl(descriptor: *mut c_void, control: *mut u16, revision: *mut u32) -> Bool;
    fn InitializeSecurityDescriptor(descriptor: *mut c_void, revision: u32) -> Bool;
    fn SetSecurityDescriptorDacl(descriptor: *mut c_void, present: Bool, dacl: *mut c_void, defaulted: Bool) -> Bool;
    fn SetSecurityDescriptorControl(descriptor: *mut c_void, mask: u16, bits: u16) -> Bool;
    fn SetKernelObjectSecurity(handle: Handle, info: u32, descriptor: *mut c_void) -> Bool;
}

const SE_DACL_AUTO_INHERITED: u16 = 0x0400;
const SE_DACL_PROTECTED: u16 = 0x1000;

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryW(name: *const u16) -> Handle;
    fn GetProcAddress(module: Handle, name: *const u8) -> *mut c_void;
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
    #[link_name = "CreateFileW"]
    fn OpenForAccess(
        name: *const u16,
        access: u32,
        share: u32,
        security: *mut super::SecurityAttributes,
        disposition: u32,
        flags: u32,
        template: Handle,
    ) -> Handle;
    fn CloseHandle(handle: Handle) -> Bool;
}

const READ_CONTROL: u32 = 0x0002_0000;
const WRITE_DAC: u32 = 0x0004_0000;
const FILE_SHARE_ALL: u32 = 0x7;
const OPEN_EXISTING: u32 = 3;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const INVALID_HANDLE: Handle = -1isize as Handle;

/// A SID copied into owned memory (u64-aligned, as SIDs require).
pub struct Sid(Vec<u64>);
impl Sid {
    unsafe fn copy(sid: *mut c_void) -> Sid {
        let length = GetLengthSid(sid) as usize;
        let mut buffer = vec![0u64; length.div_ceil(8)];
        std::ptr::copy_nonoverlapping(sid as *const u8, buffer.as_mut_ptr() as *mut u8, length);
        Sid(buffer)
    }
    pub fn as_ptr(&self) -> *mut c_void {
        self.0.as_ptr() as *mut c_void
    }
}
// SAFETY: plain bytes, never mutated after creation.
unsafe impl Send for Sid {}
unsafe impl Sync for Sid {}

/// The container's SID, created on first use (or derived when the profile
/// already exists). Fails closed: no container, no worker.
pub fn container_sid() -> Result<&'static Sid, String> {
    static SID: OnceLock<Result<Sid, String>> = OnceLock::new();
    SID.get_or_init(|| unsafe {
        let name = wide(CONTAINER_NAME);
        let display = wide("Yamakan media worker");
        let mut sid: *mut c_void = null_mut();
        let created =
            CreateAppContainerProfile(name.as_ptr(), display.as_ptr(), display.as_ptr(), null_mut(), 0, &mut sid);
        if created != 0 {
            let derived = DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid);
            if derived != 0 {
                return Err(format!(
                    "AppContainer unavailable (create {created:#x}, derive {derived:#x})"
                ));
            }
        }
        let owned = Sid::copy(sid);
        FreeSid(sid);
        Ok(owned)
    })
    .as_ref()
    .map_err(|e| e.clone())
}

type DeriveCapabilities = unsafe extern "system" fn(
    *const u16,
    *mut *mut *mut c_void,
    *mut u32,
    *mut *mut *mut c_void,
    *mut u32,
) -> Bool;

/// The capability SID for a name (DeriveCapabilitySidsFromName, which has
/// no import library, so it is resolved at run time).
pub fn capability_sid(name: &str) -> Result<Sid, String> {
    unsafe {
        let module = LoadLibraryW(wide("kernelbase.dll").as_ptr());
        if module.is_null() {
            return Err(last_error("LoadLibrary(kernelbase)"));
        }
        let address = GetProcAddress(module, b"DeriveCapabilitySidsFromName\0".as_ptr());
        if address.is_null() {
            return Err(last_error("DeriveCapabilitySidsFromName"));
        }
        let derive: DeriveCapabilities = std::mem::transmute(address);
        let name = wide(name);
        let (mut groups, mut group_count, mut caps, mut cap_count) = (null_mut(), 0u32, null_mut(), 0u32);
        if derive(name.as_ptr(), &mut groups, &mut group_count, &mut caps, &mut cap_count) == 0 || cap_count == 0 {
            return Err(last_error("DeriveCapabilitySidsFromName"));
        }
        let sid = Sid::copy(*caps);
        for i in 0..group_count as usize {
            LocalFree(*groups.add(i));
        }
        for i in 0..cap_count as usize {
            LocalFree(*caps.add(i));
        }
        LocalFree(groups as *mut c_void);
        LocalFree(caps as *mut c_void);
        Ok(sid)
    }
}

/// Rewrites a file's or folder's access list: removes every explicit entry
/// for `sid`, then (when `grant` is given) adds one allowing `mask` with the
/// given inheritance flags after the explicit denies. Entries for other
/// SIDs, their order and the list's protection are kept. It works through
/// an open handle (never following a link), which changes this one object
/// only: unlike SetNamedSecurityInfo it does not walk and re-propagate the
/// folder's whole tree. A folder's new children inherit the grant; existing
/// children do not. (It writes with SetKernelObjectSecurity: the
/// higher-level SetSecurityInfo also walks and re-propagates the tree, which
/// took about 35 s on a user's temporary folder.)
pub fn set_access(path: &str, sid: &Sid, grant: Option<(u32, u32)>) -> Result<(), String> {
    // Concurrent read-modify-write cycles on one object (workers sharing a
    // current directory) would drop each other's entries: one at a time.
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    unsafe {
        let name = wide(path);
        let handle = OpenForAccess(
            name.as_ptr(),
            READ_CONTROL | WRITE_DAC,
            FILE_SHARE_ALL,
            null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        );
        if handle.is_null() || handle == INVALID_HANDLE {
            return Err(last_error("open for access"));
        }
        struct Close(Handle);
        impl Drop for Close {
            fn drop(&mut self) {
                unsafe { CloseHandle(self.0) };
            }
        }
        let _close = Close(handle);
        let mut old: *mut c_void = null_mut();
        let mut descriptor: *mut c_void = null_mut();
        let code = GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old,
            null_mut(),
            &mut descriptor,
        );
        if code != 0 {
            return Err(format!("read access: Windows error {code}"));
        }
        let result = (|| {
            if old.is_null() {
                return Err("an object without an access list cannot be contained".to_string());
            }
            let old_size = *((old as *const u8).add(2) as *const u16) as usize;
            let count = *((old as *const u8).add(4) as *const u16) as u32;
            let needed = old_size + 16 + GetLengthSid(sid.as_ptr()) as usize;
            if needed > 65_532 {
                return Err("the access list is too large".into());
            }
            let mut acl = vec![0u64; needed.div_ceil(8)];
            let acl_ptr = acl.as_mut_ptr() as *mut c_void;
            if InitializeAcl(acl_ptr, ((acl.len() * 8) as u32).min(65_532), ACL_REVISION) == 0 {
                return Err(last_error("InitializeAcl"));
            }
            // (ace, type, flags, size, names `sid`)
            let entry = |i: u32| -> Result<(*mut c_void, u8, u8, u32, bool), String> {
                let mut ace: *mut c_void = null_mut();
                if GetAce(old, i, &mut ace) == 0 {
                    return Err(last_error("GetAce"));
                }
                let bytes = ace as *const u8;
                let kind = *bytes;
                // Allowed (0) and denied (1) entries carry their SID at byte 8.
                let named = (kind == 0 || kind == 1) && EqualSid(bytes.add(8) as *mut c_void, sid.as_ptr()) != 0;
                Ok((ace, kind, *bytes.add(1), *(bytes.add(2) as *const u16) as u32, named))
            };
            let explicit_deny = |kind: u8, flags: u8| kind == 1 && flags & 0x10 == 0;
            for i in 0..count {
                let (ace, kind, flags, size, named) = entry(i)?;
                if !named && explicit_deny(kind, flags) && AddAce(acl_ptr, ACL_REVISION, u32::MAX, ace, size) == 0 {
                    return Err(last_error("AddAce"));
                }
            }
            if let Some((flags, mask)) = grant {
                if AddAccessAllowedAceEx(acl_ptr, ACL_REVISION, flags, mask, sid.as_ptr()) == 0 {
                    return Err(last_error("AddAccessAllowedAceEx"));
                }
            }
            // Every other entry, inherited ones included, keeps its place.
            for i in 0..count {
                let (ace, kind, flags, size, named) = entry(i)?;
                if !named && !explicit_deny(kind, flags) && AddAce(acl_ptr, ACL_REVISION, u32::MAX, ace, size) == 0 {
                    return Err(last_error("AddAce"));
                }
            }
            // A descriptor with only the new list, keeping the old list's
            // protected and auto-inherited flags.
            let mut control = 0u16;
            let mut revision = 0u32;
            if GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) == 0 {
                return Err(last_error("GetSecurityDescriptorControl"));
            }
            let mut fresh = [0u64; 8];
            let sd = fresh.as_mut_ptr() as *mut c_void;
            if InitializeSecurityDescriptor(sd, 1) == 0 || SetSecurityDescriptorDacl(sd, 1, acl_ptr, 0) == 0 {
                return Err(last_error("security descriptor"));
            }
            let kept = SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED;
            if SetSecurityDescriptorControl(sd, kept, control & kept) == 0 {
                return Err(last_error("SetSecurityDescriptorControl"));
            }
            if SetKernelObjectSecurity(handle, DACL_SECURITY_INFORMATION, sd) == 0 {
                return Err(last_error("set access"));
            }
            Ok(())
        })();
        LocalFree(descriptor);
        result
    }
}

/// The copy of an allowlisted executable that workers run: a Yamakan tools
/// folder (under %LOCALAPPDATA%) that grants the container read and
/// execute. The copy is refreshed when the source's size or modification
/// time changes; a folder per (name, size, time) never changes under a
/// running worker.
pub fn staged_tool(exe: &str) -> Result<String, String> {
    use std::os::windows::fs::MetadataExt;
    let sid = container_sid()?;
    let base = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is not set")?;
    let root = std::path::Path::new(&base).join("Yamakan").join("worker-tools");
    std::fs::create_dir_all(&root).map_err(|e| format!("tools folder: {e}"))?;
    let root_str = root.to_string_lossy().to_string();
    set_access(&root_str, sid, Some((INHERIT, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE)))?;
    let source = std::path::Path::new(exe);
    let meta = std::fs::metadata(source).map_err(|e| format!("executable: {e}"))?;
    let file = source.file_name().ok_or("executable has no name")?;
    let folder = root.join(format!(
        "{}-{}-{}",
        source.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default(),
        meta.len(),
        meta.last_write_time()
    ));
    let target = folder.join(file);
    // A cached copy can be modified after it was initially verified. Recheck
    // every reuse instead of trusting just source size and modification time.
    // Refuse altered cache entries rather than executing untrusted bytes.
    if target.exists() && !same_bytes(source, &target)? {
        return Err("the staged executable differs from its allowlisted source".into());
    }
    if !target.exists() {
        std::fs::create_dir_all(&folder).map_err(|e| format!("tools folder: {e}"))?;
        // A name of its own, so procds staging at once never share a file.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let partial = folder.join(format!("{}.{}.{nanos}.partial", file.to_string_lossy(), std::process::id()));
        std::fs::copy(source, &partial).map_err(|e| format!("copy executable: {e}"))?;
        // The copy must be byte-identical to the allowlisted source.
        if !same_bytes(source, &partial)? {
            let _ = std::fs::remove_file(&partial);
            return Err("the copied executable differs from its source".into());
        }
        if let Err(e) = std::fs::rename(&partial, &target) {
            let _ = std::fs::remove_file(&partial);
            // Another procd published the same copy first.
            if !target.exists() {
                return Err(format!("publish executable: {e}"));
            }
        }
    }
    Ok(target.to_string_lossy().to_string())
}

fn same_bytes(a: &std::path::Path, b: &std::path::Path) -> Result<bool, String> {
    use std::io::Read;
    let mut x = std::fs::File::open(a).map_err(|e| e.to_string())?;
    let mut y = std::fs::File::open(b).map_err(|e| e.to_string())?;
    let (mut p, mut q) = (vec![0u8; 1 << 20], vec![0u8; 1 << 20]);
    loop {
        let n = x.read(&mut p).map_err(|e| e.to_string())?;
        let mut m = 0;
        while m < n {
            let k = y.read(&mut q[m..n]).map_err(|e| e.to_string())?;
            if k == 0 {
                return Ok(false);
            }
            m += k;
        }
        if p[..n] != q[..n] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(y.read(&mut q[..1]).map_err(|e| e.to_string())? == 0);
        }
    }
}
