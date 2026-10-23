#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
run_id=$(node -e 'console.log(require("node:crypto").randomUUID())')
project="extraction-test-$run_id"
image="librechat-extraction-test:$run_id"
export EXTRACTION_IMAGE="librechat-extraction:$run_id"
compose=(docker compose -p "$project" -f packages/extraction/compose.yaml)
cleanup() {
  "${compose[@]}" down -v --remove-orphans >/dev/null
  docker image rm "$image" "$EXTRACTION_IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT
"${compose[@]}" build extraction
docker build --target qualification -t "$image" -f packages/extraction/Dockerfile .
"${compose[@]}" up -d --wait --wait-timeout 30 extraction
id=$("${compose[@]}" ps -q extraction)
volume="${project}_extraction-socket"
# Inspect exactly the shipped recipe, not a relaxed test variant.
docker inspect "$id" | python3 -c '
import json,sys
c=json.load(sys.stdin)[0]; h=c["HostConfig"]
assert h["NetworkMode"] == "none" and h["ReadonlyRootfs"] and not h["Privileged"]
assert h["CapDrop"] == ["ALL"] and h["PidsLimit"] == 32
assert h["Memory"] == 768*1024*1024 and h["NanoCpus"] == 2*10**9
assert "no-new-privileges:true" in h["SecurityOpt"]
assert c["Config"]["User"] == "10001:10001"
assert len(c["Mounts"]) == 1 and c["Mounts"][0]["Destination"] == "/socket"
assert set(h["Tmpfs"]) == {"/jobs"}
for flag in ("noexec", "nosuid", "nodev", "size=96m", "nr_inodes=1024", "uid=10001", "gid=10001", "mode=0700"):
    assert flag in h["Tmpfs"]["/jobs"]
assert not c["Config"]["ExposedPorts"] if "ExposedPorts" in c["Config"] else True
print("Shipped Compose mounts, resource limits and security options verified")'
docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=volume,src=$volume,dst=/socket,readonly" "$image" \
  sh -c 'python /tests/adversarial.py && node /tests/container-client.mjs'
docker exec "$id" node -e 'require("node:fs").readdir("/jobs",(e,v)=>{if(e||v.length)process.exit(1); console.log("Endpoint scratch cleanup verified")})'
# Same outer boundary, with a test-only worker that attempts forbidden operations.
docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges \
  --read-only --memory 768m --cpus 2 --pids-limit 32 \
  --tmpfs /jobs:rw,noexec,nosuid,nodev,size=96m,nr_inodes=1024,uid=10001,gid=10001,mode=0700 \
  --tmpfs /socket:rw,noexec,nosuid,nodev,size=1m,uid=10001,gid=10001,mode=0700 \
  "$image" node /tests/isolation.mjs
# Denying the mandatory isolation syscall must fail closed, never start unsandboxed.
set +e
docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges \
  --read-only --memory 768m --cpus 2 --pids-limit 32 \
  --tmpfs /jobs:rw,noexec,nosuid,nodev,size=96m,uid=10001,gid=10001,mode=0700 \
  --tmpfs /socket:rw,noexec,nosuid,nodev,size=1m,uid=10001,gid=10001,mode=0700 \
  "$image" /tests/block-landlock > /dev/null 2>&1
blocked=$?
set -e
if [ "$blocked" -ne 1 ]; then
  printf 'FAIL: missing isolation did not reach fail-closed startup (exit %s)\n' "$blocked" >&2
  exit 1
fi
printf 'Unavailable isolation fails closed\n'
# A stale socket left by SIGKILL must not prevent a safe restart.
docker kill -s KILL "$id" >/dev/null
"${compose[@]}" up -d --wait --wait-timeout 30 extraction
printf 'Hardened container restart passed\n'
