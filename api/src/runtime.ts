import * as fs from 'fs';
import * as path from 'path';
import * as semver from 'semver';
import { config } from './config';
import { logger } from './logger';

interface RuntimeLimits {
    timeouts: { compile: number; run: number };
    cpu_times: { compile: number; run: number };
    memory_limits: { compile: number; run: number };
    max_process_count: number;
    max_open_files: number;
    max_file_size: number;
    output_max_size: number;
}

export interface Runtime extends RuntimeLimits {
    language: string;
    version: semver.SemVer;
    aliases: string[];
    pkgdir: string;
    runtime?: string;
    compiled: boolean;
    env_vars: Record<string, string>;
}

const runtimes: Runtime[] = [];

function computeSingleLimit(
    languageName: string,
    limitName: string,
    languageLimitOverrides?: Record<string, number>,
): number {
    return (
        config.limit_overrides[languageName]?.[limitName] ??
        languageLimitOverrides?.[limitName] ??
        ((config as Record<string, unknown>)[limitName] as number)
    );
}

function computeAllLimits(
    languageName: string,
    languageLimitOverrides?: Record<string, number>,
): RuntimeLimits {
    return {
        timeouts: {
            compile: computeSingleLimit(
                languageName,
                'compile_timeout',
                languageLimitOverrides,
            ),
            run: computeSingleLimit(
                languageName,
                'run_timeout',
                languageLimitOverrides,
            ),
        },
        cpu_times: {
            compile: computeSingleLimit(
                languageName,
                'compile_cpu_time',
                languageLimitOverrides,
            ),
            run: computeSingleLimit(
                languageName,
                'run_cpu_time',
                languageLimitOverrides,
            ),
        },
        memory_limits: {
            compile: computeSingleLimit(
                languageName,
                'compile_memory_limit',
                languageLimitOverrides,
            ),
            run: computeSingleLimit(
                languageName,
                'run_memory_limit',
                languageLimitOverrides,
            ),
        },
        max_process_count: computeSingleLimit(
            languageName,
            'max_process_count',
            languageLimitOverrides,
        ),
        max_open_files: computeSingleLimit(
            languageName,
            'max_open_files',
            languageLimitOverrides,
        ),
        max_file_size: computeSingleLimit(
            languageName,
            'max_file_size',
            languageLimitOverrides,
        ),
        output_max_size: computeSingleLimit(
            languageName,
            'output_max_size',
            languageLimitOverrides,
        ),
    };
}

function loadEnvVars(packageDir: string): Record<string, string> {
    const envFile = path.join(packageDir, '.env');
    const envVars: Record<string, string> = {};
    if (!fs.existsSync(envFile)) return envVars;

    const content = fs.readFileSync(envFile, 'utf8');
    for (let line of content.trim().split('\n')) {
        line = line.replace(/^export\s+/, '');
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        if (key) envVars[key] = val;
    }
    return envVars;
}

export function loadPackage(packageDir: string): void {
    const infoPath = path.join(packageDir, 'pkg-info.json');
    if (!fs.existsSync(infoPath)) {
        logger.warn({ packageDir }, 'Missing pkg-info.json');
        return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let info: any;
    try {
        info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    } catch (err) {
        logger.warn({ packageDir, err }, 'Failed to parse pkg-info.json');
        return;
    }
    const { language, version, aliases, provides, limit_overrides } = info;
    const parsedVersion = semver.parse(version);
    if (!parsedVersion) {
        logger.warn({ version, packageDir }, 'Failed to parse version');
        return;
    }

    const compiled = fs.existsSync(path.join(packageDir, 'compile'));
    const envVars = loadEnvVars(packageDir);

    if (provides && Array.isArray(provides)) {
        for (const lang of provides) {
            runtimes.push({
                language: lang.language,
                aliases: lang.aliases ?? [],
                version: parsedVersion,
                pkgdir: packageDir,
                runtime: language,
                compiled,
                env_vars: envVars,
                ...computeAllLimits(lang.language, lang.limit_overrides),
            });
        }
    } else {
        runtimes.push({
            language,
            version: parsedVersion,
            aliases: aliases ?? [],
            pkgdir: packageDir,
            compiled,
            env_vars: envVars,
            ...computeAllLimits(language, limit_overrides),
        });
    }

    logger.info({ language, version }, 'Loaded package');
}

export function getLatestRuntimeMatchingLanguageVersion(
    lang: string,
    ver: string,
): Runtime | undefined {
    return runtimes
        .filter(
            rt =>
                (rt.language === lang || rt.aliases.includes(lang)) &&
                semver.satisfies(rt.version, ver),
        )
        .sort((a, b) => semver.rcompare(a.version, b.version))[0];
}

export function getRuntimes(): Runtime[] {
    return runtimes;
}

const INSTALLED_MARKER = '.package-installed';

export function loadPackages(packagesDirectory: string): void {
    const pkgdir = packagesDirectory;
    if (!fs.existsSync(pkgdir)) {
        logger.warn({ pkgdir }, 'Package directory does not exist');
        return;
    }

    for (const lang of fs.readdirSync(pkgdir)) {
        const langDir = path.join(pkgdir, lang);
        if (!fs.statSync(langDir).isDirectory()) continue;

        for (const ver of fs.readdirSync(langDir)) {
            const verDir = path.join(langDir, ver);
            if (!fs.statSync(verDir).isDirectory()) continue;
            if (fs.existsSync(path.join(verDir, INSTALLED_MARKER))) {
                loadPackage(verDir);
            }
        }
    }
}
