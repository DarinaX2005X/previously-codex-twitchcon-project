import { useRef, useState } from 'react';
import { safetyAllowsPublication, type Lore, type InvalidationReceipt } from '../../shared/contracts';
import { ActionGroup, Button, Field, InlineNotice, QuietButton, Sheet, SourceDisclosure, Textarea, Timecode } from '../../ui';
import { errorCode } from './model';
import type { DockOwnerPort } from './ports';

export function LoreRow({ lore, owner, onSaved, onSource }: { lore: Lore; owner?: DockOwnerPort; onSaved(result?: Lore | InvalidationReceipt): void; onSource(): void }) {
  const [open, setOpen] = useState(false), [editing, setEditing] = useState(false);
  const [term, setTerm] = useState(lore.term), [explanation, setExplanation] = useState(lore.explanation);
  const [origin, setOrigin] = useState(lore.originMs === null ? '' : String(lore.originMs / 1000));
  const [pending, setPending] = useState(''), [error, setError] = useState('');
  const busy = useRef(false);
  async function act(action: string, run: () => Promise<Lore | InvalidationReceipt>) {
    if (busy.current) return;
    busy.current = true; setPending(action); setError('');
    try { const result = await run(); setEditing(false); onSaved(result); }
    catch (cause) { setError(errorCode(cause) === 'revision_conflict' ? 'This origin changed. Compare the refreshed version before confirming. Your edit is still here.' : 'Could not save this lore. Your edit is still here. Try again.'); onSaved(); }
    finally { busy.current = false; setPending(''); }
  }
  return <article className="dock-lore"><div className="dock-lore-heading"><h3>{lore.term}</h3><span>First seen <Timecode milliseconds={lore.firstSeenMs} /></span></div><p className="pv-secondary">{lore.status === 'held' || lore.originMs === null ? 'Origin needs confirmation' : 'Origin confirmed. Waiting for publication checks.'}</p>
    {error && <InlineNotice tone="danger" live>{error}</InlineNotice>}
    <SourceDisclosure label="Review origin" open={open} onOpenChange={setOpen}>
      <p>{lore.originMs === null ? 'Confirm only an origin supported by these sources.' : safetyAllowsPublication(lore.safety) ? lore.explanation : 'The origin wording is awaiting a safety check.'}</p>
      <p className="pv-secondary">{lore.safety.pii === 'review' ? 'Evidence is hidden because it may include personal information.' : lore.safety.moderation === 'pending' ? 'Evidence is waiting for its safety check.' : 'Open sources to inspect the available redacted evidence.'}</p>
      {owner ? <ActionGroup><QuietButton onClick={onSource}>Source</QuietButton><QuietButton disabled={!!pending} onClick={() => setEditing(true)}>Edit origin</QuietButton><QuietButton disabled={!!pending} pending={pending === 'confirm'} onClick={() => void act('confirm', () => owner.confirmLore(lore.id, lore.revision))}>Confirm origin</QuietButton><QuietButton pending={pending === 'discard'} disabled={!!pending} onClick={() => void act('discard', () => owner.deleteLore(lore.id, lore.revision))}>Discard</QuietButton><QuietButton tone="danger" pending={pending === 'block'} disabled={!!pending} onClick={() => void act('block', () => owner.blockLore(lore.id, true, lore.revision))}>Block term</QuietButton></ActionGroup> : <p className="pv-secondary">This recording has no editable origin evidence.</p>}
    </SourceDisclosure>
    <Sheet open={editing} onOpenChange={setEditing} title="Edit lore origin" className="dock-paper" footer={<ActionGroup><Button pending={pending === 'edit'} disabled={!term.trim() || !explanation.trim() || (origin !== '' && (!Number.isFinite(Number(origin)) || Number(origin) < 0 || Number(origin) > 172800))} onClick={() => owner && void act('edit', () => owner.editLore(lore.id, { term, explanation, originMs: origin === '' ? null : Math.round(Number(origin) * 1000), baseRevision: lore.revision }))}>Save origin</Button><QuietButton onClick={() => setEditing(false)}>Cancel</QuietButton></ActionGroup>}>
      <Field label="Term" value={term} maxLength={120} onChange={event => setTerm(event.target.value)} /><Textarea label="Origin explanation" maxLength={700} value={explanation} onChange={event => setExplanation(event.target.value)} /><Field label="Origin time in seconds" type="number" min="0" max="172800" value={origin} hint="Leave blank if the origin is unknown. Confirming does not bypass the safety check." onChange={event => setOrigin(event.target.value)} />{error && <InlineNotice tone="danger">{error}</InlineNotice>}
    </Sheet>
  </article>;
}
