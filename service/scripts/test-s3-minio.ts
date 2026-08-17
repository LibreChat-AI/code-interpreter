/**
 * Test script to verify MinIO SDK connectivity with AWS S3
 *
 * Usage:
 *   npx ts-node scripts/test-s3-minio.ts
 */

import { Client } from 'minio';
import { execSync } from 'child_process';

const TEST_BUCKET =
    process.env.TEST_BUCKET || 'codeapi-irsa-test-' + Date.now();
const REGION = process.env.AWS_REGION || 'us-east-1';

interface AWSCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
}

function getAWSCredentialsFromCLI(): AWSCredentials | null {
    try {
        const accessKeyId = execSync('aws configure get aws_access_key_id', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        const secretAccessKey = execSync(
            'aws configure get aws_secret_access_key',
            {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            },
        ).trim();

        if (!accessKeyId || !secretAccessKey) {
            return null;
        }

        let sessionToken: string | undefined;
        try {
            sessionToken =
                execSync('aws configure get aws_session_token', {
                    encoding: 'utf-8',
                    stdio: ['pipe', 'pipe', 'pipe'],
                }).trim() || undefined;
        } catch {
            // Session token is optional
        }

        return { accessKeyId, secretAccessKey, sessionToken };
    } catch {
        return null;
    }
}

function getCredentialsFromEnv(): AWSCredentials | null {
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        return {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            sessionToken: process.env.AWS_SESSION_TOKEN,
        };
    }
    return null;
}

async function runTests(client: Client, label: string): Promise<boolean> {
    const testObjectKey = `test-object-${Date.now()}.txt`;
    const testContent = `Hello from MinIO SDK test at ${new Date().toISOString()}`;

    try {
        console.log(`[${label}] Listing buckets...`);
        const buckets = await client.listBuckets();
        console.log(`[${label}] Found ${buckets.length} buckets`);

        console.log(`[${label}] Checking/creating bucket: ${TEST_BUCKET}`);
        const bucketExists = await client.bucketExists(TEST_BUCKET);
        if (!bucketExists) {
            await client.makeBucket(TEST_BUCKET, REGION);
            console.log(`[${label}] Created bucket: ${TEST_BUCKET}`);
        } else {
            console.log(`[${label}] Bucket already exists: ${TEST_BUCKET}`);
        }

        console.log(`[${label}] Uploading test object: ${testObjectKey}`);
        await client.putObject(
            TEST_BUCKET,
            testObjectKey,
            Buffer.from(testContent),
        );
        console.log(`[${label}] Upload successful`);

        console.log(`[${label}] Getting object metadata...`);
        const stat = await client.statObject(TEST_BUCKET, testObjectKey);
        console.log(
            `[${label}] Object size: ${stat.size} bytes, ETag: ${stat.etag}`,
        );

        console.log(`[${label}] Downloading object...`);
        const stream = await client.getObject(TEST_BUCKET, testObjectKey);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            chunks.push(chunk as Buffer);
        }
        const downloadedContent = Buffer.concat(chunks).toString('utf-8');

        if (downloadedContent === testContent) {
            console.log(`[${label}] Content verification: PASSED`);
        } else {
            console.log(`[${label}] Content verification: FAILED`);
            return false;
        }

        console.log(`[${label}] Deleting test object...`);
        await client.removeObject(TEST_BUCKET, testObjectKey);
        console.log(`[${label}] Delete successful`);

        console.log(`[${label}] All tests PASSED ✓`);
        return true;
    } catch (err) {
        console.error(`[${label}] Test FAILED:`, err);
        return false;
    }
}

async function main() {
    console.log('MinIO SDK S3 Connectivity Test');
    console.log('==============================');
    console.log(`Region: ${REGION}`);
    console.log(`Test bucket: ${TEST_BUCKET}`);

    let creds = getCredentialsFromEnv();
    if (!creds) {
        console.log('No credentials in environment, trying AWS CLI...');
        creds = getAWSCredentialsFromCLI();
    }

    if (!creds) {
        console.error('ERROR: Could not obtain AWS credentials');
        process.exit(1);
    }

    console.log(
        `Using credentials for: ${creds.accessKeyId.substring(0, 8)}...`,
    );

    const client = new Client({
        endPoint: 's3.amazonaws.com',
        port: 443,
        useSSL: true,
        region: REGION,
        accessKey: creds.accessKeyId,
        secretKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
    });

    const passed = await runTests(client, 'explicit-creds');

    if (passed) {
        console.log('\n==============================');
        console.log('S3 connectivity test PASSED ✓');
        console.log(
            '\nTo test IRSA, run: npx ts-node scripts/test-irsa-simulation.ts',
        );
    } else {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
});
