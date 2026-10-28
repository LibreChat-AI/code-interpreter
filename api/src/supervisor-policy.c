#define _GNU_SOURCE
#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported supervisor architecture
#endif
#define DENY(call) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##call, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
int main(int argc, char **argv) {
    if (argc < 2) return 125;
    struct sock_filter instructions[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#ifdef __x86_64__
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
        DENY(socketpair), DENY(sendmsg), DENY(sendmmsg),
        DENY(io_uring_setup), DENY(io_uring_enter), DENY(io_uring_register),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { .len = sizeof(instructions) / sizeof(instructions[0]), .filter = instructions };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
        || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) {
        perror("sandbox supervisor policy"); return 125;
    }
    /* glibc's resolver batches queries with sendmmsg. Use sequential sendto
     * queries so hostname-based API/broker traffic needs no policy exception. */
    const char *existing = getenv("RES_OPTIONS");
    char *resolver_options = NULL;
    if (asprintf(&resolver_options, "%s%ssingle-request", existing ? existing : "",
                 existing && *existing ? " " : "") < 0) {
        perror("sandbox supervisor DNS options"); return 125;
    }
    if (setenv("RES_OPTIONS", resolver_options, 1) != 0) {
        perror("sandbox supervisor DNS options"); free(resolver_options); return 125;
    }
    free(resolver_options);
    execvp(argv[1], &argv[1]);
    perror("sandbox supervisor exec"); return 125;
}
