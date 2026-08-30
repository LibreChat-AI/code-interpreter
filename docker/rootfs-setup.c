#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

static int bind_mount(const char *source, const char *target, int read_only) {
  if (mount(source, target, NULL, MS_BIND | MS_REC, NULL) != 0) {
    fprintf(stderr, "bind %s -> %s failed: %s\n", source, target, strerror(errno));
    return -1;
  }

  if (read_only &&
      mount(NULL, target, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY, NULL) != 0) {
    fprintf(stderr, "read-only remount of %s failed: %s\n", target, strerror(errno));
    return -1;
  }

  return 0;
}

static int bind_rootfs_path(const char *rootfs, const char *path) {
  char source[PATH_MAX];
  int written = snprintf(source, sizeof(source), "%s%s", rootfs, path);
  if (written < 0 || (size_t)written >= sizeof(source)) {
    fprintf(stderr, "rootfs path is too long: %s%s\n", rootfs, path);
    return -1;
  }

  return bind_mount(source, path, 1);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: sandbox-rootfs-setup ROOTFS [COMMAND ...]\n");
    return 2;
  }

  const char *rootfs = argv[1];
  if (rootfs[0] != '/') {
    fprintf(stderr, "rootfs must be an absolute path\n");
    return 2;
  }

  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) {
    fprintf(stderr, "making the mount namespace private failed: %s\n", strerror(errno));
    return 1;
  }

  if ((mkdir("/sandbox_api", 0755) != 0 && errno != EEXIST) ||
      (mkdir("/pkgs", 0755) != 0 && errno != EEXIST)) {
    fprintf(stderr, "creating rootfs mount targets failed: %s\n", strerror(errno));
    return 1;
  }

  /*
   * Keep this process statically linked: the final /usr mount replaces
   * the Fedora launcher's dynamic userspace with the Debian sandbox rootfs.
   * A shell cannot safely perform this sequence because its next command may
   * try to load a host binary against guest libraries (or vice versa).
   */
  const char *paths[] = {"/sandbox_api", "/pkgs"};
  for (size_t i = 0; i < sizeof(paths) / sizeof(paths[0]); i++) {
    if (bind_rootfs_path(rootfs, paths[i]) != 0) {
      return 1;
    }
  }

  if (access("/host-packages", F_OK) == 0 &&
      bind_mount("/host-packages", "/pkgs", 0) != 0) {
    fprintf(stderr, "warning: sandbox will run without host packages\n");
  }

  /* Bind all guest userspace last, then immediately enter it. */
  if (bind_rootfs_path(rootfs, "/usr") != 0) {
    return 1;
  }

  setenv("PATH", "/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", 1);
  setenv("LD_LIBRARY_PATH", "/usr/lib/aarch64-linux-gnu:/usr/lib/x86_64-linux-gnu", 1);

  setenv("NSJAIL_PATH", "/usr/sbin/nsjail", 1);

  char *default_argv[] = {"/sandbox_api/entrypoint.sh", NULL};
  char **command_argv = argc > 2 ? &argv[2] : default_argv;
  execv(command_argv[0], command_argv);
  fprintf(stderr, "starting sandbox entrypoint failed: %s\n", strerror(errno));
  return 1;
}
