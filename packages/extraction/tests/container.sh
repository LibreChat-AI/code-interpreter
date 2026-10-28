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
"${compose[@]}" up -d --scale extraction=2 --wait --wait-timeout 30 extraction
mapfile -t ids < <("${compose[@]}" ps -q extraction)
[ "${#ids[@]}" -eq 2 ]
volume="${project}_extraction-token"
network="${project}_extraction"
docker network inspect "$network" | python3 -c 'import json,sys; assert json.load(sys.stdin)[0]["Internal"]'
for id in "${ids[@]}"; do
  # Inspect the shipped recipe, not a relaxed test variant.
  docker inspect "$id" | python3 -c '
import json,sys
c=json.load(sys.stdin)[0]; h=c["HostConfig"]
assert h["ReadonlyRootfs"] and not h["Privileged"]
assert h["CapDrop"] == ["ALL"] and h["PidsLimit"] == 32
assert h["Memory"] == 768*1024*1024 and h["NanoCpus"] == 2*10**9
assert "no-new-privileges:true" in h["SecurityOpt"]
assert c["Config"]["User"] == "10001:10001"
assert c["Config"]["Entrypoint"] == ["/opt/extraction/gateway"]
assert len(c["NetworkSettings"]["Networks"]) == 1 and not h["PortBindings"]
assert len(c["Mounts"]) == 1 and c["Mounts"][0]["Destination"] == "/run/extraction" and not c["Mounts"][0]["RW"]
assert set(h["Tmpfs"]) == {"/jobs"}
for flag in ("noexec", "nosuid", "nodev", "size=96m", "nr_inodes=1024", "uid=10001", "gid=10001", "mode=0700"):
    assert flag in h["Tmpfs"]["/jobs"]
assert not c["Config"].get("ExposedPorts")
print("Shipped Compose mounts, private network, resource limits and security options verified")'
  docker exec "$id" /opt/extraction/gateway node dist/health.js
  docker exec "$id" node -e 'require("node:fs").readdir("/jobs",(e,v)=>{if(e||v.length)process.exit(1)})'
done
# One-shot init is idempotent; arbitrary caller UIDs can read but not write.
before=$(docker exec "${ids[0]}" node -e 'console.log(require("node:fs").statSync("/run/extraction/token").ino)')
"${compose[@]}" run --rm --no-deps extraction-init
after=$(docker exec "${ids[0]}" node -e 'console.log(require("node:fs").statSync("/run/extraction/token").ino)')
[ "$before" = "$after" ]
docker run --rm --user 12345:12345 --network none --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=volume,src=$volume,dst=/run/extraction,readonly" "$image" \
  node --input-type=module -e 'import {readToken} from "/opt/extraction/dist/credential.js"; await readToken(); console.log("Cross-UID credential read verified")'
docker run --rm --init --network "$network" --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=volume,src=$volume,dst=/run/extraction,readonly" "$image" \
  sh -c 'python /tests/gateway.py && node --input-type=module -e '\''import {lookup, resolve4} from "node:dns/promises"; const a=await lookup("extraction", {all:true, family:4}); const b=await resolve4("extraction"); if(a.length !== 2 || b.length !== 2) process.exit(1); console.log("Node IPv4 libc and c-ares DNS qualified for two replicas")'\'' && python /tests/adversarial.py && node /tests/container-client.mjs'
for id in "${ids[@]}"; do
  docker exec "$id" node -e 'require("node:fs").readdir("/jobs",(e,v)=>{if(e||v.length)process.exit(1); console.log("Endpoint scratch cleanup verified")})'
done
# Same outer boundary; the worker independently exercises its stronger filter.
docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges \
  --read-only --memory 768m --cpus 2 --pids-limit 32 \
  --tmpfs /jobs:rw,noexec,nosuid,nodev,size=96m,nr_inodes=1024,uid=10001,gid=10001,mode=0700 \
  --mount "type=volume,src=$volume,dst=/run/extraction,readonly" \
  "$image" node /tests/isolation.mjs
# A test controller without the gateway supplies socket stdio deliberately.
# Both native launchers must reject/remove it before running their target.
docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges \
  --read-only --memory 768m --cpus 2 --pids-limit 32 \
  --tmpfs /jobs:rw,noexec,nosuid,nodev,size=96m,uid=10001,gid=10001,mode=0700 \
  --entrypoint node "$image" /tests/stdio.mjs
# Mandatory isolation unavailable: fail closed, never start unsandboxed.
set +e
docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges \
  --read-only --memory 768m --cpus 2 --pids-limit 32 \
  --tmpfs /jobs:rw,noexec,nosuid,nodev,size=96m,uid=10001,gid=10001,mode=0700 \
  --mount "type=volume,src=$volume,dst=/run/extraction,readonly" \
  "$image" /tests/block-landlock > /dev/null 2>&1
blocked=$?
set -e
if [ "$blocked" -ne 1 ]; then
  printf 'FAIL: missing isolation did not reach fail-closed startup (exit %s)\n' "$blocked" >&2
  exit 1
fi
printf 'Unavailable isolation fails closed\n'
set +e
docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges \
  --read-only --memory 128m --pids-limit 16 \
  "$image" /tests/block-landlock gateway > /dev/null 2>&1
blocked=$?
set -e
[ "$blocked" -eq 125 ]
printf 'Unavailable pre-runtime gateway fails closed\n'
# Restart uses the same credential and fresh per-replica scratch.
for id in "${ids[@]}"; do docker kill -s KILL "$id" >/dev/null; done
"${compose[@]}" up -d --scale extraction=2 --wait --wait-timeout 30 extraction
after=$(docker exec "${ids[0]}" node -e 'console.log(require("node:fs").statSync("/run/extraction/token").ino)')
[ "$before" = "$after" ]
printf 'Hardened two-replica restart and credential persistence passed\n'
