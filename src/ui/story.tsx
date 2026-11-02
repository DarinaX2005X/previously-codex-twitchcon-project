import { useEffect, useId, useState, type ReactNode } from 'react';
import { Button, SegmentedControl } from './controls';
import { hasOwnCatalog, type RecapLanguage } from '../i18n';
import { COMMON_RECAP_LANGUAGES, englishLanguageName, nativeLanguageName, resolveLanguageInput } from '../shared/languages';

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

export interface LanguageControlProps { value: RecapLanguage; onChange: (value: RecapLanguage) => void; disabled?: boolean; label?: string; showHint?: boolean; /** Fixed choices, for example the languages a recording contains. Without it any language can be picked. */ options?: readonly RecapLanguage[]; }
export function LanguageControl({ value, onChange, disabled, label = 'Recap language', showHint = true, options }: LanguageControlProps) {
  if (options) return <div className="pv-language"><span>{label}</span><SegmentedControl label={label} value={value} onChange={next => { if (options.includes(next)) onChange(next); }} disabled={disabled} options={options.map(code => ({ value: code, label: nativeLanguageName(code) }))} />{showHint && <p className="pv-secondary">Your speech language is detected automatically.</p>}</div>;
  return <LanguagePicker value={value} onChange={onChange} disabled={disabled} label={label} showHint={showHint} />;
}

/** A searchable list of common languages by their own names, plus any other language by its code (es, pt-BR, zh-Hant). */
function LanguagePicker({ value, onChange, disabled, label, showHint }: Required<Pick<LanguageControlProps, 'label' | 'showHint'>> & Omit<LanguageControlProps, 'options' | 'label' | 'showHint'>) {
  const id = useId(), listId = `${id}-list`, hintId = `${id}-hint`, errorId = `${id}-error`;
  const [text, setText] = useState(() => nativeLanguageName(value));
  useEffect(() => { setText(nativeLanguageName(value)); }, [value]);
  const resolved = resolveLanguageInput(text), changed = resolved !== null && resolved !== value, invalid = text.trim() !== '' && resolved === null;
  const labels = hasOwnCatalog(value) ? 'Scene labels and chat bot replies use it too.' : `Scene labels and chat bot replies stay in English for ${englishLanguageName(value)}; the story itself is written in it.`;
  return <form className="pv-language" onSubmit={event => { event.preventDefault(); if (changed && !disabled) onChange(resolved); }}>
    <label htmlFor={id}>{label}</label>
    <div className="pv-language__pick">
      <input id={id} className="pv-input" list={listId} value={text} disabled={disabled} autoComplete="off" spellCheck={false} aria-invalid={invalid || undefined} aria-describedby={[showHint && hintId, invalid && errorId].filter(Boolean).join(' ') || undefined} onFocus={event => event.currentTarget.select()} onChange={event => setText(event.currentTarget.value)} />
      <Button type="submit" tone="quiet" disabled={disabled || !changed}>Use</Button>
    </div>
    <datalist id={listId}>{COMMON_RECAP_LANGUAGES.map(code => <option key={code} value={nativeLanguageName(code)} label={`${englishLanguageName(code)} · ${code}`} />)}</datalist>
    {invalid && <p id={errorId} className="pv-field__error">Pick a language from the list or type its code, such as es or pt-BR.</p>}
    {showHint && <p id={hintId} className="pv-secondary">Chapters, summaries and lore are written in {englishLanguageName(value)} ({value}). {labels} Your speech language is detected automatically.</p>}
  </form>;
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
