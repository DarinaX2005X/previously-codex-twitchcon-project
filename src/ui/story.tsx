import { useEffect, useState, type ReactNode } from 'react';
import { Button, SegmentedControl } from './controls';
import type { RecapLanguage } from '../i18n';

export interface InlineNoticeProps { children: ReactNode; tone?: 'info' | 'success' | 'warning' | 'danger'; action?: ReactNode; live?: boolean; }
export function InlineNotice({ children, tone = 'info', action, live = false }: InlineNoticeProps) {
  return <div className={`pv-notice pv-notice--${tone}`} role={live ? (tone === 'danger' ? 'alert' : 'status') : undefined}><div>{children}</div>{action && <div className="pv-notice__action">{action}</div>}</div>;
}

export interface SourceStatusProps { label: string; state: 'ready' | 'pending' | 'paused' | 'unavailable' | 'error'; observation: string; }
export function SourceStatus({ label, state, observation }: SourceStatusProps) {
  return <div className="pv-source-status" data-state={state}><span className="pv-source-status__label">{label}</span><span className="pv-source-status__observation">{observation}</span></div>;
}

export function formatTimecode(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const tail = `${minutes.toString().padStart(hours ? 2 : 1, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  return hours ? `${hours}:${tail}` : tail;
}
export interface TimecodeProps { milliseconds: number; onSeek?: (milliseconds: number) => void; label?: string; }
export function Timecode({ milliseconds, onSeek, label }: TimecodeProps) {
  const value = formatTimecode(milliseconds);
  return onSeek ? <button type="button" className="pv-timecode pv-timecode--action" aria-label={label ?? `Go to ${value}`} onClick={() => onSeek(milliseconds)}>{value}</button> : <span className="pv-timecode">{value}</span>;
}

export interface LanguageControlProps { value: RecapLanguage; onChange: (value: RecapLanguage) => void; disabled?: boolean; label?: string; showHint?: boolean; }
export function LanguageControl({ value, onChange, disabled, label = 'Recap language', showHint = true }: LanguageControlProps) {
  return <div className="pv-language"><span>{label}</span><SegmentedControl label={label} value={value} onChange={next => { if (next === 'en' || next === 'ru') onChange(next); }} disabled={disabled} options={[{ value: 'en', label: 'English' }, { value: 'ru', label: 'Русский' }]} />{showHint && <p className="pv-secondary">Your speech language is detected automatically.</p>}</div>;
}

export interface ChapterRowProps { title: string; children: ReactNode; atMs?: number; onSeek?: (milliseconds: number) => void; state?: ReactNode; actions?: ReactNode; sources?: ReactNode; selected?: boolean; className?: string; }
export function ChapterRow({ title, children, atMs, onSeek, state, actions, sources, selected = false, className }: ChapterRowProps) {
  return <article className={['pv-chapter', selected && 'pv-chapter--selected', className].filter(Boolean).join(' ')}>
    {atMs !== undefined && <div className="pv-chapter__time"><Timecode milliseconds={atMs} onSeek={onSeek} /></div>}
    <div className="pv-chapter__content">{state && <div className="pv-chapter__state">{state}</div>}<h3>{title}</h3><div className="pv-chapter__text">{children}</div>{sources}{actions && <div className="pv-chapter__actions">{actions}</div>}</div>
  </article>;
}

export interface SourceDisclosureProps { label: string; children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void; }
export function SourceDisclosure({ label, children, open, onOpenChange }: SourceDisclosureProps) {
  return <details className="pv-sources" open={open} onToggle={onOpenChange ? event => { const next = event.currentTarget.open; if (next !== open) onOpenChange(next); } : undefined}><summary><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg><span>{label}</span></summary><div className="pv-sources__body">{children}</div></details>;
}

export interface MomentPlayerProps { title: string; atMs: number; src?: string; poster?: string; sourceText?: string; unavailableMessage?: string; onRetry?: () => void; muted?: boolean; }
export function MomentPlayer({ title, atMs, src, poster, sourceText, unavailableMessage = 'Clip unavailable. The source time is still available.', onRetry, muted = true }: MomentPlayerProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <figure className="pv-moment"><figcaption><strong>{title}</strong><Timecode milliseconds={atMs} /></figcaption>
    {src && !failed ? <video key={src} controls playsInline preload="metadata" muted={muted} poster={poster} aria-label={title} onError={() => setFailed(true)}><source src={src} />Your browser cannot play this clip.</video> : <div className="pv-moment__unavailable"><p>{unavailableMessage}</p>{onRetry && <Button tone="quiet" onClick={() => { setFailed(false); onRetry(); }}>Retry clip</Button>}</div>}
    {sourceText && <blockquote>{sourceText}</blockquote>}
  </figure>;
}
