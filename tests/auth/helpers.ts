import type {ControlStore} from '../../src/server/auth/control.js';
export function memoryControl(now:()=>number=Date.now):ControlStore {
  const values=new Map<string,{value:unknown;expires?:number}>();
  const get=<T>(key:string):T|null=>{const row=values.get(key);if(!row)return null;if(row.expires!==undefined&&row.expires<=now()){values.delete(key);return null;}return row.value as T;};
  return {get,put:(key,value,expires)=>{values.set(key,{value,expires});},delete:key=>{values.delete(key);},take:<T>(key:string)=>{const value=get<T>(key);values.delete(key);return value;},claim:(key,value,expires)=>{if(get(key)!==null)return false;values.set(key,{value,expires});return true;}};
}
