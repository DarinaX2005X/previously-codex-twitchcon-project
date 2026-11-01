import {describe,it,expect,vi} from 'vitest';
import {createAuthoredBundle} from '../../fixtures/authored-notes.js';
import {ReplayDriver} from '../../src/replay/driver.js';
import {publicationLabel,recordingRecovery} from '../../src/features/dock/model.js';
import {correctionTarget} from '../../src/features/replay/correction.js';

describe('same-core replay',()=>{
  it('recovers a held edit with the supplied correction using its latest revision and does not restore a deleted target',()=>{
    const replay=new ReplayDriver(createAuthoredBundle(),'recover-held');replay.advanceTo(82300);
    const original=correctionTarget(replay.snapshot(),replay.correction?.targetId)!;
    replay.editChapter(original.id,{baseRevision:original.revision,title:'Unknown',summary:'An unrecorded assertion'});
    const uncheckedSource=replay.state.sources.find(source=>source.kind==='owner_statement')!;
    expect(replay.snapshot().published?.chapters).toHaveLength(0);
    const held=correctionTarget(replay.snapshot(),replay.correction?.targetId)!;
    expect(held.id).toBe(original.id);expect(held.revision).toBeGreaterThan(original.revision);
    expect(correctionTarget(replay.snapshot(),original.id)?.revision).toBe(held.revision);
    replay.editChapter(held.id,{...replay.correction!,baseRevision:held.revision});
    expect(replay.error).toBeNull();expect(replay.correctionApplied).toBe(true);
    expect(replay.snapshot().published?.chapters[0]?.summary).toBe(replay.correction!.summary);
    expect(replay.preview()?.beats.length).toBeGreaterThan(0);
    expect(replay.state.nodes[held.id]?.exposedTo.some(ref=>ref.id===uncheckedSource.id)).toBe(true);
    replay.privacy({kind:'source',sessionId:replay.state.session.id,id:uncheckedSource.id});
    expect(replay.snapshot().published?.chapters).toHaveLength(0);
    expect(correctionTarget(replay.snapshot(),held.id)).toBeUndefined();
    expect(correctionTarget(replay.snapshot())).toBeUndefined();
  });
  it('explains an unrecorded edit as a missing recorded outcome rather than personal information or connectivity',()=>{const replay=new ReplayDriver(createAuthoredBundle(),'recorded-edit-reason');replay.control({action:'seek',milestone:'raid'});replay.control({action:'pause'});const chapter=replay.state.chapters[0]!,edited=replay.editChapter(chapter.id,{baseRevision:chapter.revision,title:chapter.title,summary:'A different, unrecorded summary.'});expect(edited.publicationState).toBe('held');expect(edited.safety.reason).toBe('fixture_missing');expect(publicationLabel(edited,replay.clock.now())).toBe('This recording has no safety check for this edit');expect(replay.snapshot().status.story.message).toBe('This recording has no safety check for this edit');expect(recordingRecovery).toContain('no checked outcome');expect(recordingRecovery).toContain('restart the recording');expect(recordingRecovery).not.toMatch(/personal information|connection|refresh/i);});
  it('uses recorded provider results under distinct runtime scopes and final hashes agree',()=>{
    const a=new ReplayDriver(createAuthoredBundle(),'tab-a'),b=new ReplayDriver(createAuthoredBundle(),'tab-b');a.advanceTo(100000);for(const at of [1234.1,1599,76001,82459,100000])b.advanceTo(at);
    expect(a.error).toBeNull();expect(a.state.published?.chapters).toHaveLength(1);expect(a.state.sources[0]?.id).not.toBe(b.state.sources[0]?.id);expect(a.normalizedHash()).toBe(b.normalizedHash());
  });
  it('holds until the exact boundary and pause does not advance virtual time',()=>{
    const d=new ReplayDriver(createAuthoredBundle(),'hold');d.advanceTo(75999);expect(d.state.published?.chapters.length??0).toBe(0);d.control({action:'pause'});expect(d.atMs).toBe(75999);d.advanceTo(76000);expect(d.state.published?.chapters).toHaveLength(1);
  });
  it('safe correction follows owner review and arbitrary text remains held',()=>{
    const d=new ReplayDriver(createAuthoredBundle(),'edit');d.advanceTo(76000);let c=d.state.chapters[0]!;d.editChapter(c.id,{...d.correction!,baseRevision:c.revision});expect(d.state.published?.chapters[0]?.title).toBe(d.correction!.title);expect(d.error).toBeNull();expect(d.state.pendingGeneration).toBeNull();
    c=d.state.chapters[0]!;d.editChapter(c.id,{title:'Unknown',summary:'An unrecorded assertion',baseRevision:c.revision});expect(d.error).toBe('fixture_missing');expect(d.state.published?.chapters).toHaveLength(0);expect(d.state.chapters[0]?.publicationState).toBe('held');
  });
  it('quantizes animation-clock fractions before creating owner source offsets',()=>{const d=new ReplayDriver(createAuthoredBundle(),'fractional');d.advanceTo(97386.399);expect(d.atMs).toBe(97386);const chapter=d.state.chapters[0]!;d.editChapter(chapter.id,{...d.correction!,baseRevision:chapter.revision});expect(d.state.published?.chapters[0]?.summary).toBe(d.correction!.summary);expect(d.error).toBeNull();expect(d.state.sources.every(s=>Number.isInteger(s.startMs)&&Number.isInteger(s.endMs))).toBe(true);});
  it('finishes a manual scene after the last recorded source without fabricating input',()=>{const d=new ReplayDriver(createAuthoredBundle(),'tail');d.advanceTo(d.durationMs);const sourceCount=d.state.sources.length;d.send({type:'recap.trigger',trigger:{id:'tail-show',sessionId:d.state.session.id,reason:'manual',occurredAt:d.clock.iso()}});d.flush();d.control({action:'play'});d.advanceTo(100300);expect(d.state.playbacks.some(p=>p.status==='playing')).toBe(true);d.advanceTo(114000);expect(d.state.playbacks).toHaveLength(0);expect(d.state.sources).toHaveLength(sourceCount);expect(d.durationMs).toBe(100000);expect(d.atMs).toBeGreaterThan(d.durationMs);expect(d.playing).toBe(false);});
  it('switches recorded versions and does not publish a new inference',()=>{
    const d=new ReplayDriver(createAuthoredBundle(),'language');d.advanceTo(76000);d.setSettings({baseRevision:0,recapLanguage:'ru'});expect(d.state.published?.language).toBe('ru');expect(d.state.published?.chapters[0]?.title).toBe('Пропавшее превью');d.setSettings({baseRevision:d.state.settings.revision,recapLanguage:'en'});expect(d.state.published?.chapters[0]?.title).toBe('A missing preview');
  });
  it('offers only checked presentations for the current wording and can return to its native candidate',()=>{const bundle=createAuthoredBundle();bundle.providers=bundle.providers.filter(record=>record.operation!=='translation'||(record.input as {language?:string}).language!=='en');const d=new ReplayDriver(bundle,'supported-language');expect(d.availableLanguages).toEqual(['en']);d.advanceTo(76000);expect(d.availableLanguages).toEqual(['en','ru']);d.setSettings({baseRevision:0,recapLanguage:'ru'});expect(d.availableLanguages).toEqual(['en','ru']);d.setSettings({baseRevision:d.state.settings.revision,recapLanguage:'en'});expect(d.error).toBeNull();expect(d.state.published?.language).toBe('en');const partial=createAuthoredBundle();partial.providers=partial.providers.filter(record=>record.operation!=='translation'||(record.input as {title?:string}).title===partial.correction?.title);const unsupported=new ReplayDriver(partial,'unrelated-language');unsupported.advanceTo(76000);expect(unsupported.availableLanguages).toEqual(['en']);expect(()=>unsupported.setSettings({baseRevision:0,recapLanguage:'ru'})).toThrow('no safety check');expect(unsupported.state.published?.language).toBe('en');});
  it('executes preceding deletion before a raid and emits no real network effects',()=>{
    const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Live network forbidden'));
    const bundle=createAuthoredBundle();bundle.events.splice(1,0,{atMs:79000,event:{type:'privacy',target:{kind:'source',sessionId:bundle.initial.session.id,id:'speech-1'}}});const d=new ReplayDriver(bundle,'deleted');d.control({action:'seek',milestone:'raid'});expect(d.state.published?.chapters).toHaveLength(0);expect(d.state.sources.every(s=>!s.text)).toBe(true);expect(fetch).not.toHaveBeenCalled();fetch.mockRestore();
  });
  it('fails closed when input or a recorded provider result is missing',()=>{
    const bundle=createAuthoredBundle();const event=bundle.events[0]!.event;if(event.type==='source')event.source.text='Different evidence';const d=new ReplayDriver(bundle,'mutated');d.advanceTo(100000);expect(d.error).toBe('fixture_missing');expect(d.state.published?.chapters.length??0).toBe(0);
  });
  it('replays provider delay and failure without replacing it with an invented result',()=>{const bundle=createAuthoredBundle();const d=new ReplayDriver(bundle,'latency');d.advanceTo(1599);expect(d.state.chapters).toHaveLength(0);d.advanceTo(1600);expect(d.state.chapters).toHaveLength(1);bundle.providers[0]!.error='recorded_provider_failure';const failed=new ReplayDriver(bundle,'failure');failed.advanceTo(76000);expect(failed.error).toBe('recorded_provider_failure');expect(failed.state.published?.chapters.length??0).toBe(0);});
  it('publishes the recorded correction in Russian and preserves it in a new preview',()=>{const d=new ReplayDriver(createAuthoredBundle(),'ru-edit');d.advanceTo(76000);d.setSettings({baseRevision:0,recapLanguage:'ru'});const chapter=d.state.chapters[0]!;d.editChapter(chapter.id,{...d.correction!,baseRevision:chapter.revision});expect(d.state.published?.language).toBe('ru');expect(d.state.published?.chapters[0]?.title).toBe('Заметка сохранена, но превью пропало');expect(d.preview()?.beats.some(b=>b.text.includes('Пропало только превью'))).toBe(true);});
  it('revoke drops private replay memory and scheduled output',()=>{const d=new ReplayDriver(createAuthoredBundle(),'revoked');d.advanceTo(82300);d.revoke();expect(d.state.sources).toHaveLength(0);expect(d.state.playbacks).toHaveLength(0);expect(d.state.published).toBeNull();expect(d.playing).toBe(false);});
});
