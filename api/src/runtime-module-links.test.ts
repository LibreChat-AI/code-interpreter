import { expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from './config';
import { ensureNodeModulesSymlink } from './job';

function fixture(
    run: (workspace: string, packages: string, modules: string) => void
): void {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'runtime-module-links-')
    );
    const originalPackages = config.packages_directory;
    const workspace = path.join(root, 'workspace');
    const packages = path.join(root, 'pkgs');
    const modules = path.join(packages, 'node', '24.22.1', 'node_modules');
    fs.mkdirSync(workspace);
    fs.mkdirSync(modules, { recursive: true });
    config.packages_directory = packages;
    try {
        run(workspace, packages, modules);
    } finally {
        config.packages_directory = originalPackages;
        fs.rmSync(root, { recursive: true, force: true });
    }
}

const managers = [
    {
        name: 'bash job preparation',
        prepare: ensureNodeModulesSymlink,
    },
];
for (const file of ['build-packages.sh', 'docker/package-init.sh']) {
    const source = fs
        .readFileSync(path.resolve(__dirname, '../..', file), 'utf8')
        .replace(/\\(["$])/g, '$1');
    const launchers =
        source.match(/MODULE_DIR=.*\nif \[ -d [\s\S]*?\nfi/g) ?? [];
    expect(launchers).toHaveLength(2);
    for (const [index, launcher] of launchers.entries()) {
        managers.push({
            name: `${file} ${index === 0 ? 'Node' : 'Bun'} launcher`,
            prepare(workspace: string, modules?: string): void {
                const link = path.join(workspace, 'node_modules');
                const script = `SCRIPT_DIR=$1\n${launcher
                    .split('/mnt/data/node_modules')
                    .join('"$2"')}`;
                const result = Bun.spawnSync({
                    cmd: [
                        'bash',
                        '-c',
                        script,
                        'runtime-launcher',
                        path.dirname(modules!),
                        link,
                    ],
                });
                expect(result.exitCode).toBe(0);
            },
        });
    }
}

for (const manager of managers) {
    test(`${manager.name}: links bundled modules into a fresh workspace`, () => {
        fixture((workspace, _packages, modules) => {
            manager.prepare(workspace, modules);
            expect(fs.readlinkSync(path.join(workspace, 'node_modules'))).toBe(
                modules
            );
        });
    });

    for (const oldRuntimeExists of [false, true]) {
        test(`${manager.name}: refreshes a ${
            oldRuntimeExists ? 'retained' : 'removed'
        } runtime link`, () => {
            fixture((workspace, packages, modules) => {
                const oldModules = path.join(
                    packages,
                    'node',
                    '24.15.0',
                    'node_modules'
                );
                if (oldRuntimeExists)
                    fs.mkdirSync(oldModules, { recursive: true });
                fs.symlinkSync(
                    oldModules,
                    path.join(workspace, 'node_modules')
                );
                manager.prepare(workspace, modules);
                expect(
                    fs.readlinkSync(path.join(workspace, 'node_modules'))
                ).toBe(modules);
            });
        });
    }

    test(`${manager.name}: leaves the current runtime link unchanged`, () => {
        fixture((workspace, _packages, modules) => {
            const link = path.join(workspace, 'node_modules');
            fs.symlinkSync(modules, link);
            const inode = fs.lstatSync(link).ino;
            manager.prepare(workspace, modules);
            expect(fs.lstatSync(link).ino).toBe(inode);
        });
    });

    test(`${manager.name}: preserves a user-managed directory`, () => {
        fixture((workspace, _packages, modules) => {
            const link = path.join(workspace, 'node_modules');
            fs.mkdirSync(link);
            fs.writeFileSync(path.join(link, 'user-package'), 'keep');
            manager.prepare(workspace, modules);
            expect(
                fs.readFileSync(path.join(link, 'user-package'), 'utf8')
            ).toBe('keep');
        });
    });

    test(`${manager.name}: preserves a valid user link sharing the package-root prefix`, () => {
        fixture((workspace, packages, modules) => {
            const target = `${packages}-other/node_modules`;
            const link = path.join(workspace, 'node_modules');
            fs.mkdirSync(target, { recursive: true });
            fs.symlinkSync(target, link);
            manager.prepare(workspace, modules);
            expect(fs.readlinkSync(link)).toBe(target);
        });
    });

    test(`${manager.name}: preserves a user link with a package-root traversal`, () => {
        fixture((workspace, packages, modules) => {
            const target = `${packages}/../user/node_modules`;
            const link = path.join(workspace, 'node_modules');
            fs.mkdirSync(path.resolve(target), { recursive: true });
            fs.symlinkSync(target, link);
            manager.prepare(workspace, modules);
            expect(fs.readlinkSync(link)).toBe(target);
        });
    });

    for (const target of [
        '../user/node_modules',
        '../pkgs-other/node_modules',
    ]) {
        test(`${manager.name}: preserves user link ${target}`, () => {
            fixture((workspace, _packages, modules) => {
                const link = path.join(workspace, 'node_modules');
                fs.symlinkSync(target, link);
                manager.prepare(workspace, modules);
                expect(fs.readlinkSync(link)).toBe(target);
            });
        });
    }
}

test('restored Node sessions resolve ESM packages after the old runtime is removed', () => {
    fixture((workspace, packages, modules) => {
        const oldModules = path.join(
            packages,
            'node',
            '24.15.0',
            'node_modules'
        );
        fs.symlinkSync(oldModules, path.join(workspace, 'node_modules'));
        const archive = path.join(path.dirname(workspace), 'checkpoint.tar');
        expect(
            Bun.spawnSync({
                cmd: ['tar', '-cf', archive, '-C', workspace, '.'],
            }).exitCode
        ).toBe(0);
        fs.rmSync(workspace, { recursive: true });
        fs.mkdirSync(workspace);
        expect(
            Bun.spawnSync({ cmd: ['tar', '-xf', archive, '-C', workspace] })
                .exitCode
        ).toBe(0);
        const pkg = path.join(modules, 'runtime-fixture');
        fs.mkdirSync(pkg);
        fs.writeFileSync(
            path.join(pkg, 'package.json'),
            JSON.stringify({ type: 'module', exports: './index.js' })
        );
        fs.writeFileSync(
            path.join(pkg, 'index.js'),
            'export default "upgraded";'
        );

        ensureNodeModulesSymlink(workspace, modules);

        const result = Bun.spawnSync({
            cmd: [
                process.env.NODE_RUNTIME_TEST_BINARY ?? 'node',
                '--input-type=module',
                '-e',
                'import value from "runtime-fixture"; console.log(value);',
            ],
            cwd: workspace,
        });
        expect(result.stderr.toString()).toBe('');
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString().trim()).toBe('upgraded');
    });
});
