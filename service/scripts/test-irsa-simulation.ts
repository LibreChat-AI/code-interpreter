/**
 * IRSA (IAM Roles for Service Accounts) Simulation Test
 *
 * This script simulates the IRSA authentication flow locally by:
 * 1. Creating an IAM role with S3 access (if needed)
 * 2. Using AssumeRole to get temporary credentials (simulates what IRSA does)
 * 3. Testing the MinIO SDK with those temporary credentials
 *
 * This validates that the credential refresh flow works correctly before
 * deploying to EKS with actual IRSA.
 *
 * Usage:
 *   npx ts-node scripts/test-irsa-simulation.ts
 *
 * Prerequisites:
 *   - AWS CLI configured with permissions to create IAM roles
 *   - Or set IRSA_ROLE_ARN to use an existing role
 */

import { Client } from 'minio';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REGION = process.env.AWS_REGION || 'us-east-1';
const TEST_BUCKET = process.env.TEST_BUCKET || 'codeapi-irsa-test-bucket';
const ROLE_NAME = process.env.IRSA_ROLE_NAME || 'codeapi-irsa-test-role';

interface TempCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration: string;
}

function exec(cmd: string): string {
    try {
        return execSync(cmd, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
    } catch (err: any) {
        throw new Error(`Command failed: ${cmd}\n${err.stderr || err.message}`);
    }
}

function execQuiet(cmd: string): { success: boolean; output: string } {
    try {
        const output = execSync(cmd, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        return { success: true, output };
    } catch (err: any) {
        return { success: false, output: err.stderr || err.message };
    }
}

async function getAccountId(): Promise<string> {
    const result = exec(
        'aws sts get-caller-identity --query Account --output text',
    );
    return result;
}

async function getUserArn(): Promise<string> {
    const result = exec(
        'aws sts get-caller-identity --query Arn --output text',
    );
    return result;
}

async function createS3AccessPolicy(accountId: string): Promise<string> {
    const policyName = `${ROLE_NAME}-s3-policy`;
    const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;

    const checkResult = execQuiet(
        `aws iam get-policy --policy-arn ${policyArn}`,
    );
    if (checkResult.success) {
        console.log(`Policy already exists: ${policyArn}`);
        return policyArn;
    }

    const policyDocument = {
        Version: '2012-10-17',
        Statement: [
            {
                Effect: 'Allow',
                Action: [
                    's3:GetObject',
                    's3:PutObject',
                    's3:DeleteObject',
                    's3:ListBucket',
                ],
                Resource: [
                    `arn:aws:s3:::${TEST_BUCKET}`,
                    `arn:aws:s3:::${TEST_BUCKET}/*`,
                ],
            },
            {
                Effect: 'Allow',
                Action: ['s3:ListAllMyBuckets', 's3:CreateBucket'],
                Resource: '*',
            },
        ],
    };

    const policyFile = `/tmp/${policyName}.json`;
    fs.writeFileSync(policyFile, JSON.stringify(policyDocument, null, 2));

    console.log(`Creating IAM policy: ${policyName}`);
    exec(
        `aws iam create-policy --policy-name ${policyName} --policy-document file://${policyFile}`,
    );

    return policyArn;
}

async function createAssumeRoleForUser(
    accountId: string,
    userArn: string,
): Promise<string> {
    const roleArn = `arn:aws:iam::${accountId}:role/${ROLE_NAME}`;

    const checkResult = execQuiet(`aws iam get-role --role-name ${ROLE_NAME}`);
    if (checkResult.success) {
        console.log(`Role already exists: ${roleArn}`);
        return roleArn;
    }

    const trustPolicy = {
        Version: '2012-10-17',
        Statement: [
            {
                Effect: 'Allow',
                Principal: {
                    AWS: userArn,
                },
                Action: 'sts:AssumeRole',
            },
        ],
    };

    const trustFile = `/tmp/${ROLE_NAME}-trust.json`;
    fs.writeFileSync(trustFile, JSON.stringify(trustPolicy, null, 2));

    console.log(`Creating IAM role: ${ROLE_NAME}`);
    exec(
        `aws iam create-role --role-name ${ROLE_NAME} --assume-role-policy-document file://${trustFile}`,
    );

    return roleArn;
}

async function attachPolicyToRole(policyArn: string): Promise<void> {
    const checkResult = execQuiet(
        `aws iam list-attached-role-policies --role-name ${ROLE_NAME} --query "AttachedPolicies[?PolicyArn=='${policyArn}']" --output text`,
    );
    if (
        checkResult.success &&
        checkResult.output.includes(policyArn.split('/').pop()!)
    ) {
        console.log('Policy already attached to role');
        return;
    }

    console.log('Attaching policy to role...');
    exec(
        `aws iam attach-role-policy --role-name ${ROLE_NAME} --policy-arn ${policyArn}`,
    );
}

async function assumeRole(roleArn: string): Promise<TempCredentials> {
    console.log(`\nAssuming role: ${roleArn}`);
    console.log('(This simulates what IRSA does automatically in EKS pods)\n');

    const result = exec(
        `aws sts assume-role --role-arn ${roleArn} --role-session-name irsa-test-session --query Credentials --output json`,
    );
    const creds = JSON.parse(result);

    return {
        accessKeyId: creds.AccessKeyId,
        secretAccessKey: creds.SecretAccessKey,
        sessionToken: creds.SessionToken,
        expiration: creds.Expiration,
    };
}

async function testWithTemporaryCredentials(
    creds: TempCredentials,
): Promise<boolean> {
    console.log('=== Testing MinIO SDK with Temporary Credentials ===');
    console.log(`Credentials expire at: ${creds.expiration}`);
    console.log(`Access Key: ${creds.accessKeyId.substring(0, 8)}...`);

    const client = new Client({
        endPoint: 's3.amazonaws.com',
        port: 443,
        useSSL: true,
        region: REGION,
        accessKey: creds.accessKeyId,
        secretKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
    });

    const testObjectKey = `irsa-test-${Date.now()}.txt`;
    const testContent = `IRSA simulation test at ${new Date().toISOString()}`;

    try {
        console.log('\n1. Listing buckets...');
        const buckets = await client.listBuckets();
        console.log(`   Found ${buckets.length} buckets ✓`);

        console.log(`\n2. Creating/checking bucket: ${TEST_BUCKET}`);
        const exists = await client.bucketExists(TEST_BUCKET);
        if (!exists) {
            await client.makeBucket(TEST_BUCKET, REGION);
            console.log('   Bucket created ✓');
        } else {
            console.log('   Bucket exists ✓');
        }

        console.log(`\n3. Uploading object: ${testObjectKey}`);
        await client.putObject(
            TEST_BUCKET,
            testObjectKey,
            Buffer.from(testContent),
        );
        console.log('   Upload successful ✓');

        console.log('\n4. Downloading and verifying object...');
        const stream = await client.getObject(TEST_BUCKET, testObjectKey);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            chunks.push(chunk as Buffer);
        }
        const downloaded = Buffer.concat(chunks).toString('utf-8');
        if (downloaded === testContent) {
            console.log('   Content verified ✓');
        } else {
            throw new Error('Content mismatch');
        }

        console.log('\n5. Cleaning up test object...');
        await client.removeObject(TEST_BUCKET, testObjectKey);
        console.log('   Deleted ✓');

        return true;
    } catch (err) {
        console.error('\nTest FAILED:', err);
        return false;
    }
}

async function simulateIamAwsProvider(roleArn: string): Promise<boolean> {
    console.log('\n=== Simulating IamAwsProvider Behavior ===\n');

    const tokenDir = '/tmp/irsa-simulation';
    const tokenFile = path.join(tokenDir, 'token');

    if (!fs.existsSync(tokenDir)) {
        fs.mkdirSync(tokenDir, { recursive: true });
    }

    fs.writeFileSync(tokenFile, 'simulated-token-for-local-testing');

    console.log('Environment variables that would be set by EKS:');
    console.log(`  AWS_WEB_IDENTITY_TOKEN_FILE=${tokenFile}`);
    console.log(`  AWS_ROLE_ARN=${roleArn}`);
    console.log(`  AWS_REGION=${REGION}`);

    console.log(
        '\nNote: The actual IamAwsProvider uses AssumeRoleWithWebIdentity',
    );
    console.log(
        'which requires a valid OIDC token from an EKS-registered provider.',
    );
    console.log(
        'For local testing, we use AssumeRole instead (same credential flow).\n',
    );

    const creds = await assumeRole(roleArn);
    return testWithTemporaryCredentials(creds);
}

async function main() {
    console.log(
        '╔════════════════════════════════════════════════════════════╗',
    );
    console.log(
        '║        IRSA Simulation Test for MinIO SDK + AWS S3         ║',
    );
    console.log(
        '╚════════════════════════════════════════════════════════════╝\n',
    );

    try {
        const accountId = await getAccountId();
        const userArn = await getUserArn();
        console.log(`AWS Account: ${accountId}`);
        console.log(`User ARN: ${userArn}`);
        console.log(`Region: ${REGION}`);
        console.log(`Test Bucket: ${TEST_BUCKET}`);

        let roleArn = process.env.IRSA_ROLE_ARN;

        if (!roleArn) {
            console.log('\n--- Setting up IAM Resources ---\n');

            const policyArn = await createS3AccessPolicy(accountId);
            roleArn = await createAssumeRoleForUser(accountId, userArn);
            await attachPolicyToRole(policyArn);

            console.log('\nWaiting 10 seconds for IAM propagation...');
            await new Promise(resolve => setTimeout(resolve, 10000));
        } else {
            console.log(`\nUsing existing role: ${roleArn}`);
        }

        const success = await simulateIamAwsProvider(roleArn);

        console.log('\n' + '═'.repeat(60));
        if (success) {
            console.log('✓ IRSA SIMULATION TEST PASSED');
            console.log(
                '\nThe MinIO SDK successfully works with temporary credentials',
            );
            console.log(
                'obtained via AssumeRole (which simulates IRSA behavior).',
            );
            console.log('\nFor actual EKS deployment with IRSA, you need to:');
            console.log('1. Create an OIDC provider for your EKS cluster');
            console.log(
                '2. Create an IAM role with a web identity trust policy',
            );
            console.log(
                '3. Annotate the Kubernetes ServiceAccount with the role ARN',
            );
            console.log(
                '\nSee: documentation/services/codeapi/deployment/irsa.md',
            );
        } else {
            console.log('✗ IRSA SIMULATION TEST FAILED');
            process.exit(1);
        }
    } catch (err) {
        console.error('\nError:', err);
        process.exit(1);
    }
}

main();
