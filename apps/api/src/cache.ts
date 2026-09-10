import {createClient} from 'redis';
export class MetadataCache {
 private memory=new Map<string,{value:string;expires:number}>();private redis?:ReturnType<typeof createClient>;
 async connect(url?:string){if(!url)return;this.redis=createClient({url,socket:{reconnectStrategy:false,connectTimeout:3000}});this.redis.on('error',()=>{});try{await this.redis.connect();}catch{console.warn('Redis unavailable; using in-memory metadata cache.');this.redis=undefined;}}
 async get<T>(key:string):Promise<T|null>{try{const raw=this.redis?.isReady?await this.redis.get(key):undefined;if(raw)return JSON.parse(raw) as T;}catch{}const item=this.memory.get(key);if(!item||item.expires<Date.now()){this.memory.delete(key);return null;}return JSON.parse(item.value) as T;}
 async set(key:string,value:unknown,ttl=60){const raw=JSON.stringify(value);if(this.memory.size>1000)this.memory.clear();this.memory.set(key,{value:raw,expires:Date.now()+ttl*1000});try{if(this.redis?.isReady)await this.redis.set(key,raw,{EX:ttl});}catch{}}
 async clear(){this.memory.clear();/* Keys include repository revision, so stale Redis entries expire naturally. */}
 async close(){if(this.redis?.isOpen)await this.redis.quit();}
}
