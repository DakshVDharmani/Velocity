import { z } from 'zod';
export type Role = 'Owner' | 'Maintainer' | 'Developer' | 'Viewer';
export interface User { id: string; name: string; email: string; passwordHash: string; }
export interface Member { id: string; userId: string; name: string; email: string; role: Role; }
export interface FileRecord { path: string; content: string; size: number; modifiedAt: string; fastHash: string; secureHash: string; objectKey?: string; }
export interface Commit { id: string; hash: string; shortHash: string; message: string; authorId: string; author: string; branchId: string; parentCommitId: string | null; createdAt: string; files: Record<string, FileRecord>; changedPaths: string[]; insertions: number; deletions: number; storageKind: 'snapshot' | 'delta' | 'archive'; storagePath?: string; }
export interface Branch { id: string; name: string; currentHead: string | null; isDefault: boolean; creatorId: string; createdAt: string; }
export interface Activity { id: string; type: string; message: string; author: string; createdAt: string; }
export interface Metric { id: string; operation: string; durationMs: number; cacheHit: boolean; filesScanned: number; hashesAvoided: number; createdAt: string; simulated: boolean; }
export interface Settings { branchLimit: number; historyDepth: number; snapshotRetention: number; largeFileThreshold: number; cacheTTL: number; linearHistory: boolean; fastForwardOnly: boolean; externalStorage: boolean; autoArchive: boolean; }
export interface Repository { id: string; name: string; description: string; visibility: 'private'|'public'; language: string; ownerId: string; archived: boolean; createdAt: string; updatedAt: string; branches: Branch[]; commits: Commit[]; members: Member[]; activity: Activity[]; metrics: Metric[]; settings: Settings; }
export interface State { users: User[]; repositories: Repository[]; sessions: {id:string; userId:string; expiresAt:string}[]; }
export const settingsSchema = z.object({branchLimit:z.number().int().min(2).max(50).default(10),historyDepth:z.number().int().min(1).max(500).default(50),snapshotRetention:z.number().int().min(2).max(100).default(10),largeFileThreshold:z.number().int().min(1024).max(104857600).default(1048576),cacheTTL:z.number().int().min(1).max(3600).default(60),linearHistory:z.boolean().default(true),fastForwardOnly:z.literal(true).default(true),externalStorage:z.boolean().default(true),autoArchive:z.boolean().default(true)});
export const repositorySchema = z.object({name:z.string().min(2).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Use letters, numbers, dots, dashes or underscores'),description:z.string().max(500).default(''),visibility:z.enum(['private','public']).default('private'),defaultBranch:z.string().min(1).max(80).default('main'),language:z.string().max(30).default('TypeScript'),settings:settingsSchema.default({})});
export const branchNameSchema = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/).refine(v=>!v.includes('..')&&!v.endsWith('/'),'Invalid branch name');
export const commitSchema = z.object({message:z.string().trim().min(1).max(300),branch:z.string().min(1),expectedHead:z.string().nullable().optional(),files:z.record(z.string().max(2097152).nullable()).refine(v=>Object.keys(v).length<=500,'At most 500 files per commit')});
export const defaultSettings = settingsSchema.parse({});
export function formatBytes(n:number) { if(n<1024)return `${n} B`; if(n<1048576)return `${(n/1024).toFixed(1)} KB`;return `${(n/1048576).toFixed(1)} MB`; }
export function repoSize(repo:Repository) {const head=repo.branches.find(b=>b.isDefault)?.currentHead;return Object.values(repo.commits.find(c=>c.id===head)?.files??{}).reduce((sum,f)=>sum+f.size,0);}
