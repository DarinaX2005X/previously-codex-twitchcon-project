import {describe,it,expect} from 'vitest';
import {createFoxlightBundle} from '../../fixtures/foxlight.js';
import {ReplayDriver} from '../../src/replay/driver.js';
import {recordedChat,visibleChat} from '../../src/replay/chat.js';

const shown=(d:ReplayDriver)=>visibleChat(recordedChat(createFoxlightBundle()),d.atMs,d.hiddenChat);

describe('replay chat column',()=>{
  it('shows every recorded chat line up to now when nothing was removed',()=>{
    const d=new ReplayDriver(createFoxlightBundle(),'chat-plain'),chat=recordedChat(createFoxlightBundle());
    expect(chat.length).toBeGreaterThan(10);
    for(const at of [60000,200000,d.durationMs]){d.advanceTo(at);expect(d.hiddenChat).toEqual([]);expect(shown(d)).toEqual(chat.filter(c=>c.atMs<=at));}
  });
  it('keeps earlier chat after a chapter is deleted',()=>{
    const d=new ReplayDriver(createFoxlightBundle(),'chat-delete');d.control({action:'seek',milestone:'raid'});
    const before=shown(d),chapter=d.state.chapters.find(c=>c.publicationState!=='deleted')!;
    const epoch=d.state.session.privacyEpoch;d.privacy({kind:'entity',sessionId:d.state.session.id,id:chapter.id});
    expect(d.state.session.privacyEpoch).toBeGreaterThan(epoch);
    expect(shown(d)).toEqual(before);
  });
  it('removes a forgotten interval and nothing else',()=>{
    const d=new ReplayDriver(createFoxlightBundle(),'chat-forget');d.advanceTo(200000);
    const before=shown(d);d.privacy({kind:'interval',sessionId:d.state.session.id,fromMs:100000,toMs:110500});
    const after=shown(d);
    expect(after.length).toBeLessThan(before.length);
    expect(after).toEqual(before.filter(c=>!(c.atMs>=100000&&c.atMs<=110500)));
  });
  it('hides a banned chatter before and after the ban',()=>{
    const d=new ReplayDriver(createFoxlightBundle(),'chat-ban'),chat=recordedChat(createFoxlightBundle());
    const counts=new Map<string,number>();for(const c of chat)if(c.actor)counts.set(c.actor,(counts.get(c.actor)??0)+1);
    const actor=[...counts].sort((a,b)=>b[1]-a[1])[0]![0],banAt=Math.min(...chat.filter(c=>c.actor===actor).map(c=>c.atMs))+1;
    expect(chat.some(c=>c.actor===actor&&c.atMs>banAt)).toBe(true);
    d.advanceTo(banAt);d.send({type:'ban',actorId:d.ids.map(actor,'runtime'),throughMs:banAt});d.flush();
    d.advanceTo(d.durationMs);
    const visible=shown(d);
    expect(visible.some(c=>c.actor===actor)).toBe(false);
    expect(visible).toEqual(chat.filter(c=>c.actor!==actor));
  });
});
