import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RecapClient, Rect, Settings } from '../../shared/contracts';
import { ActionGroup, Button, Field, InlineNotice, QuietButton, SegmentedControl, Sheet, Textarea } from '../../ui';
import { resolveSceneLayout } from '../overlay/geometry';
import { errorCode } from '../dock/model';
import './settings.css';

export interface SettingsSheetProps { settings: Settings; client: RecapClient; onClose(): void; onSaved(): void; recording?: boolean; }

function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange(value: boolean): void; label: string; hint?: ReactNode }) {
  const id = useId();
  return <label className="st-switch" htmlFor={id}>
    <span className="st-switch__text"><span>{label}</span>{hint && <small>{hint}</small>}</span>
    <input id={id} type="checkbox" role="switch" checked={checked} onChange={event => onChange(event.target.checked)} />
    <span className="st-switch__track" aria-hidden="true"><span /></span>
  </label>;
}

export function SettingsSheet({ settings, client, onClose, onSaved, recording = false }: SettingsSheetProps) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const drag = useRef<{ x: number; y: number; rect: Rect } | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const patch = (value: Partial<Settings>) => setDraft(current => ({ ...current, ...value }));
  const rect = draft.layout.protectedRects[selected];
  const scene = useMemo(() => resolveSceneLayout(draft.layout), [draft.layout]);
  function updateRect(value: Partial<Rect>) {
    setDraft(current => {
      const previous = current.layout.protectedRects[selected];
      if (!previous) return current;
      const next = { ...previous, ...value };
      next.width = Math.max(1, Math.min(1920, next.width)); next.height = Math.max(1, Math.min(1080, next.height));
      next.x = Math.max(0, Math.min(1920 - next.width, next.x)); next.y = Math.max(0, Math.min(1080 - next.height, next.y));
      return { ...current, layout: { ...current.layout, protectedRects: current.layout.protectedRects.map((item, index) => index === selected ? next : item) } };
    });
  }
  async function save() {
    if (busy.current) return;
    if (draft.hotkey && !/^(?:(?:Alt|Ctrl|Shift|Meta)\+)*[\w]$/i.test(draft.hotkey)) { setError('Choose a letter or number, with optional Alt, Ctrl or Shift modifiers.'); return; }
    busy.current = true; setPending(true); setError('');
    try { const { revision, ...value } = draft; await client.setSettings({ ...value, baseRevision: revision }); onSaved(); onClose(); }
    catch (cause) { setError(errorCode(cause) === 'revision_conflict' ? 'Settings changed in another dock. Your choices are still here. Reopen settings to compare before saving.' : 'Could not save settings. Your choices are still here. Try Save settings again.'); }
    finally { busy.current = false; setPending(false); }
  }
  const pct = (value: number, total: number) => `${(value / total) * 100}%`;
  return <Sheet open onOpenChange={open => { if (!open) onClose(); }} title="Scene settings" description={recording ? 'These choices apply only to this recording.' : 'How the recap scene looks and when it plays in OBS.'} className="dock-paper st-sheet" footer={<ActionGroup><Button pending={pending} onClick={() => void save()}>Save settings</Button><QuietButton onClick={onClose}>Cancel</QuietButton></ActionGroup>}>
    {error && <InlineNotice tone="danger" live>{error}</InlineNotice>}
    <div className="dock-settings">
      <section className="st-group" aria-labelledby="st-place">
        <h3 id="st-place">Where the scene appears</h3>
        <SegmentedControl label="Scene position" value={draft.layout.preset} onChange={value => patch({ layout: { ...draft.layout, preset: value as Settings['layout']['preset'] } })} options={[{ value: 'lower', label: 'Bottom' }, { value: 'upper', label: 'Top' }, { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]} />
        <p className="st-help">Mark your camera and other areas the scene must not cover. Drag an area, or select it and use the arrow keys.</p>
        <div className="dock-safe-board" ref={board} role="group" aria-label="1920 by 1080 broadcast canvas">
          {scene && <div className="st-scene" style={{ left: pct(scene.bounds.x, 1920), top: pct(scene.bounds.y, 1080), width: pct(scene.bounds.width, 1920), height: pct(scene.bounds.height, 1080) }} aria-hidden="true"><span>Scene</span></div>}
          {draft.layout.protectedRects.map((item, index) => <button type="button" key={index} className="dock-safe-rect" data-selected={selected === index} style={{ left: pct(item.x, 1920), top: pct(item.y, 1080), width: pct(item.width, 1920), height: pct(item.height, 1080) }} aria-label={`Protected area ${index + 1}. Arrow keys move it by 10 pixels.`} onFocus={() => setSelected(index)} onPointerDown={event => { setSelected(index); drag.current = { x: event.clientX, y: event.clientY, rect: item }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (!drag.current || !board.current) return; const bounds = board.current.getBoundingClientRect(); updateRect({ x: Math.round(drag.current.rect.x + (event.clientX - drag.current.x) * 1920 / bounds.width), y: Math.round(drag.current.rect.y + (event.clientY - drag.current.y) * 1080 / bounds.height) }); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onKeyDown={event => { const delta = event.shiftKey ? 1 : 10; if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); updateRect({ x: item.x + (event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0), y: item.y + (event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0) }); } }}>{index + 1}</button>)}
        </div>
        {!scene && <InlineNotice tone="warning">The protected areas leave no room for the scene. Make an area smaller or remove one.</InlineNotice>}
        {rect && <div className="dock-coordinates">{(['x', 'y', 'width', 'height'] as const).map(key => <Field key={key} label={key === 'width' ? 'Width' : key === 'height' ? 'Height' : key.toUpperCase()} type="number" min={key === 'width' || key === 'height' ? 1 : 0} max={key === 'x' || key === 'width' ? 1920 : 1080} value={rect[key]} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) updateRect({ [key]: event.target.valueAsNumber }); }} />)}</div>}
        <div className="st-row"><QuietButton disabled={draft.layout.protectedRects.length >= 6} onClick={() => { setSelected(draft.layout.protectedRects.length); patch({ layout: { ...draft.layout, protectedRects: [...draft.layout.protectedRects, { x: 80, y: 80, width: 640, height: 360 }] } }); }}>Add protected area</QuietButton>{rect && <QuietButton onClick={() => { patch({ layout: { ...draft.layout, protectedRects: draft.layout.protectedRects.filter((_, index) => selected !== index) } }); setSelected(0); }}>Remove area {selected + 1}</QuietButton>}</div>
      </section>
      <section className="st-group" aria-labelledby="st-when">
        <h3 id="st-when">When it plays</h3>
        <Switch label="Show a recap when a raid arrives" checked={draft.autoRaid} onChange={value => patch({ autoRaid: value })} />
        <div className="st-field"><span className="st-label">Scene length</span><SegmentedControl label="Scene length" value={String(draft.recapDurationMs)} onChange={value => patch({ recapDurationMs: Number(value) as Settings['recapDurationMs'] })} options={[{ value: '10000', label: '10 s' }, { value: '12000', label: '12 s' }, { value: '15000', label: '15 s' }]} /></div>
        <Field label="Show recap shortcut" value={draft.hotkey} maxLength={40} hint="Works while the dock has focus. Leave blank to turn it off." onChange={event => patch({ hotkey: event.target.value })} />
      </section>
      <section className="st-group" aria-labelledby="st-sound">
        <h3 id="st-sound">Sound</h3>
        <Switch label="Read the recap aloud" checked={draft.narrationEnabled} onChange={value => patch({ narrationEnabled: value })} />
        <Switch label="Play scene sounds in OBS" checked={draft.broadcastSoundEnabled} onChange={value => patch({ broadcastSoundEnabled: value })} />
        <div className="st-field"><label className="st-label" htmlFor="st-volume">Scene volume <output htmlFor="st-volume">{Math.round(draft.volume * 100)}%</output></label><input id="st-volume" className="st-range" type="range" min="0" max="1" step="0.05" value={draft.volume} style={{ ['--st-fill' as string]: `${draft.volume * 100}%` }} onChange={event => patch({ volume: Number(event.target.value) })} /></div>
      </section>
      <section className="st-group" aria-labelledby="st-clips">
        <h3 id="st-clips">Clips and early welcome</h3>
        <Switch label="Allow automatic Twitch clips" checked={draft.autoClips} onChange={value => patch({ autoClips: value })} hint={recording ? undefined : 'Clips are published on Twitch. Forget removes them from Previously; delete the Twitch clip there.'} />
        <Textarea label="Context for an early welcome" maxLength={500} value={draft.channelContext} hint="Used before the stream has published chapters, for example what you usually build on stream." onChange={event => patch({ channelContext: event.target.value })} />
      </section>
      {import.meta.env.MODE !== 'public' && !recording && <a className="st-setup" href="/setup">Open channel setup</a>}
    </div>
  </Sheet>;
}
