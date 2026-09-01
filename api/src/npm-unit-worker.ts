import fs from 'fs';
import { buildNpmUnitResult, npmWorkerFailure, type NpmUnitWorkerRequest } from './npm-unit-worker-lib';

async function main(): Promise<void> {
  const started = performance.now();
  let tarball = Buffer.alloc(0);
  try {
    const request = JSON.parse(fs.readFileSync('/mnt/data/request.json', 'utf8')) as NpmUnitWorkerRequest;
    tarball = fs.readFileSync('/mnt/data/package.tgz');
    const result = await buildNpmUnitResult(request, tarball);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stdout.write(JSON.stringify(npmWorkerFailure(error, tarball.length, started)));
  }
}

void main();
