#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Stable UAPI values missing from Debian 12's older build headers. */
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#ifndef __NR_fchmodat2
#define __NR_fchmodat2 452
#endif

#if defined(__x86_64__)
#define ARCH AUDIT_ARCH_X86_64
#define LOADER "/lib64/ld-linux-x86-64.so.2"
#elif defined(__aarch64__)
#define ARCH AUDIT_ARCH_AARCH64
#define LOADER "/lib/ld-linux-aarch64.so.1"
#else
#error Unsupported architecture
#endif

static void fail_at(int line) { fprintf(stderr, "ISOLATION_UNAVAILABLE:%d:%d\n", line, errno); exit(125); }
#define fail() fail_at(__LINE__)
static void limit(int resource, rlim_t value) {
    struct rlimit r = {value, value};
    if (setrlimit(resource, &r)) fail();
}
static void allow(int rules, const char *path, __u64 access) {
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) fail();
    struct landlock_path_beneath_attr rule = {.allowed_access = access, .parent_fd = fd};
    if (syscall(SYS_landlock_add_rule, rules, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) fail();
    close(fd);
}
#define DENY(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, nr, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
static void restrict_syscalls(void) {
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#ifdef __x86_64__
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
        DENY(__NR_socket), DENY(__NR_socketpair), DENY(__NR_connect),
        DENY(__NR_bind), DENY(__NR_listen), DENY(__NR_accept), DENY(__NR_accept4),
        DENY(__NR_clone), DENY(__NR_clone3),
#ifdef __NR_fork
        DENY(__NR_fork), DENY(__NR_vfork),
#endif
        DENY(__NR_ptrace), DENY(__NR_process_vm_readv), DENY(__NR_process_vm_writev),
        DENY(__NR_kill), DENY(__NR_tkill), DENY(__NR_tgkill), DENY(__NR_pidfd_send_signal),
        DENY(__NR_mount), DENY(__NR_umount2), DENY(__NR_pivot_root), DENY(__NR_chroot),
        DENY(__NR_unshare), DENY(__NR_setns), DENY(__NR_bpf), DENY(__NR_userfaultfd),
        DENY(__NR_io_uring_setup), DENY(__NR_perf_event_open),
        DENY(__NR_setpriority), DENY(__NR_sched_setparam), DENY(__NR_sched_setscheduler),
        DENY(__NR_sched_setaffinity), DENY(__NR_sched_setattr),
        DENY(__NR_pidfd_open), DENY(__NR_pidfd_getfd),
        DENY(__NR_keyctl), DENY(__NR_add_key), DENY(__NR_request_key),
        DENY(__NR_shmget), DENY(__NR_shmat), DENY(__NR_shmctl),
        DENY(__NR_semget), DENY(__NR_semop), DENY(__NR_semctl),
        DENY(__NR_msgget), DENY(__NR_msgsnd), DENY(__NR_msgrcv), DENY(__NR_msgctl),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_prlimit64, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        DENY(__NR_utimensat),
#ifdef __NR_utime
        DENY(__NR_utime), DENY(__NR_utimes), DENY(__NR_futimesat),
#endif
#ifdef __NR_fchmodat2
        DENY(__NR_fchmodat2),
#endif
        DENY(__NR_open_by_handle_at), DENY(__NR_name_to_handle_at),
        DENY(__NR_fchmod), DENY(__NR_fchmodat), DENY(__NR_fchown), DENY(__NR_fchownat),
#ifdef __NR_chmod
        DENY(__NR_chmod), DENY(__NR_chown), DENY(__NR_lchown),
#endif
        DENY(__NR_mknodat), DENY(__NR_setuid), DENY(__NR_setgid),
        DENY(__NR_setreuid), DENY(__NR_setregid), DENY(__NR_setresuid), DENY(__NR_setresgid),
        DENY(__NR_setgroups), DENY(__NR_setxattr), DENY(__NR_lsetxattr), DENY(__NR_fsetxattr),
        DENY(__NR_removexattr), DENY(__NR_lremovexattr), DENY(__NR_fremovexattr),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
    };
    struct sock_fprog program = {.len = sizeof(filter) / sizeof(filter[0]), .filter = filter};
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) fail();
}
int main(int argc, char **argv) {
    if (argc != 5 || geteuid() == 0) fail();
    /* Paths are supervisor-owned, never supplied in the HTTP protocol. */
    if (chdir(argv[1])) fail();
    pid_t parent = getppid();
    if (parent == 1 || prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) fail();
    limit(RLIMIT_AS, 512ULL * 1024 * 1024);
    limit(RLIMIT_CPU, 8);
    limit(RLIMIT_FSIZE, 4ULL * 1024 * 1024);
    limit(RLIMIT_NOFILE, 64);
    limit(RLIMIT_CORE, 0);
    if (prctl(PR_SET_DUMPABLE, 0) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail();
    if (syscall(SYS_close_range, 3, ~0U, 0)) fail();
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 3) fail();
    __u64 read = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
    __u64 write = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE | LANDLOCK_ACCESS_FS_MAKE_REG;
    struct landlock_ruleset_attr attr = {
        .handled_access_fs = (1ULL << 15) - 1 /* ABI 3, including REFER and TRUNCATE */
    };
    int rules = syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
    if (rules < 0) fail();
    allow(rules, "/usr", read);
    allow(rules, "/lib", read);
    if (access("/lib64", F_OK) == 0) allow(rules, "/lib64", read);
    allow(rules, argv[2], LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE);
    allow(rules, LOADER, LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE);
    allow(rules, argv[3], LANDLOCK_ACCESS_FS_READ_FILE);
    allow(rules, argv[1], read | write);
    allow(rules, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE);
    allow(rules, "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE);
    if (syscall(SYS_landlock_restrict_self, rules, 0)) fail();
    close(rules);
    restrict_syscalls();
    if (clearenv() || setenv("LANG", "C.UTF-8", 1)) fail();
    execl(argv[2], argv[2], "-I", "-B", argv[3], argv[4], (char *)NULL);
    fail();
}
