import {PrismaClient,Prisma} from '@prisma/client';
import type {State,Repository} from '../../../packages/shared/src/index';
import {seedState} from './seed';
export interface Store {read():State; mutate<T>(fn:(state:State)=>Promise<T>|T):Promise<T>;close():Promise<void>;}
export async function openStore(options:{seed?:boolean}={}):Promise<Store>{
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL must point at the Supabase Postgres database');
 const prisma=new PrismaClient();
 const [users,repos,sessions]=await Promise.all([prisma.user.findMany(),prisma.repository.findMany(),prisma.session.findMany()]);
 let state:State={users:users.map(u=>({id:u.id,name:u.name,email:u.email,passwordHash:u.passwordHash})),repositories:repos.map(r=>r.document as unknown as Repository),sessions:sessions.map(s=>({id:s.id,userId:s.userId,expiresAt:s.expiresAt.toISOString()}))};
 if(!state.users.length&&options.seed!==false)state=seedState();
 async function persist(next:State){await prisma.$transaction(async tx=>{
  for(const u of next.users)await tx.user.upsert({where:{id:u.id},create:u,update:u});
  await tx.repository.deleteMany({where:{id:{notIn:next.repositories.map(r=>r.id)}}});
  for(const r of next.repositories)await tx.repository.upsert({where:{id:r.id},create:{id:r.id,name:r.name,ownerId:r.ownerId,visibility:r.visibility,document:r as unknown as Prisma.InputJsonValue},update:{name:r.name,visibility:r.visibility,document:r as unknown as Prisma.InputJsonValue}});
  await tx.session.deleteMany();if(next.sessions.length)await tx.session.createMany({data:next.sessions.map(s=>({...s,expiresAt:new Date(s.expiresAt)}))});
 },{timeout:30000});}
 await persist(state);let tail:Promise<unknown>=Promise.resolve();
 return {read:()=>structuredClone(state),mutate<T>(fn:(s:State)=>T|Promise<T>){const task=tail.then(async()=>{const next=structuredClone(state),result=await fn(next);await persist(next);state=next;return result;});tail=task.catch(()=>{});return task;},async close(){await tail;await prisma.$disconnect();}};
}
