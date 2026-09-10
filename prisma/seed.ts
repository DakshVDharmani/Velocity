import 'dotenv/config';import {openStore} from '../apps/api/src/store';
const store=await openStore({postgres:process.env.STORAGE_DRIVER==='postgres',file:process.env.DATA_PATH??'./data/workspace.json',seed:true});console.log(`Workspace ready: ${store.read().repositories.length} repositories. Demo: demo@velocity.dev / Velocity2026!`);await store.close();
