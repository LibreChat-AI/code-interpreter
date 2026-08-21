#!/bin/bash
set -euo pipefail

if [ "$#" -lt 5 ]; then
  echo "usage: hosted-app-launcher <cgroup> <uid> <gid> <command> [args...]" >&2
  exit 64
fi

CGROUP_PATH="$1"
APP_UID="$2"
APP_GID="$3"
shift 3

# This wrapper starts as root, joins the root-owned cgroup before any user code
# can fork, then irreversibly drops identity and capabilities. App descendants
# inherit the cgroup even if they daemonize or create a new process group.
printf '%s' "$$" > "${CGROUP_PATH}/cgroup.procs"
exec /usr/bin/setpriv \
  --reuid "$APP_UID" \
  --regid "$APP_GID" \
  --clear-groups \
  --inh-caps=-all \
  --ambient-caps=-all \
  --bounding-set=-all \
  -- "$@"
