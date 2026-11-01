import {describe,it,expect,vi} from 'vitest';
import {TwitchBanSync} from '../../src/server/twitch/bans.js';
import {TwitchHelix,type BannedUser} from '../../src/server/twitch/helix.js';
import {memoryControl} from '../auth/helpers.js';
describe('durable ban synchronization',()=>{
  it('newer moderation events win over paginated snapshot and unban never restores old sources',async()=>{
    let rows:BannedUser[]=[];const onBlocked=vi.fn();const control=memoryControl();const bans=new TwitchBanSync({control,helix:{bannedUsers:async page=>{await page(rows);}},onBlocked,now:()=>100000});
    bans.begin('sync');expect(bans.allows('456')).toBe(false);await bans.ban({user_id:'456',banned_at:'2026-11-02T00:00:00Z',is_permanent:true});await bans.page('sync',[]);bans.finish('sync');expect(bans.allows('456')).toBe(false);expect(bans.allows('789')).toBe(true);
    bans.begin('second');await bans.unban({user_id:'456'});await bans.page('second',[{user_id:'456',created_at:'2026-10-01T00:00:00Z',expires_at:''}]);bans.finish('second');expect(bans.allows('456')).toBe(true);expect(onBlocked).toHaveBeenCalledTimes(1);
    const restarted=new TwitchBanSync({control,helix:{bannedUsers:async page=>{await page(rows);}},onBlocked});expect(restarted.allows('456')).toBe(false); // Restart requires a new complete snapshot.
  });
  it('timeout expiry remains blocked until point query succeeds, prolonged ban defeats stale query',async()=>{
    let now=100000;let fail=true;let complete:((rows:BannedUser[])=>void)|null=null;
    const onBlocked=vi.fn();const bans=new TwitchBanSync({control:memoryControl(()=>now),now:()=>now,onBlocked,helix:{bannedUsers:async(page)=>{if(fail)throw new Error('offline');const rows=await new Promise<BannedUser[]>(resolve=>{complete=resolve;});await page(rows);}}});
    bans.begin('sync');bans.finish('sync');await bans.ban({user_id:'456',banned_at:new Date(now).toISOString(),ends_at:new Date(now+1000).toISOString()});now+=2000;expect(await bans.verifyActor('456')).toBe(false);expect(bans.allows('456')).toBe(false);
    fail=false;const check=bans.verifyActor('456');await bans.ban({user_id:'456',banned_at:new Date(now).toISOString(),is_permanent:true});(complete as unknown as (rows:BannedUser[])=>void)([]);expect(await check).toBe(false);expect(bans.allows('456')).toBe(false);
  });
  it('Get Banned Users paginates all pages and preserves timeout fields',async()=>{
    const urls:string[]=[];const fetcher=async(url:string)=>{urls.push(url);return Response.json(url.includes('after=cursor')?{data:[{user_id:'2',expires_at:'2026-11-03T00:00:00Z'}],pagination:{}}:{data:[{user_id:'1',expires_at:''}],pagination:{cursor:'cursor'}});};
    const helix=new TwitchHelix('123',{authorizedFetch:fetcher});const users:unknown[]=[];await helix.bannedUsers(page=>{users.push(...page);});expect(users).toHaveLength(2);expect(urls[1]).toContain('after=cursor');expect(urls[0]).toContain('first=100');
  });
});
