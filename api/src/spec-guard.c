#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef PR_SET_SPECULATION_CTRL
#define PR_SET_SPECULATION_CTRL 53
#endif
#ifndef PR_SPEC_STORE_BYPASS
#define PR_SPEC_STORE_BYPASS 0
#endif
#ifndef PR_SPEC_INDIRECT_BRANCH
#define PR_SPEC_INDIRECT_BRANCH 1
#endif
#ifndef PR_SPEC_FORCE_DISABLE
#define PR_SPEC_FORCE_DISABLE 8
#endif

#ifndef __NR_close_range
#  if defined(__x86_64__)
#    define __NR_close_range 436
#  elif defined(__aarch64__)
#    define __NR_close_range 436
#  endif
#endif

static int first_untrusted_fd = 3;

static void close_fd_loop(long start, long end) {
    if (start < first_untrusted_fd) start = first_untrusted_fd;
    if (end > INT_MAX) end = INT_MAX;
    if (start > end) return;
    for (long fd = start; fd <= end; fd++) {
        close((int)fd);
    }
}

static bool close_proc_fds(void) {
    DIR *d = opendir("/proc/self/fd");
    if (d == NULL) return false;

    int dir_fd = dirfd(d);
    struct dirent *entry;
    while ((entry = readdir(d)) != NULL) {
        if (entry->d_name[0] == '.') continue;
        char *end = NULL;
        long fd = strtol(entry->d_name, &end, 10);
        if (end == entry->d_name || *end != '\0') continue;
        if (fd < first_untrusted_fd || fd > (long)INT_MAX) continue;
        if ((int)fd == dir_fd) continue;  /* don't close our iterator */
        close((int)fd);
    }
    closedir(d);
    return true;
}

/* Close every unrelated descriptor (preserve stdin/stdout/stderr and,
 * only with --tool-call-pipes, the validated pipe endpoints 3/4) before
 * the user command runs. The bug this prevents:
 *
 *   (1) sandbox API / proxy / NsJail allocate FDs in the runner;
 *   (2) NsJail forks a child to run the user command;
 *   (3) any FD without O_CLOEXEC is INHERITED by the child;
 *   (4) the child's RLIMIT_NOFILE counts those inherited slots, so a
 *       runner-side FD storm leaves the child starting in a poisoned
 *       state — the dynamic loader hits EMFILE before user code runs:
 *           "error while loading shared libraries: libc.so.6: cannot
 *            close file descriptor: Error 24"
 *
 * Closing here, on the wrong side of execvp, is the cheapest containment.
 * Every user command in the sandbox already passes through spec-guard,
 * so this is the right choke point regardless of which producer leaked.
 *
 * Order of attempts:
 *   1. close_range(3, ~0U, 0)  (Linux 5.9+; one syscall, fastest)
 *   2. /proc/self/fd walk      (only closes actually-open FDs; cheap)
 *   3. low-fd loop + /proc retry (handles opendir() == EMFILE)
 *   4. bounded high-fd loop     (last resort; may iterate millions)
 */
static void close_inherited_fds(void) {
#if defined(__NR_close_range) && !defined(SPEC_GUARD_TEST_DISABLE_CLOSE_RANGE)
    long rc = syscall(__NR_close_range, (unsigned int)first_untrusted_fd, ~0U, 0u);
    if (rc == 0) return;
    /* ENOSYS on pre-5.9 kernels, EINVAL on some odd builds. Fall through. */
#endif

    if (close_proc_fds()) return;

    /* If opendir("/proc/self/fd") failed with EMFILE, free low-numbered
     * descriptors first so the retry can open the iterator and discover
     * inherited descriptors above the now-lowered RLIMIT_NOFILE. */
    struct rlimit rl;
    long soft_max = 1024;
    if (getrlimit(RLIMIT_NOFILE, &rl) == 0
        && rl.rlim_cur != RLIM_INFINITY
        && rl.rlim_cur <= 1048576) {
        soft_max = (long)rl.rlim_cur;
    }
    close_fd_loop(3, soft_max - 1);
    if (close_proc_fds()) return;

    /* No usable /proc — uncommon but possible. The current soft/hard limit
     * may already have been lowered below inherited descriptor numbers, so
     * sweep to a conservative cap rather than trusting RLIMIT_NOFILE. */
    close_fd_loop(soft_max, 1048576);
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "usage: spec-guard <command> [args...]\n");
        return 1;
    }

    prctl(PR_SET_SPECULATION_CTRL, PR_SPEC_STORE_BYPASS, PR_SPEC_FORCE_DISABLE, 0, 0);
    prctl(PR_SET_SPECULATION_CTRL, PR_SPEC_INDIRECT_BRANCH, PR_SPEC_FORCE_DISABLE, 0, 0);

    umask(0077);

    int command = 1;
    if (strcmp(argv[1], "--tool-call-pipes") == 0) {
        struct stat writer, reader;
        int write_flags = fcntl(3, F_GETFL), read_flags = fcntl(4, F_GETFL);
        if (argc < 3 || fstat(3, &writer) != 0 || fstat(4, &reader) != 0
            || !S_ISFIFO(writer.st_mode) || !S_ISFIFO(reader.st_mode)
            || write_flags < 0 || read_flags < 0
            || (write_flags & O_ACCMODE) != O_WRONLY
            || (read_flags & O_ACCMODE) != O_RDONLY) {
            fprintf(stderr, "invalid tool-call pipes\n");
            return 1;
        }
        first_untrusted_fd = 5;
        command = 2;
    }
    close_inherited_fds();

    execvp(argv[command], &argv[command]);
    perror("exec");
    return 1;
}
