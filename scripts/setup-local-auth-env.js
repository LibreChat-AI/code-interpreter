const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
} = require('crypto');

const DEFAULT_KID = 'lc-codeapi-local-2026-05';
const DEFAULT_LIBRECHAT_REPO = path.join(os.homedir(), 'LibreChat');
const DEFAULT_PROVIDER = 'librechat-jwt';

function usage() {
    console.log(`
Usage:
  node services/codeapi/scripts/setup-local-auth-env.js [options]

Options:
  --librechat <path>       LibreChat repo path (default: ~/LibreChat)
  --librechat-env <path>   LibreChat .env path override
  --codeapi-env <path>     CodeAPI .env path override (default: services/codeapi/.env)
  --provider <mode>        librechat-jwt (default: librechat-jwt)
  --base-url <url>         LibreChat CodeAPI base URL (default: http://localhost:3112/v1)
  --help, -h              Show this help
`);
}

function expandHome(value) {
    if (!value || value === '~') {
        return os.homedir();
    }
    if (value.startsWith('~/')) {
        return path.join(os.homedir(), value.slice(2));
    }
    return value;
}

function parseArgs(argv) {
    const out = {
        librechatRepo: DEFAULT_LIBRECHAT_REPO,
        provider: DEFAULT_PROVIDER,
        baseUrl: 'http://localhost:3112/v1',
    };

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            usage();
            process.exit(0);
        }
        if (arg === '--librechat') {
            out.librechatRepo = expandHome(argv[++i]);
        } else if (arg === '--librechat-env') {
            out.librechatEnv = expandHome(argv[++i]);
        } else if (arg === '--codeapi-env') {
            out.codeApiEnv = expandHome(argv[++i]);
        } else if (arg === '--provider') {
            out.provider = argv[++i];
        } else if (arg === '--base-url') {
            out.baseUrl = argv[++i];
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    if (out.provider !== 'librechat-jwt') {
        throw new Error('--provider must be "librechat-jwt"');
    }

    return out;
}

function parseEnv(text) {
    const env = {};
    for (const line of text.split(/\r?\n/)) {
        const match =
            /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);
        if (!match) {
            continue;
        }
        let value = match[2] ?? '';
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        env[match[1]] = value;
    }
    return env;
}

function readEnvFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return { text: '', env: {} };
    }
    const text = fs.readFileSync(filePath, 'utf8');
    return { text, env: parseEnv(text) };
}

function updateEnvText(text, updates) {
    let next = text;
    for (const [key, value] of Object.entries(updates)) {
        const line = `${key}=${value}`;
        const re = new RegExp(`^\\s*(?:export\\s+)?${key}=.*$`, 'm');
        next = re.test(next)
            ? next.replace(re, line)
            : `${next.replace(/\s*$/, '\n')}${line}\n`;
    }
    return next;
}

function writeEnvFile(filePath, text) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text);
}

function parseJsonKey(value, name) {
    try {
        return JSON.parse(value);
    } catch (error) {
        throw new Error(`${name} is not valid JSON: ${error.message}`);
    }
}

function normalizePem(value) {
    return value.replace(/\\n/g, '\n').trim();
}

function inferAlgorithm(keyObject, fallback = 'EdDSA') {
    if (keyObject.asymmetricKeyType === 'rsa') {
        return 'RS256';
    }
    if (keyObject.asymmetricKeyType === 'ed25519') {
        return 'EdDSA';
    }
    return fallback;
}

function resolveSigningMaterial(librechatEnv) {
    const kid =
        librechatEnv.CODEAPI_JWT_KID ||
        librechatEnv.CODEAPI_JWT_KEY_ID ||
        DEFAULT_KID;

    if (librechatEnv.CODEAPI_JWT_PRIVATE_JWK_JSON) {
        const privateJwk = parseJsonKey(
            librechatEnv.CODEAPI_JWT_PRIVATE_JWK_JSON,
            'CODEAPI_JWT_PRIVATE_JWK_JSON',
        );
        const keyObject = createPrivateKey({ key: privateJwk, format: 'jwk' });
        const alg =
            librechatEnv.CODEAPI_JWT_ALGORITHM || inferAlgorithm(keyObject);
        const publicJwk = createPublicKey(keyObject).export({ format: 'jwk' });
        return {
            alg,
            kid,
            privateJwk: { ...privateJwk, kid, alg },
            publicJwk: { ...publicJwk, kid, alg },
            generated: false,
        };
    }

    const pem =
        librechatEnv.CODEAPI_JWT_PRIVATE_KEY ||
        (librechatEnv.CODEAPI_JWT_PRIVATE_KEY_BASE64
            ? Buffer.from(
                  librechatEnv.CODEAPI_JWT_PRIVATE_KEY_BASE64,
                  'base64',
              ).toString('utf8')
            : undefined);

    if (pem) {
        const keyObject = createPrivateKey(normalizePem(pem));
        const alg =
            librechatEnv.CODEAPI_JWT_ALGORITHM || inferAlgorithm(keyObject);
        const publicJwk = createPublicKey(keyObject).export({ format: 'jwk' });
        return {
            alg,
            kid,
            publicJwk: { ...publicJwk, kid, alg },
            generated: false,
        };
    }

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const privateJwk = privateKey.export({ format: 'jwk' });
    const publicJwk = publicKey.export({ format: 'jwk' });
    return {
        alg: 'EdDSA',
        kid,
        privateJwk: { ...privateJwk, kid, alg: 'EdDSA' },
        publicJwk: { ...publicJwk, kid, alg: 'EdDSA' },
        generated: true,
    };
}

function manifestPrivateKeyFromEnv(value) {
    const normalized = normalizePem(value);
    if (normalized.includes('BEGIN ')) {
        return createPrivateKey(normalized);
    }
    return createPrivateKey({
        key: Buffer.from(normalized, 'base64'),
        format: 'der',
        type: 'pkcs8',
    });
}

function resolveExecutionManifestMaterial(codeApiEnv) {
    const existingPrivateKey =
        process.env.CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY ||
        codeApiEnv.CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY;

    if (existingPrivateKey) {
        const publicKey =
            process.env.SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY ||
            codeApiEnv.SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY ||
            createPublicKey(manifestPrivateKeyFromEnv(existingPrivateKey))
                .export({ type: 'spki', format: 'der' })
                .toString('base64');
        return {
            privateKey: existingPrivateKey,
            publicKey,
            generated: false,
        };
    }

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
        privateKey: privateKey
            .export({ type: 'pkcs8', format: 'der' })
            .toString('base64'),
        publicKey: publicKey
            .export({ type: 'spki', format: 'der' })
            .toString('base64'),
        generated: true,
    };
}

function main() {
    const args = parseArgs(process.argv);
    const repoRoot = path.resolve(__dirname, '..');
    const codeApiEnvPath = path.resolve(
        args.codeApiEnv || path.join(repoRoot, '.env'),
    );
    const librechatRepo = path.resolve(args.librechatRepo);
    const librechatEnvPath = path.resolve(
        args.librechatEnv || path.join(librechatRepo, '.env'),
    );

    const librechatFile = readEnvFile(librechatEnvPath);
    const signing = resolveSigningMaterial(librechatFile.env);
    const issuer = librechatFile.env.CODEAPI_JWT_ISSUER || 'librechat';
    const audience = librechatFile.env.CODEAPI_JWT_AUDIENCE || 'codeapi';
    const codeApiFile = readEnvFile(codeApiEnvPath);
    const executionManifest = resolveExecutionManifestMaterial(codeApiFile.env);
    const singleTenantId =
        librechatFile.env.CODEAPI_JWT_SINGLE_TENANT_ID ||
        codeApiFile.env.CODEAPI_JWT_SINGLE_TENANT_ID ||
        'legacy';

    const librechatUpdates = {
        LIBRECHAT_CODE_BASEURL: args.baseUrl,
        CODEAPI_AUTH_PROVIDER: args.provider,
        CODEAPI_JWT_ALGORITHM: signing.alg,
        CODEAPI_JWT_KID: signing.kid,
        CODEAPI_JWT_ISSUER: issuer,
        CODEAPI_JWT_AUDIENCE: audience,
        CODEAPI_JWT_TTL_SECONDS: '300',
        CODEAPI_JWT_MINT_CACHE_SECONDS: '30',
        CODEAPI_JWT_SINGLE_TENANT_ID: singleTenantId,
        OPENID_REUSE_TOKENS: 'true',
    };

    if (signing.privateJwk) {
        librechatUpdates.CODEAPI_JWT_PRIVATE_JWK_JSON = JSON.stringify(
            signing.privateJwk,
        );
    }

    const codeApiUpdates = {
        LOCAL_MODE: 'false',
        CODEAPI_AUTH_PROVIDER: args.provider,
        CODEAPI_JWT_ISSUER: issuer,
        CODEAPI_JWT_AUDIENCE: audience,
        CODEAPI_JWT_ALLOWED_ALGS: signing.alg,
        CODEAPI_JWT_CLOCK_SKEW_SECONDS: '30',
        CODEAPI_JWT_MAX_TTL_SECONDS: '300',
        CODEAPI_JWT_KEY_CACHE_TTL_SECONDS: '30',
        CODEAPI_JWT_JWKS_JSON: JSON.stringify({ keys: [signing.publicJwk] }),
        CODEAPI_JWT_SINGLE_TENANT_ID: singleTenantId,
        CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY: executionManifest.privateKey,
        SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY: executionManifest.publicKey,
    };

    writeEnvFile(
        librechatEnvPath,
        updateEnvText(librechatFile.text, librechatUpdates),
    );
    writeEnvFile(
        codeApiEnvPath,
        updateEnvText(codeApiFile.text, codeApiUpdates),
    );

    console.log(`Updated LibreChat env: ${librechatEnvPath}`);
    console.log(`Updated CodeAPI env: ${codeApiEnvPath}`);
    console.log(`Provider: ${args.provider}`);
    console.log(`kid: ${signing.kid}`);
    if (signing.generated) {
        console.log('Generated a new local Ed25519 signing key for LibreChat.');
    }
    if (executionManifest.generated) {
        console.log(
            'Generated a new local Ed25519 execution-manifest keypair for CodeAPI.',
        );
    }
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
