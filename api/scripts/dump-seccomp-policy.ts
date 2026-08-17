/* Renders the seccomp Kafel policy to stdout. Intended for offline
 * verification: pipe into `nsjail --seccomp_string "$(...)"` to confirm
 * Kafel parses it without needing /dev/kvm. Not part of the runtime
 * surface; lives under scripts/ so the build never picks it up. */
import { buildArgs } from '../src/nsjail';

const args = buildArgs({
    logPath: '/tmp/nsjail-test.log',
    pkgdir: '/pkgs/python/3.14.4',
    timeout: 1000,
    memoryLimit: -1,
    envVars: {},
    command: ['/bin/true'],
    identity: { slot: 0, uid: 65534, gid: 65534, perJobUid: false },
});
const idx = args.indexOf('--seccomp_string');
if (idx < 0) {
    console.error('seccomp_string flag not found');
    process.exit(2);
}
process.stdout.write(args[idx + 1]);
