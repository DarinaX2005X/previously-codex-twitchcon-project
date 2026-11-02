import { useEffect, useRef, useState } from 'react';
import type { PrivacyTarget, Source } from '../../shared/contracts';
import { ActionGroup, InlineNotice, QuietButton, Sheet, Timecode } from '../../ui';
import type { DockOwnerPort } from './ports';

export type SourceContext = { sessionId: string; fromMs: number; toMs: number; title: string };
export function SourceSheet({ context, owner, onClose, onForget }: { context: SourceContext; owner: DockOwnerPort; onClose(): void; onForget(target: PrivacyTarget): void }) {
  const [items, setItems] = useState<Source[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const busy = useRef(false);
  async function load(next?: string) {
    if (busy.current) return;
    busy.current = true; setLoading(true); setError('');
    const ticket = ++generation.current;
    try {
      const page = await owner.listSources({ sessionId: context.sessionId, fromMs: context.fromMs, toMs: context.toMs, limit: 20, ...(next ? { cursor: next } : {}) });
      if (ticket !== generation.current) return;
      // Never display unreviewed text, even when a server adapter supplies it accidentally.
      const safe = page.items.filter(item => item.status === 'active').map(item => ({ ...item, text: ['allowed', 'redacted'].includes(item.moderation) ? item.text : null }));
      setItems(previous => next ? [...previous, ...safe] : safe); setCursor(page.nextCursor);
    } catch { if (ticket === generation.current) setError('Could not load these sources. Retry sources.'); }
    finally { if (ticket === generation.current) { busy.current = false; setLoading(false); } }
  }
  // Reset busy too: StrictMode remounts after the first load's finally was fenced off.
  useEffect(() => { void load(); return () => { ++generation.current; busy.current = false; }; }, []);
  return <Sheet open onOpenChange={open => { if (!open) onClose(); }} title="Chapter sources" description={context.title} className="dock-paper" footer={<QuietButton onClick={onClose}>Close sources</QuietButton>}>
    <p className="pv-secondary">Deleting a chapter keeps these sources. Forget removes an interval and anything derived from it.</p>
    {error && <InlineNotice tone="danger" action={<QuietButton onClick={() => void load(cursor ?? undefined)}>Retry sources</QuietButton>}>{error}</InlineNotice>}
    {!loading && !items.length && !error && <p>No available sources in this interval.</p>}
    {items.map(item => <article key={item.id} className="dock-source"><div><Timecode milliseconds={item.startMs} /><span>{item.kind === 'speech' ? 'Speech' : item.kind === 'chat' ? 'Chat' : 'Stream context'}</span></div>{item.text ? <blockquote>{item.text}</blockquote> : <p>{item.moderation === 'pending' ? 'Source text is waiting for its safety check.' : 'Source text is unavailable.'}</p>}<QuietButton tone="danger" onClick={() => onForget({ kind: 'interval', sessionId: context.sessionId, fromMs: item.startMs, toMs: item.endMs })}>Forget this source interval</QuietButton></article>)}
    <ActionGroup>{loading && <p role="status">Loading sources…</p>}{cursor && <QuietButton pending={loading} onClick={() => void load(cursor)}>More sources</QuietButton>}</ActionGroup>
  </Sheet>;
}
