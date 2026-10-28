import assert from 'node:assert/strict';
import { mkdtemp,writeFile,mkdir,rename,rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'metadata-phases-'));
try {
 const git=(args,cwd=root)=>exec('git',args,{cwd,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1'}});
 await git(['init','-q','-b','main']); await writeFile(join(root,'file'),'tracked\n'); await git(['add','file']);
 await git(['-c','user.name=test','-c','user.email=test@example.test','-c','commit.gpgsign=false','commit','-qm','seed']);
 const commit=(await git(['rev-parse','HEAD'])).stdout.trim(); await mkdir(join(root,'.worktrees'));
 const lane=join(root,'.worktrees','review');
 await git(['worktree','add','--no-checkout','--detach',lane,commit]);
 await git(['-c','core.hooksPath=/dev/null','checkout','--detach',commit],lane);
 assert.equal((await git(['status','--porcelain'],lane)).stdout,'');
 const tombstone=join(root,'.retired-review'); await rename(lane,tombstone);
 await git(['worktree','remove',lane]);
 assert.doesNotMatch((await git(['worktree','list','--porcelain'])).stdout,/review/);
 // Registration removal did not delete the detached bulk directory.
 await rm(tombstone,{recursive:true});
 console.log('Split-phase registration/checkout and rename/detach/delete: passed');
} finally { await rm(root,{recursive:true,force:true}); }
