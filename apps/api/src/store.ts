import {PrismaClient,Prisma} from '@prisma/client';
import type {State,Repository,Issue,IssueStatus} from '../../../packages/shared/src/index';
import {seedState} from './seed';
export interface Store {read():State; mutate<T>(fn:(state:State)=>Promise<T>|T):Promise<T>;close():Promise<void>;}
type IssueRow={id:string;repositoryId:string;creatorId:string;title:string;description:string;status:string;createdAt:Date;updatedAt:Date};
export async function openStore(options:{seed?:boolean}={}):Promise<Store>{
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL must point at the Supabase Postgres database');
 const prisma=new PrismaClient();
 const [users,repos,sessions,issueRows]=await Promise.all([prisma.user.findMany(),prisma.repository.findMany(),prisma.session.findMany(),prisma.$queryRaw<IssueRow[]>`select "id","repositoryId","creatorId","title","description","status","createdAt","updatedAt" from public."Issue"`]);
 const publicUsers=users.map(u=>({id:u.id,name:u.name,email:u.email,passwordHash:u.passwordHash})),userNames=new Map(publicUsers.map(u=>[u.id,u.name]));
 let state:State={users:publicUsers,repositories:repos.map(r=>{const repo=r.document as unknown as Repository,documentIssues=Array.isArray(repo.issues)?repo.issues:[],merged=new Map<string,Issue>();for(const issue of documentIssues)merged.set(issue.id,issue);for(const issue of issueRows.filter(i=>i.repositoryId===r.id))merged.set(issue.id,{id:issue.id,repositoryId:issue.repositoryId,creatorId:issue.creatorId,creatorName:userNames.get(issue.creatorId)??merged.get(issue.id)?.creatorName??'Unknown user',title:issue.title,description:issue.description,status:(issue.status==='CLOSED'?'CLOSED':'OPEN') as IssueStatus,createdAt:issue.createdAt.toISOString(),updatedAt:issue.updatedAt.toISOString()});return {...repo,issues:[...merged.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))};}),sessions:sessions.map(s=>({id:s.id,userId:s.userId,expiresAt:s.expiresAt.toISOString()}))};
 if(!state.users.length&&options.seed!==false)state=seedState();
 async function persist(next:State){await prisma.$transaction(async tx=>{
  for(const u of next.users)await tx.user.upsert({where:{id:u.id},create:u,update:u});
  await tx.repository.deleteMany({where:{id:{notIn:next.repositories.map(r=>r.id)}}});
  for(const r of next.repositories)await tx.repository.upsert({where:{id:r.id},create:{id:r.id,name:r.name,ownerId:r.ownerId,visibility:r.visibility,document:r as unknown as Prisma.InputJsonValue},update:{name:r.name,visibility:r.visibility,document:r as unknown as Prisma.InputJsonValue}});
  const issues=next.repositories.flatMap(r=>(r.issues??[]).map(i=>({...i,repositoryId:r.id})));
  if(issues.length)await tx.$executeRaw(Prisma.sql`delete from public."Issue" where "id" not in (${Prisma.join(issues.map(i=>i.id))})`);
  else await tx.$executeRaw`delete from public."Issue"`;
  for(const i of issues)await tx.$executeRaw`
   insert into public."Issue" ("id","repositoryId","creatorId","title","description","status","createdAt","updatedAt")
   values (${i.id},${i.repositoryId},${i.creatorId},${i.title},${i.description},${i.status},${new Date(i.createdAt)},${new Date(i.updatedAt)})
   on conflict ("id") do update set
    "repositoryId"=excluded."repositoryId",
    "creatorId"=excluded."creatorId",
    "title"=excluded."title",
    "description"=excluded."description",
    "status"=excluded."status",
    "createdAt"=excluded."createdAt",
    "updatedAt"=excluded."updatedAt"
  `;
  await tx.session.deleteMany();if(next.sessions.length)await tx.session.createMany({data:next.sessions.map(s=>({...s,expiresAt:new Date(s.expiresAt)}))});
 },{timeout:30000});}
 await persist(state);let tail:Promise<unknown>=Promise.resolve();
 return {read:()=>structuredClone(state),mutate<T>(fn:(s:State)=>T|Promise<T>){const task=tail.then(async()=>{const next=structuredClone(state),result=await fn(next);await persist(next);state=next;return result;});tail=task.catch(()=>{});return task;},async close(){await tail;await prisma.$disconnect();}};
}
