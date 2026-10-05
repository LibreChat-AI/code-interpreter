#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif

/* Node/Bun extra stdio uses socketpairs. Keep that trusted-side socket in
 * this relay; only two anonymous pipe ends ever reach NsJail/the job.
 * FD 3 in the job writes requests; FD 4 reads responses. */
struct flow {
    int source, destination;
    unsigned char bytes[65536];
    size_t start, length;
};

static int nonblock(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int transfer(struct flow *flow, short readable, short writable) {
    if (writable && flow->length) {
        ssize_t n = write(flow->destination, flow->bytes + flow->start, flow->length);
        if (n > 0) {
            flow->start += (size_t)n;
            flow->length -= (size_t)n;
            if (!flow->length) flow->start = 0;
        } else if (n < 0 && errno != EINTR && errno != EAGAIN) return -1;
    }
    if (flow->source >= 0 && readable && !flow->length) {
        ssize_t n = read(flow->source, flow->bytes, sizeof(flow->bytes));
        if (n > 0) flow->length = (size_t)n;
        else if (n == 0) flow->source = -1;
        else if (errno != EINTR && errno != EAGAIN) return -1;
    }
    return 0;
}

static int parent_death(pid_t parent) {
#ifdef __linux__
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) return -1;
#endif
    return getppid() == parent ? 0 : -1;
}

int main(int argc, char **argv) {
    if (argc < 2) return 125;
    pid_t broker = getppid();
    if (parent_death(broker) != 0) return 125;
    /* The API also enters here to exec Node with a parent-death signal.
     * Without this, an API crash could orphan a still-running broker. */
    if (strcmp(argv[1], "--broker") == 0) {
        if (argc < 3) return 125;
        execvp(argv[2], &argv[2]);
        perror("tool-call broker exec");
        return 125;
    }
    int ipc = fcntl(3, F_DUPFD_CLOEXEC, 5);
    int requests[2], responses[2];
    if (ipc < 0 || pipe(requests) != 0 || pipe(responses) != 0) return 125;
    pid_t relay = getpid();
    pid_t child = fork();
    if (child < 0) return 125;
    if (child == 0) {
        if (parent_death(relay) != 0 || dup2(requests[1], 3) < 0
            || dup2(responses[0], 4) < 0) _exit(125);
        int fds[] = {ipc, requests[0], requests[1], responses[0], responses[1]};
        for (unsigned i = 0; i < sizeof(fds) / sizeof(fds[0]); i++) {
            if (fds[i] > 4) close(fds[i]);
        }
        execvp(argv[1], &argv[1]);
        perror("tool-call pipe exec");
        _exit(125);
    }
    close(3);
    close(requests[1]);
    close(responses[0]);
    signal(SIGPIPE, SIG_IGN);
    if (nonblock(ipc) < 0 || nonblock(requests[0]) < 0 || nonblock(responses[1]) < 0) {
        kill(child, SIGKILL);
        waitpid(child, NULL, 0);
        return 125;
    }
    struct flow request = {.source = requests[0], .destination = ipc};
    struct flow response = {.source = ipc, .destination = responses[1]};
    int status = 125 << 8;
    for (;;) {
        pid_t done = waitpid(child, &status, WNOHANG);
        if (done == child) break;
        if (done < 0 && errno != EINTR) return 125;
        struct pollfd pollfds[] = {
            {.fd = ipc, .events = (response.length || response.source < 0 ? 0 : POLLIN) | (request.length ? POLLOUT : 0)},
            {.fd = request.source, .events = request.length ? 0 : POLLIN},
            {.fd = responses[1], .events = response.length ? POLLOUT : 0},
        };
        int result = poll(pollfds, 3, 100);
        if (result < 0 && errno == EINTR) continue;
        if (result < 0 || (pollfds[0].revents & (POLLERR | POLLNVAL))
            || (pollfds[1].revents & (POLLERR | POLLNVAL))
            || (pollfds[2].revents & (POLLERR | POLLHUP | POLLNVAL))
            || transfer(&request, pollfds[1].revents & (POLLIN | POLLHUP), pollfds[0].revents & POLLOUT) < 0
            || transfer(&response, pollfds[0].revents & (POLLIN | POLLHUP), pollfds[2].revents & POLLOUT) < 0 || response.source < 0) {
            /* EOF/error terminates the entire invocation, including an
             * abandoned tool call. Never leave an orphaned NsJail monitor. */
            if (waitpid(child, &status, WNOHANG) == child) break;
            kill(child, SIGKILL);
            while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
            break;
        }
    }
    close(ipc);
    close(requests[0]);
    close(responses[1]);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
