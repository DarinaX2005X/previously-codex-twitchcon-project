import { useRef, useState } from 'react';
import type { RecapClient, Rect, Settings } from '../../shared/contracts';
import { ActionGroup, Button, Field, InlineNotice, QuietButton, Select, Sheet, Textarea } from '../../ui';
import { errorCode } from '../dock/model';
import './settings.css';

export interface SettingsSheetProps { settings: Settings; client: RecapClient; onClose(): void; onSaved(): void; recording?: boolean; }
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
  return <Sheet open onOpenChange={open => { if (!open) onClose(); }} title="Scene settings" description={recording ? 'These choices apply only to this recording.' : undefined} className="dock-paper" footer={<ActionGroup><Button pending={pending} onClick={() => void save()}>Save settings</Button><QuietButton onClick={onClose}>Cancel</QuietButton></ActionGroup>}>
    {error && <InlineNotice tone="danger" live>{error}</InlineNotice>}
    <div className="dock-settings">
      <Select label="Scene position" value={draft.layout.preset} options={['left', 'right', 'lower', 'upper'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) }))} onChange={event => patch({ layout: { ...draft.layout, preset: event.target.value as Settings['layout']['preset'] } })} />
      <section><h3>Protected areas</h3><p className="pv-secondary">Drag an area or enter its coordinates. The scene stays 24 px clear of each area.</p>
        <div className="dock-safe-board" ref={board} aria-label="1920 by 1080 broadcast canvas">
          {draft.layout.protectedRects.map((item, index) => <button type="button" key={index} className="dock-safe-rect" data-selected={selected === index} style={{ left: `${item.x / 19.2}%`, top: `${item.y / 10.8}%`, width: `${item.width / 19.2}%`, height: `${item.height / 10.8}%` }} aria-label={`Protected area ${index + 1}. Arrow keys move it by 10 pixels.`} onFocus={() => setSelected(index)} onPointerDown={event => { setSelected(index); drag.current = { x: event.clientX, y: event.clientY, rect: item }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (!drag.current || !board.current) return; const bounds = board.current.getBoundingClientRect(); updateRect({ x: Math.round(drag.current.rect.x + (event.clientX - drag.current.x) * 1920 / bounds.width), y: Math.round(drag.current.rect.y + (event.clientY - drag.current.y) * 1080 / bounds.height) }); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onKeyDown={event => { const delta = event.shiftKey ? 1 : 10; if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); updateRect({ x: item.x + (event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0), y: item.y + (event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0) }); } }}>{index + 1}</button>)}
        </div>
        {rect && <div className="dock-coordinates">{(['x', 'y', 'width', 'height'] as const).map(key => <Field key={key} label={key === 'width' ? 'Width' : key === 'height' ? 'Height' : key.toUpperCase()} type="number" min={key === 'width' || key === 'height' ? 1 : 0} max={key === 'x' || key === 'width' ? 1920 : 1080} value={rect[key]} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) updateRect({ [key]: event.target.valueAsNumber }); }} />)}</div>}
        <ActionGroup><QuietButton disabled={draft.layout.protectedRects.length >= 6} onClick={() => { setSelected(draft.layout.protectedRects.length); patch({ layout: { ...draft.layout, protectedRects: [...draft.layout.protectedRects, { x: 80, y: 80, width: 640, height: 360 }] } }); }}>Add protected area</QuietButton>{rect && <QuietButton onClick={() => { patch({ layout: { ...draft.layout, protectedRects: draft.layout.protectedRects.filter((_, index) => selected !== index) } }); setSelected(0); }}>Remove area</QuietButton>}</ActionGroup>
      </section>
      <label className="dock-check"><input type="checkbox" checked={draft.narrationEnabled} onChange={event => patch({ narrationEnabled: event.target.checked })} />Read the recap aloud</label>
      <label className="dock-check"><input type="checkbox" checked={draft.broadcastSoundEnabled} onChange={event => patch({ broadcastSoundEnabled: event.target.checked })} />Play scene sounds in OBS</label>
      <Field label="Scene volume" type="range" min="0" max="1" step="0.05" value={draft.volume} onChange={event => patch({ volume: Number(event.target.value) })} hint={`${Math.round(draft.volume * 100)}%`} />
      <Select label="Scene length" value={String(draft.recapDurationMs)} options={[{ value: '10000', label: '10 seconds' }, { value: '12000', label: '12 seconds' }, { value: '15000', label: '15 seconds' }]} onChange={event => patch({ recapDurationMs: Number(event.target.value) as Settings['recapDurationMs'] })} />
      <Field label="Show recap shortcut" value={draft.hotkey} maxLength={40} hint="Works while this dock has focus. If your browser uses these keys, choose another binding. Leave blank to disable." onChange={event => patch({ hotkey: event.target.value })} />
      <label className="dock-check"><input type="checkbox" checked={draft.autoRaid} onChange={event => patch({ autoRaid: event.target.checked })} />Show a recap when a raid arrives</label>
      <label className="dock-check"><input type="checkbox" checked={draft.autoClips} onChange={event => patch({ autoClips: event.target.checked })} />Allow automatic Twitch clips</label>
      {!recording && <p className="pv-secondary">Clips are published on Twitch. Forget removes them from Previously; delete the Twitch clip separately.</p>}
      <Textarea label="Context for an early welcome" maxLength={500} value={draft.channelContext} hint="Optional context to use before the stream has published chapters." onChange={event => patch({ channelContext: event.target.value })} />
    </div>
  </Sheet>;
}
