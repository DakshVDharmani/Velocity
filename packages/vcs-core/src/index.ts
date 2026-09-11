import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Repository, Commit, FileRecord, User } from '../../shared/src/index';
export class VcsError extends Error { constructor(message:string, public status=400){super(message);} }
export const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
// FNV-1a is used only for temporary detection; stored identities always use SHA-256.
export function fastHash(content:string) {let h=0x811c9dc5;for(const byte of Buffer.from(content)){h^=byte;h=Math.imul(h,0x01000193);}return (h>>>0).toString(16).padStart(8,'0');}
export function metadataUnchanged(a:{size:number;mtimeMs:number},b:{size:number;mtimeMs:number}) {return a.size===b.size&&a.mtimeMs===b.mtimeMs;}
export function validPath(path:string) {if(!path || path.length>500 || path.startsWith('/') || path.includes('\\') || path.includes(':') || path.split('/').some(p=>!p||p==='.'||p==='..'||p==='.velocity'||p==='.git') || /[\x00-\x1f]/.test(path))throw new VcsError('Invalid repository file path');return path;}
export interface ObjectStorage {put(key:string,value:Buffer):Promise<void>;get(key:string):Promise<Buffer>;}
// Snapshots, deltas and large blobs live in a private Supabase Storage bucket, keyed by repository/commit.
export class SupabaseStorage implements ObjectStorage {
  constructor(private client:SupabaseClient, private bucket='snapshots'){}
  private path(key:string){if(!/^[a-z0-9/-]+\.[a-z]+$/.test(key)||key.includes('..'))throw new VcsError('Invalid storage key');return key;}
  async put(key:string,value:Buffer){const {error}=await this.client.storage.from(this.bucket).upload(this.path(key),value,{contentType:'application/octet-stream',upsert:true});if(error)throw new VcsError(`Storage write failed: ${error.message}`,502);}
  async get(key:string){const {data,error}=await this.client.storage.from(this.bucket).download(this.path(key));if(error||!data)throw new VcsError(`Storage read failed: ${error?.message??'not found'}`,502);return Buffer.from(await data.arrayBuffer());}
}
export function ancestors(repo:Repository,head:string|null):string[]{const result:string[]=[];while(head){if(result.includes(head))throw new VcsError('Corrupt history');result.push(head);head=repo.commits.find(c=>c.id===head)?.parentCommitId??null;}return result;}
export function mergeCheck(repo:Repository,sourceName:string,targetName:string){
 const source=repo.branches.find(b=>b.name===sourceName),target=repo.branches.find(b=>b.name===targetName);
 if(!source||!target||source===target)throw new VcsError('Select two different existing branches');
 const a=ancestors(repo,source.currentHead),b=ancestors(repo,target.currentHead);
 return {source:source.name,target:target.name,canFastForward:!target.currentHead||a.includes(target.currentHead),ahead:a.filter(id=>!b.includes(id)).length,behind:b.filter(id=>!a.includes(id)).length,commonAncestor:a.find(id=>b.includes(id))??null};
}
export function addActivity(repo:Repository,type:string,message:string,author:string){repo.activity.unshift({id:randomUUID(),type,message,author,createdAt:new Date().toISOString()});repo.updatedAt=new Date().toISOString();}
export function createCommit(repo:Repository,input:{message:string;branch:string;files:Record<string,string|null>;expectedHead?:string|null},user:Pick<User,'id'|'name'>):Commit {
 const start=performance.now(),branch=repo.branches.find(b=>b.name===input.branch);if(!branch)throw new VcsError('Branch not found',404);
 if(input.expectedHead!==undefined&&input.expectedHead!==branch.currentHead)throw new VcsError('Branch changed. Pull before committing.',409);
 const parent=repo.commits.find(c=>c.id===branch.currentHead),files:Record<string,FileRecord>=structuredClone(parent?.files??{}),changedPaths:string[]=[];
 let insertions=0,deletions=0;
 for(const [path,content] of Object.entries(input.files)){validPath(path);const old=files[path];if(content===null){if(old){delete files[path];changedPaths.push(path);deletions+=old.content.split('\n').length;}continue;}if(old?.content===content)continue;
 changedPaths.push(path);insertions+=content.split('\n').length;deletions+=old?.content.split('\n').length??0;
 files[path]={path,content,size:Buffer.byteLength(content),modifiedAt:new Date().toISOString(),fastHash:fastHash(content),secureHash:sha256(content)};
 }
 if(!changedPaths.length)throw new VcsError('Nothing to commit. Your working tree is clean.');
 const createdAt=new Date().toISOString(),hash=sha256(JSON.stringify({parent:branch.currentHead,message:input.message,author:user.id,createdAt,files:Object.keys(files).sort().map(p=>[p,files[p].secureHash])}));
 const commit:Commit={id:hash,hash,shortHash:hash.slice(0,7),message:input.message,authorId:user.id,author:user.name,branchId:branch.id,parentCommitId:branch.currentHead,createdAt,files,changedPaths,insertions,deletions,storageKind:'snapshot'};
 repo.commits.unshift(commit);branch.currentHead=commit.id;addActivity(repo,'commit',input.message,user.name);
 repo.metrics.push({id:randomUUID(),operation:'commit',durationMs:Math.round((performance.now()-start)*100)/100,cacheHit:false,filesScanned:Object.keys(input.files).length,hashesAvoided:Object.keys(input.files).length-changedPaths.length,createdAt,simulated:false});return commit;
}
export async function persistObjects(repo:Repository,storage:ObjectStorage){
 const heads=new Set(repo.branches.map(b=>b.currentHead));
 for(let i=0;i<repo.commits.length;i++){const commit=repo.commits[i];const kind=i<repo.settings.snapshotRetention||heads.has(commit.id)?'snapshot':i<100||!repo.settings.autoArchive?'delta':'archive';
 if(commit.storagePath&&commit.storageKind===kind)continue;
 const files:Record<string,unknown>={};for(const [path,file]of Object.entries(commit.files)){if(file.size>repo.settings.largeFileThreshold&&repo.settings.externalStorage){file.objectKey=`large/${file.secureHash}.blob`;await storage.put(file.objectKey,Buffer.from(file.content));files[path]={...file,content:undefined,objectKey:file.objectKey};}else files[path]=file;}
 let payload:unknown=files;if(kind==='delta'){const parent=repo.commits.find(c=>c.id===commit.parentCommitId);payload={base:parent?.id??null,changes:Object.fromEntries(commit.changedPaths.map(path=>[path,files[path]??null]))};}
 const key=`${repo.id}/${commit.hash}-${kind}.gz`;await storage.put(key,gzipSync(JSON.stringify(payload)));commit.storageKind=kind;commit.storagePath=key;
 }
}
export function fastForward(repo:Repository,source:string,target:string,author:string){const check=mergeCheck(repo,source,target);if(!check.canFastForward)throw new VcsError('Rebase required: branches have diverged.',409);repo.branches.find(b=>b.name===target)!.currentHead=repo.branches.find(b=>b.name===source)!.currentHead;addActivity(repo,'merge',`Merged ${source} into ${target}`,author);return check;}
export function rebase(repo:Repository,sourceName:string,targetName:string,user:Pick<User,'id'|'name'>){
 const check=mergeCheck(repo,sourceName,targetName),source=repo.branches.find(b=>b.name===sourceName)!;if(source.isDefault)throw new VcsError('Rebase a feature branch, not the default branch');
 const commits=ancestors(repo,source.currentHead).slice(0,check.commonAncestor?ancestors(repo,source.currentHead).indexOf(check.commonAncestor):undefined).map(id=>repo.commits.find(c=>c.id===id)!).reverse();
 const targetFiles=repo.commits.find(c=>c.id===repo.branches.find(b=>b.name===targetName)!.currentHead)?.files??{},baseFiles=repo.commits.find(c=>c.id===check.commonAncestor)?.files??{};
 const touched=new Set(commits.flatMap(c=>c.changedPaths));const conflicts=[...touched].filter(p=>baseFiles[p]?.secureHash!==targetFiles[p]?.secureHash&&repo.commits.find(c=>c.id===source.currentHead)?.files[p]?.secureHash!==targetFiles[p]?.secureHash);
 if(conflicts.length)throw new VcsError(`Resolve conflicting files before rebasing: ${conflicts.join(', ')}`,409);
 source.currentHead=repo.branches.find(b=>b.name===targetName)!.currentHead;
 for(const commit of commits){const current=repo.commits.find(c=>c.id===source.currentHead)?.files??{};const patch=Object.fromEntries(commit.changedPaths.filter(p=>current[p]?.secureHash!==commit.files[p]?.secureHash).map(p=>[p,commit.files[p]?.content??null]));if(Object.keys(patch).length)createCommit(repo,{message:commit.message,branch:sourceName,files:patch},user);}
 addActivity(repo,'rebase',`Rebased ${sourceName} onto ${targetName}`,user.name);return {replayed:commits.length};
}
