import { Client, type ClientOptions } from 'minio';
import logger from './fileServerLogger';

type IamProviderModule = { IamAwsProvider?: new (opts: object) => unknown; default?: new (opts: object) => unknown };

export async function createMinioClient(): Promise<Client> {
  const irsaExplicit = process.env.MINIO_USE_IRSA?.toLowerCase() === 'true';
  const irsaEnvVars = Boolean(process.env.AWS_WEB_IDENTITY_TOKEN_FILE) && Boolean(process.env.AWS_ROLE_ARN);
  const useIrsa = irsaExplicit || irsaEnvVars;

  const baseConfig: ClientOptions = {
    // Unknown-length streams otherwise grow SDK parts to 528 MiB (the 5 TiB
    // object limit / 10,000 parts). Bound each multipart buffer instead.
    partSize: 8 * 1024 * 1024,
    endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
    port: process.env.MINIO_NO_PORT?.toLowerCase() === 'true' ? undefined : parseInt(process.env.MINIO_PORT ?? '9000'),
    useSSL: process.env.MINIO_USE_SSL?.toLowerCase() === 'true',
    region: process.env.MINIO_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  };

  if (useIrsa) {
    logger.info('Using IRSA (IamAwsProvider) for S3 authentication', {
      tokenFile: process.env.AWS_WEB_IDENTITY_TOKEN_FILE,
      roleArn: process.env.AWS_ROLE_ARN,
      region: baseConfig.region,
    });

    /** IamAwsProvider exists in minio 8.0.6+ but isn't exported from main module
     * Try multiple import paths for compatibility with different runtimes (bun, ts-node, node)
     */
    let IamAwsProviderClass: new (opts: object) => unknown;
    try {
      const mod = await import('minio/dist/main/IamAwsProvider.js') as IamProviderModule;
      IamAwsProviderClass = (mod.IamAwsProvider ?? mod.default)!;
    } catch (primaryError) {
      try {
        // Fallback for bun: resolve path using require if available (CJS context)
        let resolvePath = 'node_modules/minio/';
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          resolvePath = require.resolve('minio').replace(/dist\/.*$/, '');
        } catch {
          // require.resolve not available (ESM context), use default path
        }
        const mod = await import(`${resolvePath}dist/main/IamAwsProvider.js`) as IamProviderModule;
        IamAwsProviderClass = (mod.IamAwsProvider ?? mod.default)!;
      } catch (fallbackError) {
        logger.error('Failed to load IamAwsProvider', { primaryError, fallbackError });
        throw new Error('Could not load IamAwsProvider for IRSA authentication. Ensure minio >= 8.0.6 is installed.');
      }
    }

    const credentialsProvider = new IamAwsProviderClass({});

    return new Client({
      ...baseConfig,
      credentialsProvider: credentialsProvider as ClientOptions['credentialsProvider'],
    });
  }

  logger.info('Using explicit credentials for MinIO/S3 authentication');
  return new Client({
    ...baseConfig,
    accessKey: process.env.MINIO_ACCESS_KEY ?? '',
    secretKey: process.env.MINIO_SECRET_KEY ?? '',
    sessionToken: process.env.MINIO_SESSION_TOKEN,
  });
}

