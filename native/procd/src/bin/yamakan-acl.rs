//! yamakan-acl — owner-only access for a Yamakan workspace on Windows.
//!
//!   yamakan-acl secure dir|file <path>
//!       Sets a protected DACL granting full access only to the current user,
//!       SYSTEM and Administrators (inherited by everything below a folder;
//!       existing children are updated by the system). Prints
//!       "OK changed" or "OK unchanged" (the DACL already matched).
//!   yamakan-acl describe <path>
//!       Prints the DACL as JSON: {"protected":bool,"aces":[{"type","flags",
//!       "mask","sid"}]}.
//!   yamakan-acl probe-other <path>
//!       Opens <path> for reading under a restricted copy of this process's
//!       token in which the current user and Administrators are deny-only and
//!       privileges are removed: what another standard account of this
//!       machine holds (Everyone, Users, Authenticated Users...). Prints
//!       "ALLOWED" or "DENIED <error>". Diagnostic evidence for the boundary.
//! Failures print "ERROR <code> <message>" and exit 1.
//!
//! Deliberately dependency-free: only the Windows API through hand-declared
//! FFI, like yamakan-procd.

use std::ffi::c_void;
use std::ptr::null_mut;

type Handle = *mut c_void;
type Bool = i32;
type Psid = *mut c_void;

const SE_FILE_OBJECT: i32 = 1;
const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
const PROTECTED_DACL_SECURITY_INFORMATION: u32 = 0x8000_0000;
const SE_DACL_PROTECTED: u16 = 0x1000;
const ACL_REVISION: u32 = 2;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const OBJECT_INHERIT_ACE: u32 = 0x1;
const CONTAINER_INHERIT_ACE: u32 = 0x2;
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
const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
const SECURITY_MAX_SID_SIZE: usize = 68;

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

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
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

fn process_token(access: u32) -> Token {
    let mut token: Handle = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut token) } == 0 {
        fail("OpenProcessToken", unsafe { GetLastError() });
    }
    Token(token)
}

// The current user's SID, copied into an owned buffer.
fn user_sid() -> Vec<u8> {
    let token = process_token(TOKEN_QUERY);
    let mut needed = 0u32;
    unsafe { GetTokenInformation(token.0, TOKEN_USER_CLASS, null_mut(), 0, &mut needed) };
    let mut buffer = vec![0u8; needed as usize];
    if unsafe { GetTokenInformation(token.0, TOKEN_USER_CLASS, buffer.as_mut_ptr() as *mut c_void, needed, &mut needed) } == 0 {
        fail("GetTokenInformation", unsafe { GetLastError() });
    }
    // TOKEN_USER starts with SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; }.
    let sid = unsafe { (*(buffer.as_ptr() as *const SidAndAttributes)).sid };
    let length = unsafe { GetLengthSid(sid) } as usize;
    unsafe { std::slice::from_raw_parts(sid as *const u8, length) }.to_vec()
}

fn well_known_sid(kind: i32) -> Vec<u8> {
    let mut buffer = vec![0u8; SECURITY_MAX_SID_SIZE];
    let mut size = SECURITY_MAX_SID_SIZE as u32;
    if unsafe { CreateWellKnownSid(kind, null_mut(), buffer.as_mut_ptr() as Psid, &mut size) } == 0 {
        fail("CreateWellKnownSid", unsafe { GetLastError() });
    }
    buffer.truncate(size as usize);
    buffer
}

fn sid_text(sid: Psid) -> String {
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
    dacl: *mut c_void,
}
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe { LocalFree(self.memory) };
    }
}

fn read_dacl(path: &[u16]) -> Descriptor {
    let mut dacl: *mut c_void = null_mut();
    let mut memory: *mut c_void = null_mut();
    let code = unsafe {
        GetNamedSecurityInfoW(
            path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut memory,
        )
    };
    if code != 0 {
        fail("GetNamedSecurityInfo", code);
    }
    Descriptor { memory, dacl }
}

fn protected(descriptor: &Descriptor) -> bool {
    let mut control = 0u16;
    let mut revision = 0u32;
    unsafe { GetSecurityDescriptorControl(descriptor.memory, &mut control, &mut revision) };
    control & SE_DACL_PROTECTED != 0
}

// (type, flags, mask, sid pointer) of each ACE.
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
            unsafe {
                (
                    *bytes,
                    *bytes.add(1),
                    std::ptr::read_unaligned(bytes.add(4) as *const u32),
                    bytes.add(8) as Psid,
                )
            }
        })
        .collect()
}

fn secure(kind: &str, path: &str) {
    let flags = match kind {
        "dir" => OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
        "file" => 0,
        _ => fail("kind must be dir or file", 87),
    };
    let mut sids = [user_sid(), well_known_sid(WIN_LOCAL_SYSTEM_SID), well_known_sid(WIN_BUILTIN_ADMINISTRATORS_SID)];
    let mut name = wide(path);
    // Unchanged when the DACL is already exactly these three protected grants.
    let current = read_dacl(&name);
    let entries = aces(&current);
    let matches = protected(&current)
        && entries.len() == sids.len()
        && sids.iter_mut().all(|sid| {
            entries.iter().any(|&(kind, ace_flags, mask, ace_sid)| {
                kind == ACCESS_ALLOWED_ACE_TYPE
                    && ace_flags as u32 == flags
                    && mask == FILE_ALL_ACCESS
                    && unsafe { EqualSid(ace_sid, sid.as_mut_ptr() as Psid) } != 0
            })
        });
    drop(current);
    if matches {
        println!("OK unchanged");
        return;
    }
    let mut acl = vec![0u64; 128]; // 1 KiB, aligned for the ACL header
    let size = (acl.len() * 8) as u32;
    let acl_ptr = acl.as_mut_ptr() as *mut c_void;
    if unsafe { InitializeAcl(acl_ptr, size, ACL_REVISION) } == 0 {
        fail("InitializeAcl", unsafe { GetLastError() });
    }
    for sid in sids.iter_mut() {
        if unsafe { AddAccessAllowedAceEx(acl_ptr, ACL_REVISION, flags, FILE_ALL_ACCESS, sid.as_mut_ptr() as Psid) } == 0 {
            fail("AddAccessAllowedAceEx", unsafe { GetLastError() });
        }
    }
    let code = unsafe {
        SetNamedSecurityInfoW(
            name.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            acl_ptr,
            null_mut(),
        )
    };
    if code != 0 {
        fail("SetNamedSecurityInfo", code);
    }
    println!("OK changed");
}

fn describe(path: &str) {
    let descriptor = read_dacl(&wide(path));
    let list: Vec<String> = aces(&descriptor)
        .into_iter()
        .map(|(kind, flags, mask, sid)| {
            format!("{{\"type\":{kind},\"flags\":{flags},\"mask\":{mask},\"sid\":\"{}\"}}", sid_text(sid))
        })
        .collect();
    println!(
        "{{\"protected\":{},\"null\":{},\"aces\":[{}]}}",
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
        SidAndAttributes { sid: user.as_mut_ptr() as Psid, attributes: 0 },
        SidAndAttributes { sid: admins.as_mut_ptr() as Psid, attributes: 0 },
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
    let name = wide(path);
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
