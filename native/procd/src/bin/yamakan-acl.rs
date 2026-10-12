//! yamakan-acl — owner-only access for a Yamakan workspace on Windows.
//!
//!   yamakan-acl secure dir|file <path>
//!       Makes <path> private to the current user: the owner becomes the
//!       current user and the DACL a protected list granting full access only
//!       to the current user, SYSTEM and Administrators. For a folder, the
//!       whole tree below is reset to inherit exactly that (explicit and
//!       protected entries below are removed, owners set to the current
//!       user), then every object below is checked. Refuses a path that is a
//!       link or junction, and a path owned by another account (it could
//!       rewrite the DACL whatever it says, and may hold handles opened
//!       before). Prints "OK".
//!   yamakan-acl describe <path>
//!       Prints {"owner","protected","aces":[{"type","flags","mask","sid"}]}.
//!   yamakan-acl probe-other <path>
//!       Opens <path> for reading under a restricted copy of this process's
//!       token in which the current user and Administrators are deny-only and
//!       privileges are removed. It keeps every other group (Everyone, Users,
//!       Authenticated Users, INTERACTIVE, this logon session), so it holds
//!       at least what another standard account of this machine holds; a
//!       denial is therefore conservative. Prints "ALLOWED" or
//!       "DENIED <error>".
//! Failures print "ERROR <code> <message>" and exit 1.
//!
//! Deliberately dependency-free: only the Windows API through hand-declared
//! FFI, like yamakan-procd.

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::Path;
use std::ptr::null_mut;

type Handle = *mut c_void;
type Bool = i32;
type Psid = *mut c_void;

const SE_FILE_OBJECT: i32 = 1;
const OWNER_SECURITY_INFORMATION: u32 = 0x0000_0001;
const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
const PROTECTED_DACL_SECURITY_INFORMATION: u32 = 0x8000_0000;
const SE_DACL_PROTECTED: u16 = 0x1000;
const ACL_REVISION: u32 = 2;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACCESS_DENIED_ACE_TYPE: u8 = 1;
const OBJECT_INHERIT_ACE: u32 = 0x1;
const CONTAINER_INHERIT_ACE: u32 = 0x2;
const INHERITED_ACE: u8 = 0x10;
const FILE_ALL_ACCESS: u32 = 0x001F_01FF;
const TOKEN_ASSIGN_PRIMARY: u32 = 0x0001;
const TOKEN_DUPLICATE: u32 = 0x0002;
const TOKEN_IMPERSONATE: u32 = 0x0004;
const TOKEN_QUERY: u32 = 0x0008;
const TOKEN_USER_CLASS: i32 = 1;
const DISABLE_MAX_PRIVILEGE: u32 = 0x1;
const SECURITY_IMPERSONATION: i32 = 2;
const TOKEN_IMPERSONATION: i32 = 2;
const WIN_LOCAL_SYSTEM_SID: i32 = 22;
const WIN_BUILTIN_ADMINISTRATORS_SID: i32 = 26;
const GENERIC_READ: u32 = 0x8000_0000;
const FILE_SHARE_ALL: u32 = 0x7;
const OPEN_EXISTING: u32 = 3;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
const PROGRESS_INVOKE_NEVER: i32 = 1;
const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
const SECURITY_MAX_SID_SIZE: usize = 68;
const ERROR_ACCESS_DENIED: u32 = 5;
const ERROR_NOT_SUPPORTED: u32 = 50;
const ERROR_INVALID_OWNER: u32 = 1307;

#[repr(C)]
struct SidAndAttributes {
    sid: Psid,
    attributes: u32,
}

#[repr(C)]
struct AclHeader {
    revision: u8,
    sbz1: u8,
    size: u16,
    count: u16,
    sbz2: u16,
}

#[cfg(target_pointer_width = "64")]
const _: () = {
    assert!(std::mem::size_of::<SidAndAttributes>() == 16);
    assert!(std::mem::size_of::<AclHeader>() == 8);
};

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> Handle;
    fn CloseHandle(handle: Handle) -> Bool;
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
    fn GetLastError() -> u32;
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: *mut c_void,
        disposition: u32,
        flags: u32,
        template: Handle,
    ) -> Handle;
}

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> Bool;
    fn GetTokenInformation(token: Handle, class: i32, info: *mut c_void, length: u32, returned: *mut u32) -> Bool;
    fn CreateWellKnownSid(kind: i32, domain: Psid, sid: Psid, size: *mut u32) -> Bool;
    fn GetLengthSid(sid: Psid) -> u32;
    fn EqualSid(a: Psid, b: Psid) -> Bool;
    fn InitializeAcl(acl: *mut c_void, length: u32, revision: u32) -> Bool;
    fn AddAccessAllowedAceEx(acl: *mut c_void, revision: u32, flags: u32, mask: u32, sid: Psid) -> Bool;
    fn GetAce(acl: *mut c_void, index: u32, ace: *mut *mut c_void) -> Bool;
    fn SetNamedSecurityInfoW(
        name: *mut u16,
        kind: i32,
        info: u32,
        owner: Psid,
        group: Psid,
        dacl: *mut c_void,
        sacl: *mut c_void,
    ) -> u32;
    fn TreeResetNamedSecurityInfoW(
        name: *mut u16,
        kind: i32,
        info: u32,
        owner: Psid,
        group: Psid,
        dacl: *mut c_void,
        sacl: *mut c_void,
        keep_explicit: Bool,
        progress: *mut c_void,
        invoke: i32,
        args: *mut c_void,
    ) -> u32;
    fn GetNamedSecurityInfoW(
        name: *const u16,
        kind: i32,
        info: u32,
        owner: *mut Psid,
        group: *mut Psid,
        dacl: *mut *mut c_void,
        sacl: *mut *mut c_void,
        descriptor: *mut *mut c_void,
    ) -> u32;
    fn GetSecurityDescriptorControl(descriptor: *mut c_void, control: *mut u16, revision: *mut u32) -> Bool;
    fn ConvertSidToStringSidW(sid: Psid, text: *mut *mut u16) -> Bool;
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
    fn DuplicateTokenEx(
        token: Handle,
        access: u32,
        attributes: *mut c_void,
        level: i32,
        kind: i32,
        duplicate: *mut Handle,
    ) -> Bool;
    fn SetThreadToken(thread: *mut Handle, token: Handle) -> Bool;
    fn RevertToSelf() -> Bool;
}

// A path for the Win32 calls in its extended-length form (\\?\ or
// \\?\UNC\), so a workspace deep enough for its objects to pass 260
// characters still works; names stay as the system's UTF-16, unconverted.
fn api_path(path: &Path) -> Vec<u16> {
    let raw: Vec<u16> = path.as_os_str().encode_wide().collect();
    let slash = '\\' as u16;
    let starts = |prefix: &str| {
        let p: Vec<u16> = prefix.encode_utf16().collect();
        raw.len() >= p.len() && raw[..p.len()] == p[..]
    };
    let mut out: Vec<u16> = if starts(r"\\?\") || starts(r"\\.\") {
        raw.clone()
    } else if raw.len() >= 2 && raw[0] == slash && raw[1] == slash {
        r"\\?\UNC\".encode_utf16().chain(raw[2..].iter().copied()).collect()
    } else {
        r"\\?\".encode_utf16().chain(raw.iter().copied()).collect()
    };
    out.push(0);
    out
}

fn fail(what: &str, code: u32) -> ! {
    println!("ERROR {code} {what}");
    std::process::exit(1);
}

struct Token(Handle);
impl Drop for Token {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

// A SID in an 8-byte aligned buffer.
struct Sid(Vec<u64>);
impl Sid {
    fn copy_of(sid: Psid) -> Sid {
        let length = unsafe { GetLengthSid(sid) } as usize;
        let mut buffer = vec![0u64; length.div_ceil(8)];
        unsafe { std::ptr::copy_nonoverlapping(sid as *const u8, buffer.as_mut_ptr() as *mut u8, length) };
        Sid(buffer)
    }
    fn ptr(&mut self) -> Psid {
        self.0.as_mut_ptr() as Psid
    }
    fn equals(&mut self, other: Psid) -> bool {
        !other.is_null() && unsafe { EqualSid(self.ptr(), other) } != 0
    }
}

fn process_token(access: u32) -> Token {
    let mut token: Handle = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut token) } == 0 {
        fail("OpenProcessToken", unsafe { GetLastError() });
    }
    Token(token)
}

fn user_sid() -> Sid {
    let token = process_token(TOKEN_QUERY);
    let mut needed = 0u32;
    unsafe { GetTokenInformation(token.0, TOKEN_USER_CLASS, null_mut(), 0, &mut needed) };
    // TOKEN_USER starts with SID_AND_ATTRIBUTES; an 8-byte aligned buffer.
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    if unsafe { GetTokenInformation(token.0, TOKEN_USER_CLASS, buffer.as_mut_ptr() as *mut c_void, needed, &mut needed) } == 0 {
        fail("GetTokenInformation", unsafe { GetLastError() });
    }
    Sid::copy_of(unsafe { (*(buffer.as_ptr() as *const SidAndAttributes)).sid })
}

fn well_known_sid(kind: i32) -> Sid {
    let mut buffer = vec![0u64; SECURITY_MAX_SID_SIZE.div_ceil(8)];
    let mut size = SECURITY_MAX_SID_SIZE as u32;
    if unsafe { CreateWellKnownSid(kind, null_mut(), buffer.as_mut_ptr() as Psid, &mut size) } == 0 {
        fail("CreateWellKnownSid", unsafe { GetLastError() });
    }
    Sid(buffer)
}

fn sid_text(sid: Psid) -> String {
    if sid.is_null() {
        return String::from("?");
    }
    let mut text: *mut u16 = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return String::from("?");
    }
    let mut length = 0;
    while unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    let value = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) });
    unsafe { LocalFree(text as *mut c_void) };
    value
}

struct Descriptor {
    memory: *mut c_void,
    owner: Psid,
    dacl: *mut c_void,
}
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe { LocalFree(self.memory) };
    }
}

fn read_security(path: &Path) -> Result<Descriptor, u32> {
    let name = api_path(path);
    let mut owner: Psid = null_mut();
    let mut dacl: *mut c_void = null_mut();
    let mut memory: *mut c_void = null_mut();
    let code = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut memory,
        )
    };
    if code != 0 {
        return Err(code);
    }
    Ok(Descriptor { memory, owner, dacl })
}

fn protected(descriptor: &Descriptor) -> bool {
    let mut control = 0u16;
    let mut revision = 0u32;
    unsafe { GetSecurityDescriptorControl(descriptor.memory, &mut control, &mut revision) };
    control & SE_DACL_PROTECTED != 0
}

// (type, flags, mask, sid) of each ACE. The SID is read only for allow and
// deny entries, whose layout puts it at byte 8; other kinds report none.
fn aces(descriptor: &Descriptor) -> Vec<(u8, u8, u32, Psid)> {
    if descriptor.dacl.is_null() {
        return Vec::new();
    }
    let count = unsafe { (*(descriptor.dacl as *const AclHeader)).count };
    (0..count as u32)
        .map(|i| {
            let mut ace: *mut c_void = null_mut();
            if unsafe { GetAce(descriptor.dacl, i, &mut ace) } == 0 {
                fail("GetAce", unsafe { GetLastError() });
            }
            let bytes = ace as *const u8;
            let kind = unsafe { *bytes };
            let sid = if kind == ACCESS_ALLOWED_ACE_TYPE || kind == ACCESS_DENIED_ACE_TYPE {
                unsafe { bytes.add(8) as Psid }
            } else {
                null_mut()
            };
            unsafe { (kind, *bytes.add(1), std::ptr::read_unaligned(bytes.add(4) as *const u32), sid) }
        })
        .collect()
}

fn is_reparse(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        Err(_) => fail("cannot read the path", ERROR_NOT_SUPPORTED),
    }
}

// Whether an object below the root is owned by the user, unprotected, and
// holds exactly the three grants, all inherited.
fn conforms(path: &Path, sids: &mut [Sid; 3]) -> bool {
    let Ok(descriptor) = read_security(path) else { return false };
    if !sids[0].equals(descriptor.owner) || protected(&descriptor) {
        return false;
    }
    let entries = aces(&descriptor);
    entries.len() == sids.len()
        && entries.iter().all(|&(kind, flags, mask, _)| {
            kind == ACCESS_ALLOWED_ACE_TYPE && flags & INHERITED_ACE != 0 && mask == FILE_ALL_ACCESS
        })
        && sids.iter_mut().all(|sid| entries.iter().any(|&(_, _, _, ace_sid)| sid.equals(ace_sid)))
}

// Makes the current user the owner of `path` when it is not (setting an
// owner needs WRITE_OWNER, which the owner-only DACL now grants). Below the
// root, objects another account owns are taken over rather than refused:
// the root's owner check already decided the folder is this account's.
fn take_ownership(path: &Path, user: &mut Sid) -> bool {
    let Ok(current) = read_security(path) else { return false };
    if user.equals(current.owner) {
        return true;
    }
    drop(current);
    let mut name = api_path(path);
    (unsafe {
        SetNamedSecurityInfoW(name.as_mut_ptr(), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, user.ptr(), null_mut(), null_mut(), null_mut())
    }) == 0
}

// Every object below `dir` conforms; links and junctions below, and
// entries that cannot be read, are failures.
fn verify_tree(dir: &Path, sids: &mut [Sid; 3], bad: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        bad.push(dir.display().to_string());
        return;
    };
    for entry in entries {
        let Ok(entry) = entry else {
            bad.push(dir.display().to_string());
            continue;
        };
        let path = entry.path();
        let text = path.display().to_string();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            bad.push(text);
            continue;
        };
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || !take_ownership(&path, &mut sids[0])
            || !conforms(&path, sids)
        {
            bad.push(text);
            continue;
        }
        if meta.is_dir() {
            verify_tree(&path, sids, bad);
        }
    }
}

fn secure(kind: &str, path: &str) {
    let flags = match kind {
        "dir" => OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
        "file" => 0,
        _ => fail("kind must be dir or file", 87),
    };
    if is_reparse(Path::new(path)) {
        fail("the path is a link or junction", ERROR_NOT_SUPPORTED);
    }
    let mut sids = [user_sid(), well_known_sid(WIN_LOCAL_SYSTEM_SID), well_known_sid(WIN_BUILTIN_ADMINISTRATORS_SID)];
    // Another account's folder is never adopted: its owner keeps the right
    // to rewrite the DACL, and handles it opened before keep their access.
    {
        let current = read_security(Path::new(path)).unwrap_or_else(|code| fail("GetNamedSecurityInfo", code));
        if !sids.iter_mut().any(|sid| sid.equals(current.owner)) {
            fail(&format!("owned by another account ({})", sid_text(current.owner)), ERROR_INVALID_OWNER);
        }
    }
    let mut acl = vec![0u64; 128]; // 1 KiB, aligned for the ACL header
    let size = (acl.len() * 8) as u32;
    let acl_ptr = acl.as_mut_ptr() as *mut c_void;
    if unsafe { InitializeAcl(acl_ptr, size, ACL_REVISION) } == 0 {
        fail("InitializeAcl", unsafe { GetLastError() });
    }
    for sid in sids.iter_mut() {
        if unsafe { AddAccessAllowedAceEx(acl_ptr, ACL_REVISION, flags, FILE_ALL_ACCESS, sid.ptr()) } == 0 {
            fail("AddAccessAllowedAceEx", unsafe { GetLastError() });
        }
    }
    let mut name = api_path(Path::new(path));
    // The DACL first (an owner may always rewrite it); owners follow once
    // the new DACL grants this user full control.
    let info = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
    let owner = null_mut();
    let code = if kind == "dir" {
        // The root gets the protected DACL; everything below is reset to
        // inherit it only (explicit and protected entries removed).
        unsafe {
            TreeResetNamedSecurityInfoW(
                name.as_mut_ptr(),
                SE_FILE_OBJECT,
                info,
                owner,
                null_mut(),
                acl_ptr,
                null_mut(),
                0,
                null_mut(),
                PROGRESS_INVOKE_NEVER,
                null_mut(),
            )
        }
    } else {
        unsafe { SetNamedSecurityInfoW(name.as_mut_ptr(), SE_FILE_OBJECT, info, owner, null_mut(), acl_ptr, null_mut()) }
    };
    if code != 0 {
        fail("SetSecurityInfo", code);
    }
    if !take_ownership(Path::new(path), &mut sids[0]) {
        fail("could not take ownership", ERROR_ACCESS_DENIED);
    }
    // The reset can report success without reaching every object: check.
    let root = read_security(Path::new(path)).unwrap_or_else(|code| fail("GetNamedSecurityInfo", code));
    let root_ok = sids[0].equals(root.owner) && protected(&root) && aces(&root).len() == 3;
    drop(root);
    if !root_ok {
        fail("the folder did not take the owner-only access", ERROR_ACCESS_DENIED);
    }
    if kind == "dir" {
        let mut bad = Vec::new();
        verify_tree(Path::new(path), &mut sids, &mut bad);
        if !bad.is_empty() {
            fail(&format!("{} objects below did not take it, first: {}", bad.len(), bad[0]), ERROR_ACCESS_DENIED);
        }
    }
    println!("OK");
}

fn describe(path: &str) {
    let descriptor = read_security(Path::new(path)).unwrap_or_else(|code| fail("GetNamedSecurityInfo", code));
    let list: Vec<String> = aces(&descriptor)
        .into_iter()
        .map(|(kind, flags, mask, sid)| {
            format!("{{\"type\":{kind},\"flags\":{flags},\"mask\":{mask},\"sid\":\"{}\"}}", sid_text(sid))
        })
        .collect();
    println!(
        "{{\"owner\":\"{}\",\"protected\":{},\"null\":{},\"aces\":[{}]}}",
        sid_text(descriptor.owner),
        protected(&descriptor),
        descriptor.dacl.is_null(),
        list.join(",")
    );
}

fn probe_other(path: &str) {
    let mut user = user_sid();
    let mut admins = well_known_sid(WIN_BUILTIN_ADMINISTRATORS_SID);
    let token = process_token(TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY);
    let mut disable = [
        SidAndAttributes { sid: user.ptr(), attributes: 0 },
        SidAndAttributes { sid: admins.ptr(), attributes: 0 },
    ];
    let mut restricted: Handle = null_mut();
    if unsafe {
        CreateRestrictedToken(
            token.0,
            DISABLE_MAX_PRIVILEGE,
            disable.len() as u32,
            disable.as_mut_ptr(),
            0,
            null_mut(),
            0,
            null_mut(),
            &mut restricted,
        )
    } == 0
    {
        fail("CreateRestrictedToken", unsafe { GetLastError() });
    }
    let restricted = Token(restricted);
    let mut impersonation: Handle = null_mut();
    if unsafe {
        DuplicateTokenEx(
            restricted.0,
            TOKEN_IMPERSONATE | TOKEN_QUERY,
            null_mut(),
            SECURITY_IMPERSONATION,
            TOKEN_IMPERSONATION,
            &mut impersonation,
        )
    } == 0
    {
        fail("DuplicateTokenEx", unsafe { GetLastError() });
    }
    let impersonation = Token(impersonation);
    if unsafe { SetThreadToken(null_mut(), impersonation.0) } == 0 {
        fail("SetThreadToken", unsafe { GetLastError() });
    }
    let name = api_path(Path::new(path));
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_ALL,
            null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    let error = unsafe { GetLastError() };
    unsafe { RevertToSelf() };
    if handle == INVALID_HANDLE_VALUE {
        println!("DENIED {error}");
    } else {
        unsafe { CloseHandle(handle) };
        println!("ALLOWED");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["secure", kind, path] => secure(kind, path),
        ["describe", path] => describe(path),
        ["probe-other", path] => probe_other(path),
        _ => fail("usage: secure dir|file <path> | describe <path> | probe-other <path>", 87),
    }
}
