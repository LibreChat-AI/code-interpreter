use std::env;
use std::ffi::CString;
use std::process;

#[allow(non_camel_case_types)]
mod ffi {
    use libc::{c_char, c_int};

    extern "C" {
        pub fn krun_set_log_level(level: u32) -> i32;
        pub fn krun_create_ctx() -> i32;
        pub fn krun_set_vm_config(ctx_id: u32, num_vcpus: u8, ram_mib: u32) -> i32;
        pub fn krun_set_root(ctx_id: u32, root_path: *const c_char) -> i32;
        pub fn krun_add_disk(
            ctx_id: u32,
            block_id: *const c_char,
            disk_path: *const c_char,
            read_only: bool,
        ) -> i32;
        pub fn krun_set_root_disk_remount(
            ctx_id: u32,
            device: *const c_char,
            fstype: *const c_char,
            options: *const c_char,
        ) -> i32;
        pub fn krun_add_virtiofs(
            ctx_id: u32,
            c_tag: *const c_char,
            c_path: *const c_char,
        ) -> i32;
        pub fn krun_set_port_map(ctx_id: u32, port_map: *const *const c_char) -> i32;
        pub fn krun_set_exec(
            ctx_id: u32,
            exec_path: *const c_char,
            argv: *const *const c_char,
            envp: *const *const c_char,
        ) -> i32;
        pub fn krun_set_rlimits(ctx_id: u32, rlimits: *const *const c_char) -> i32;
        pub fn krun_start_enter(ctx_id: u32) -> i32;
    }

    pub fn check(name: &str, ret: c_int) {
        if ret < 0 {
            eprintln!("[launcher] {name} failed: error {ret}");
            std::process::exit(1);
        }
    }
}

mod seccomp {
    use std::mem;

    const SECCOMP_SET_MODE_FILTER: libc::c_ulong = 1;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    const EPERM: u32 = 1;

    const BPF_LD: u16 = 0x00;
    const BPF_W: u16 = 0x00;
    const BPF_ABS: u16 = 0x20;
    const BPF_JMP: u16 = 0x05;
    const BPF_JEQ: u16 = 0x10;
    const BPF_K: u16 = 0x00;
    const BPF_RET: u16 = 0x06;

    #[repr(C)]
    struct SockFilter {
        code: u16,
        jt: u8,
        jf: u8,
        k: u32,
    }

    #[repr(C)]
    struct SockFprog {
        len: u16,
        filter: *const SockFilter,
    }

    fn bpf_stmt(code: u16, k: u32) -> SockFilter {
        SockFilter { code, jt: 0, jf: 0, k }
    }

    fn bpf_jump(code: u16, k: u32, jt: u8, jf: u8) -> SockFilter {
        SockFilter { code, jt, jf, k }
    }

    /// Syscalls the VMM needs (from strace profiling of comprehensive workloads).
    /// Default action: ERRNO(EPERM) for anything not on this list.
    /// Note: ioctl is handled separately with argument filtering.
    fn allowed_syscalls() -> Vec<u32> {
        let mut v = vec![
            libc::SYS_read as u32,
            libc::SYS_write as u32,
            libc::SYS_openat as u32,
            libc::SYS_close as u32,
            libc::SYS_fstat as u32,
            libc::SYS_newfstatat as u32,
            libc::SYS_statx as u32,
            libc::SYS_lseek as u32,
            libc::SYS_mmap as u32,
            libc::SYS_mprotect as u32,
            libc::SYS_munmap as u32,
            libc::SYS_madvise as u32,
            libc::SYS_brk as u32,
            libc::SYS_dup as u32,
            libc::SYS_socket as u32,
            libc::SYS_connect as u32,
            libc::SYS_accept as u32,
            libc::SYS_sendto as u32,
            libc::SYS_recvfrom as u32,
            libc::SYS_bind as u32,
            libc::SYS_listen as u32,
            libc::SYS_setsockopt as u32,
            libc::SYS_getpeername as u32,
            libc::SYS_shutdown as u32,
            libc::SYS_clone as u32,
            libc::SYS_clone3 as u32,
            libc::SYS_execve as u32,
            libc::SYS_exit as u32,
            libc::SYS_exit_group as u32,
            libc::SYS_futex as u32,
            libc::SYS_epoll_create1 as u32,
            libc::SYS_epoll_ctl as u32,
            libc::SYS_eventfd2 as u32,
            libc::SYS_rt_sigaction as u32,
            libc::SYS_rt_sigprocmask as u32,
            libc::SYS_rt_sigreturn as u32,
            libc::SYS_sigaltstack as u32,
            libc::SYS_tgkill as u32,
            libc::SYS_getpid as u32,
            libc::SYS_getrandom as u32,
            libc::SYS_sched_getaffinity as u32,
            libc::SYS_sched_yield as u32,
            libc::SYS_set_robust_list as u32,
            libc::SYS_set_tid_address as u32,
            libc::SYS_rseq as u32,
            libc::SYS_prctl as u32,
            libc::SYS_prlimit64 as u32,
            libc::SYS_fcntl as u32,
            libc::SYS_ftruncate as u32,
            libc::SYS_fsync as u32,
            libc::SYS_fdatasync as u32,
            libc::SYS_pread64 as u32,
            libc::SYS_pwrite64 as u32,
            libc::SYS_preadv as u32,
            libc::SYS_pwritev as u32,
            libc::SYS_fallocate as u32,
            libc::SYS_readlinkat as u32,
            libc::SYS_getdents64 as u32,
            libc::SYS_fstatfs as u32,
            libc::SYS_fchmodat as u32,
            libc::SYS_mkdirat as u32,
            libc::SYS_mknodat as u32,
            libc::SYS_unlinkat as u32,
            libc::SYS_umask as u32,
            libc::SYS_capget as u32,
            libc::SYS_setresuid as u32,
            libc::SYS_setresgid as u32,
            libc::SYS_fgetxattr as u32,
            libc::SYS_flistxattr as u32,
        ];

        #[cfg(target_arch = "x86_64")]
        v.extend_from_slice(&[
            libc::SYS_access as u32,
            libc::SYS_epoll_wait as u32,
            libc::SYS_poll as u32,
            libc::SYS_arch_prctl as u32,
        ]);

        #[cfg(target_arch = "aarch64")]
        v.extend_from_slice(&[
            libc::SYS_faccessat as u32,
            libc::SYS_epoll_pwait as u32,
            libc::SYS_ppoll as u32,
        ]);

        v
    }

    pub fn apply_vmm_filter() -> Result<usize, String> {
        unsafe {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err("PR_SET_NO_NEW_PRIVS failed".into());
            }
        }

        let nr_offset = memoffset_nr();
        let arg1_offset = memoffset_args() + 8; // args[1] = ioctl request code

        // Build the filter in two passes: first compute layout, then emit.
        // Layout:
        //   [0]        LD syscall nr
        //   [1]        JEQ ioctl -> ioctl_block, else fall through
        //   [2..2+N-1] JEQ allowed[i] -> allow, else fall through
        //   [2+N]      RET ERRNO (default deny)
        //   [2+N+1]    RET ALLOW
        //   [2+N+2]    LD ioctl arg1 (request code)
        //   [2+N+3]    AND 0xFF00 (mask to magic byte)
        //   [2+N+4]    JEQ 0xAE00 (KVM) -> ioctl_allow, else fall through
        //   [2+N+5]    JEQ 0x5400 (terminal) -> ioctl_allow, else ioctl_deny
        //   [2+N+6]    RET ALLOW (ioctl_allow)
        //   [2+N+7]    RET ERRNO (ioctl_deny)

        let syscalls = allowed_syscalls();
        let n = syscalls.len();
        let idx_ioctl_jmp = 1;
        let idx_checks    = 2;                // 2 .. 2+N-1
        let idx_deny      = idx_checks + n;   // 2+N
        let idx_allow     = idx_deny + 1;     // 2+N+1
        let idx_ioctl_ld  = idx_allow + 1;    // 2+N+2
        let idx_ioctl_and = idx_ioctl_ld + 1;
        let idx_kvm_chk   = idx_ioctl_and + 1;
        let idx_term_chk  = idx_kvm_chk + 1;
        let idx_ioctl_ok  = idx_term_chk + 1;
        let idx_ioctl_no  = idx_ioctl_ok + 1;

        let mut f: Vec<SockFilter> = Vec::with_capacity(idx_ioctl_no + 1);

        // [0] Load syscall number
        f.push(bpf_stmt(BPF_LD | BPF_W | BPF_ABS, nr_offset));

        // [1] If ioctl, jump to ioctl arg filter block
        f.push(bpf_jump(
            BPF_JMP | BPF_JEQ | BPF_K,
            libc::SYS_ioctl as u32,
            (idx_ioctl_ld - idx_ioctl_jmp - 1) as u8,
            0,
        ));

        // [2..2+N-1] Allowlist checks
        for (i, &nr) in syscalls.iter().enumerate() {
            let my_idx = idx_checks + i;
            f.push(bpf_jump(
                BPF_JMP | BPF_JEQ | BPF_K,
                nr,
                (idx_allow - my_idx - 1) as u8,
                0,
            ));
        }

        // [2+N] Default deny
        f.push(bpf_stmt(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM));

        // [2+N+1] Allow
        f.push(bpf_stmt(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));

        // [2+N+2] Load ioctl request code (arg1, lower 32 bits)
        f.push(bpf_stmt(BPF_LD | BPF_W | BPF_ABS, arg1_offset));

        // [2+N+3] Mask to magic byte: request & 0xFF00
        f.push(bpf_stmt(0x54, 0x0000_FF00)); // BPF_ALU | BPF_AND | BPF_K

        // [2+N+4] KVM magic (0xAE)
        f.push(bpf_jump(
            BPF_JMP | BPF_JEQ | BPF_K,
            0xAE00,
            (idx_ioctl_ok - idx_kvm_chk - 1) as u8,
            0,
        ));

        // [2+N+5] Terminal magic (0x54: TCGETS, TIOCGWINSZ, FIONREAD)
        f.push(bpf_jump(
            BPF_JMP | BPF_JEQ | BPF_K,
            0x5400,
            (idx_ioctl_ok - idx_term_chk - 1) as u8,
            (idx_ioctl_no - idx_term_chk - 1) as u8,
        ));

        // [2+N+6] ioctl allow
        f.push(bpf_stmt(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));

        // [2+N+7] ioctl deny
        f.push(bpf_stmt(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM));

        assert_eq!(f.len(), idx_ioctl_no + 1);

        let prog = SockFprog {
            len: f.len() as u16,
            filter: f.as_ptr(),
        };

        let ret = unsafe {
            libc::syscall(
                libc::SYS_seccomp,
                SECCOMP_SET_MODE_FILTER as libc::c_ulong,
                0 as libc::c_ulong,
                &prog as *const SockFprog as libc::c_ulong,
            )
        };

        if ret != 0 {
            return Err(format!("seccomp(SECCOMP_SET_MODE_FILTER) failed: {}", ret));
        }

        Ok(syscalls.len() + 1) // +1 for ioctl (arg-filtered)
    }

    fn memoffset_nr() -> u32 {
        mem::offset_of!(SeccompData, nr) as u32
    }

    fn memoffset_args() -> u32 {
        mem::offset_of!(SeccompData, args) as u32
    }

    #[repr(C)]
    struct SeccompData {
        nr: i32,
        arch: u32,
        instruction_pointer: u64,
        args: [u64; 6],
    }
}

fn cstr(s: &str) -> CString {
    CString::new(s).expect("CString::new failed")
}

fn null_term(v: &[CString]) -> Vec<*const libc::c_char> {
    let mut ptrs: Vec<*const libc::c_char> = v.iter().map(|s| s.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    ptrs
}

fn desired_nofile_soft_limit(
    current_soft: libc::rlim_t,
    hard: libc::rlim_t,
    target: libc::rlim_t,
) -> Option<libc::rlim_t> {
    let desired = target.min(hard);
    if current_soft >= desired {
        None
    } else {
        Some(desired)
    }
}

fn raise_nofile_limit(target: libc::rlim_t) {
    let mut limit = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, limit.as_mut_ptr()) } != 0 {
        eprintln!("[launcher] WARNING: getrlimit(RLIMIT_NOFILE) failed");
        return;
    }
    let limit = unsafe { limit.assume_init() };

    let Some(new_soft) = desired_nofile_soft_limit(limit.rlim_cur, limit.rlim_max, target) else {
        eprintln!(
            "[launcher] RLIMIT_NOFILE soft={} hard={} target={}",
            limit.rlim_cur, limit.rlim_max, target
        );
        return;
    };

    let new_limit = libc::rlimit {
        rlim_cur: new_soft,
        rlim_max: limit.rlim_max,
    };
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &new_limit) } != 0 {
        eprintln!(
            "[launcher] WARNING: setrlimit(RLIMIT_NOFILE) failed soft={} hard={} target={}",
            limit.rlim_cur, limit.rlim_max, target
        );
        return;
    }

    eprintln!(
        "[launcher] Raised RLIMIT_NOFILE soft limit from {} to {} (hard={} target={})",
        limit.rlim_cur, new_soft, limit.rlim_max, target
    );
}

fn guest_nofile_rlimit(limit: libc::rlim_t) -> CString {
    cstr(&format!(
        "{}={}:{}",
        libc::RLIMIT_NOFILE,
        limit,
        limit
    ))
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_bool(name: &str, default: bool) -> bool {
    match non_empty_env(name)
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("1" | "true" | "yes" | "on") => true,
        Some("0" | "false" | "no" | "off") => false,
        Some(value) => {
            eprintln!("[launcher] WARNING: ignoring invalid boolean {name}={value:?}");
            default
        }
        None => default,
    }
}

fn is_allowed_guest_env_key(key: &str, egress_gateway_enabled: bool) -> bool {
    const ALLOW_EXACT: &[&str] = &[
        "CODEAPI_HARDENED_SANDBOX_MODE",
        "EGRESS_GATEWAY_URL",
        "HOME",
        "NSJAIL_CONFIG",
        "NSJAIL_PATH",
        "NODE_ENV",
        "NO_COLOR",
        "PATH",
        "PORT",
        "SANDBOX_ALLOWED_LOCAL_NETWORK_PORT",
        "SANDBOX_BIND_HOST",
        "SANDBOX_COMPILE_CPU_TIME",
        "SANDBOX_COMPILE_MEMORY_LIMIT",
        "SANDBOX_COMPILE_TIMEOUT",
        "SANDBOX_DATA_DIRECTORY",
        "SANDBOX_DISABLE_NETWORKING",
        "SANDBOX_EXECUTE_BODY_LIMIT",
        "SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY",
        "SANDBOX_FORWARD_TARGET",
        "SANDBOX_LIMIT_OVERRIDES",
        "SANDBOX_LOG_LEVEL",
        "SANDBOX_MAX_CONCURRENT_JOBS",
        "SANDBOX_MAX_FILE_SIZE",
        "SANDBOX_MAX_NESTING_DEPTH",
        "SANDBOX_MAX_OPEN_FILES",
        "SANDBOX_MAX_OUTPUT_FILES",
        "SANDBOX_MAX_PATH_LENGTH",
        "SANDBOX_PACKAGES_DIRECTORY",
        "SANDBOX_MAX_PROCESS_COUNT",
        "SANDBOX_OUTPUT_MAX_SIZE",
        "SANDBOX_REQUIRE_EGRESS_MANIFEST",
        "SANDBOX_RLIMIT_AS",
        "SANDBOX_RLIMIT_FSIZE",
        "SANDBOX_RUN_CPU_TIME",
        "SANDBOX_RUN_MEMORY_LIMIT",
        "SANDBOX_RUN_TIMEOUT",
        "SANDBOX_UPLOAD_CONCURRENCY",
        "SANDBOX_USE_CGROUPV2",
        "TERM",
        "TMPDIR",
        "TZ",
    ];
    // Non-gateway deployments still rely on FILE_SERVER_URL for sandbox file IO.
    // Hardened egress mode keeps blocking it so sandbox traffic goes only to the gateway.
    const LEGACY_NON_EGRESS_EXACT: &[&str] = &["FILE_SERVER_URL"];
    const DENY_PREFIXES: &[&str] = &[
        "AWS_",
        "CODEAPI_",
        "LIBRECHAT_",
        "MINIO_",
        "REDIS_",
        "S3_",
    ];
    const DENY_SUBSTRINGS: &[&str] = &["SECRET", "TOKEN", "PASSWORD"];

    if !egress_gateway_enabled && LEGACY_NON_EGRESS_EXACT.contains(&key) {
        return true;
    }

    if ALLOW_EXACT.contains(&key) {
        return true;
    }

    let upper_key = key.to_ascii_uppercase();
    if DENY_PREFIXES.iter().any(|prefix| upper_key.starts_with(prefix)) ||
        DENY_SUBSTRINGS.iter().any(|part| upper_key.contains(part))
    {
        return false;
    }

    false
}

fn main() {
    let vcpus: u8 = env::var("LAUNCHER_VCPUS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2);
    let ram_mib: u32 = env::var("LAUNCHER_RAM_MIB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2048);
    let rootfs = env::var("LAUNCHER_ROOTFS").unwrap_or_else(|_| "/sandbox-rootfs".into());
    let root_disk = non_empty_env("LAUNCHER_ROOT_DISK");
    let root_disk_read_only = env_bool("LAUNCHER_ROOT_DISK_READ_ONLY", true);
    let root_device = non_empty_env("LAUNCHER_ROOT_DEVICE").unwrap_or_else(|| "/dev/vda".into());
    let root_fstype = non_empty_env("LAUNCHER_ROOT_FSTYPE").unwrap_or_else(|| "ext4".into());
    let root_options = non_empty_env("LAUNCHER_ROOT_OPTIONS").unwrap_or_else(|| "ro".into());
    let exec_path = env::var("LAUNCHER_EXEC").unwrap_or_else(|_| "/sandbox_api/entrypoint.sh".into());
    let log_level: u32 = env::var("LAUNCHER_LOG_LEVEL")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let nofile_target: libc::rlim_t = env::var("LAUNCHER_NOFILE_LIMIT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(65_536);

    raise_nofile_limit(nofile_target);
    if let Some(root_disk) = &root_disk {
        eprintln!(
            "[launcher] Booting microVM: vcpus={vcpus} ram={ram_mib}MiB root_disk={root_disk} device={root_device} fstype={root_fstype} options={root_options} read_only={root_disk_read_only}"
        );
    } else {
        eprintln!("[launcher] Booting microVM: vcpus={vcpus} ram={ram_mib}MiB rootfs={rootfs}");
    }
    eprintln!("[launcher] Guest entrypoint: {exec_path}");

    let rootfs_c = cstr(&rootfs);
    let root_disk_c = root_disk.as_ref().map(|value| cstr(value));
    let root_device_c = cstr(&root_device);
    let root_fstype_c = cstr(&root_fstype);
    let root_options_c = cstr(&root_options);
    let exec_c = cstr(&exec_path);

    let port_map_strs = vec![cstr("2000:2000")];
    let port_map_ptrs = null_term(&port_map_strs);

    let egress_gateway_enabled = env::var("EGRESS_GATEWAY_URL")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    let env_strs: Vec<CString> = env::vars()
        .filter(|(k, _)| !k.starts_with("LAUNCHER_"))
        .filter(|(k, _)| is_allowed_guest_env_key(k, egress_gateway_enabled))
        .map(|(k, v)| cstr(&format!("{k}={v}")))
        .collect();
    let env_ptrs = null_term(&env_strs);

    let argv_strs: Vec<CString> = vec![cstr(&exec_path)];
    let argv_ptrs = null_term(&argv_strs);

    let rlimit_strs: Vec<CString> = vec![guest_nofile_rlimit(nofile_target)];
    let rlimit_ptrs = null_term(&rlimit_strs);

    let packages_host = env::var("LAUNCHER_PACKAGES_HOST")
        .unwrap_or_else(|_| "/host-packages".into());

    unsafe {
        ffi::check("set_log_level", ffi::krun_set_log_level(log_level));

        let ctx = ffi::krun_create_ctx();
        if ctx < 0 {
            eprintln!("[launcher] krun_create_ctx failed: {ctx}");
            process::exit(1);
        }
        let ctx = ctx as u32;

        ffi::check("set_vm_config", ffi::krun_set_vm_config(ctx, vcpus, ram_mib));
        if let Some(root_disk_c) = &root_disk_c {
            let block_id = cstr("root");
            ffi::check(
                "add_root_disk",
                ffi::krun_add_disk(
                    ctx,
                    block_id.as_ptr(),
                    root_disk_c.as_ptr(),
                    root_disk_read_only,
                ),
            );
            ffi::check(
                "set_root_disk_remount",
                ffi::krun_set_root_disk_remount(
                    ctx,
                    root_device_c.as_ptr(),
                    root_fstype_c.as_ptr(),
                    root_options_c.as_ptr(),
                ),
            );
        } else {
            ffi::check("set_root", ffi::krun_set_root(ctx, rootfs_c.as_ptr()));
        }

        if std::path::Path::new(&packages_host).exists() {
            let tag = cstr("packages");
            let path = cstr(&packages_host);
            ffi::check("add_virtiofs", ffi::krun_add_virtiofs(ctx, tag.as_ptr(), path.as_ptr()));
            eprintln!("[launcher] Mounted {packages_host} as virtio-fs 'packages'");
        }

        ffi::check("set_port_map", ffi::krun_set_port_map(ctx, port_map_ptrs.as_ptr()));
        eprintln!("[launcher] Port map: 2000:2000");

        ffi::check(
            "set_exec",
            ffi::krun_set_exec(ctx, exec_c.as_ptr(), argv_ptrs.as_ptr(), env_ptrs.as_ptr()),
        );
        ffi::check("set_rlimits", ffi::krun_set_rlimits(ctx, rlimit_ptrs.as_ptr()));
        eprintln!("[launcher] Guest RLIMIT_NOFILE target: {nofile_target}");

        match seccomp::apply_vmm_filter() {
            Ok(n) => eprintln!("[launcher] VMM seccomp filter applied ({n} syscalls allowed, ioctl restricted to KVM+terminal)"),
            Err(e) => {
                eprintln!("[launcher] WARNING: Failed to apply VMM seccomp: {e}");
            }
        }

        eprintln!("[launcher] Starting microVM...");

        let ret = ffi::krun_start_enter(ctx);
        eprintln!("[launcher] krun_start_enter returned {ret} (should not return on success)");
        process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{desired_nofile_soft_limit, guest_nofile_rlimit, is_allowed_guest_env_key};

    #[test]
    fn guest_env_allowlist_blocks_control_plane_and_secret_vars() {
        for key in [
            "REDIS_HOST",
            "REDIS_PASSWORD",
            "TOOL_CALL_SERVER_URL",
            "CODEAPI_INTERNAL_SERVICE_TOKEN",
            "CODEAPI_EGRESS_GRANT_SECRET",
            "CODEAPI_EXECUTION_MANIFEST_SECRET",
            "SANDBOX_EXECUTION_MANIFEST_SECRET",
            "SANDBOX_CALLBACK_TOKEN",
            "SANDBOX_PRIVATE_KEY",
            "SANDBOX_FAKE_SECRET",
            "AWS_ACCESS_KEY_ID",
            "S3_BUCKET",
            "MINIO_ROOT_PASSWORD",
            "CODEAPI_JWT_SECRET",
            "TOOL_CALL_SERVER_URL",
            "SANDBOX_UNDECLARED_KNOB",
        ] {
            assert!(!is_allowed_guest_env_key(key, true), "{key} should not enter the sandbox guest");
        }
    }

    #[test]
    fn guest_env_allowlist_keeps_only_runner_runtime_vars() {
        for key in [
            "EGRESS_GATEWAY_URL",
            "CODEAPI_HARDENED_SANDBOX_MODE",
            "SANDBOX_DISABLE_NETWORKING",
            "SANDBOX_ALLOWED_LOCAL_NETWORK_PORT",
            "SANDBOX_FORWARD_TARGET",
            "SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY",
            "SANDBOX_BIND_HOST",
            "SANDBOX_RUN_TIMEOUT",
            "NSJAIL_CONFIG",
            "PORT",
            "PATH",
        ] {
            assert!(is_allowed_guest_env_key(key, true), "{key} should enter the sandbox guest");
        }
    }

    #[test]
    fn guest_env_allowlist_preserves_legacy_file_server_url_only_without_egress_gateway() {
        assert!(is_allowed_guest_env_key("FILE_SERVER_URL", false));
        assert!(!is_allowed_guest_env_key("FILE_SERVER_URL", true));
    }

    #[test]
    fn nofile_limit_raises_soft_limit_to_target() {
        assert_eq!(desired_nofile_soft_limit(1024, 1_048_576, 65_536), Some(65_536));
    }

    #[test]
    fn nofile_limit_respects_hard_limit() {
        assert_eq!(desired_nofile_soft_limit(1024, 4096, 65_536), Some(4096));
    }

    #[test]
    fn nofile_limit_leaves_sufficient_soft_limit_unchanged() {
        assert_eq!(desired_nofile_soft_limit(65_536, 1_048_576, 65_536), None);
    }

    #[test]
    fn guest_nofile_rlimit_uses_numeric_resource_format() {
        assert_eq!(guest_nofile_rlimit(65_536).to_str().unwrap(), "7=65536:65536");
    }
}

