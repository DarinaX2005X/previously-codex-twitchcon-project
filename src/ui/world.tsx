import { useState, type HTMLAttributes, type ReactNode } from 'react';
import { formatTimecode } from './story';

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

export interface TitleCardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  /** Source time for the timecode tab cut into the top edge. */
  atMs?: number;
  tone?: 'paper' | 'ink' | 'now';
  /** Colour of the ground the card sits on, so the tab reads as a cut. Defaults to ink. */
  ground?: string;
  meta?: ReactNode;
  as?: 'article' | 'div' | 'li' | 'section';
  children?: ReactNode;
}
/** A chapter title card: thick matte card with a timecode tab cut into its top edge. */
export function TitleCard({ title, atMs, tone = 'paper', ground, meta, as: Tag = 'article', children, className, style, ...props }: TitleCardProps) {
  return <Tag {...props} style={ground ? { ...style, ['--pv-tab-ground' as string]: ground } : style} className={cx('pv-card', tone !== 'paper' && `pv-card--${tone}`, atMs !== undefined && 'pv-card--tabbed', className)}>
    {atMs !== undefined && <span className={cx('pv-tab', tone === 'now' && 'pv-tab--now')}>{formatTimecode(atMs)}</span>}
    <h3 className="pv-card__title">{title}</h3>
    {children && <div className="pv-card__body">{children}</div>}
    {meta && <div className="pv-card__meta">{meta}</div>}
  </Tag>;
}

export interface ClipFrameProps extends HTMLAttributes<HTMLElement> { src?: string; poster?: string; label: string; autoPlay?: boolean; loop?: boolean; children?: ReactNode; }
/** A clip inside a rounded frame with a thin inner bevel. Shows the poster alone when there is no video. */
export function ClipFrame({ src, poster, label, autoPlay = false, loop = true, children, className, ...props }: ClipFrameProps) {
  const [failed, setFailed] = useState<string | null>(null);
  if (src && failed === src && !poster) return null;
  // Hovering a still clip plays it; leaving pauses it again.
  const play = (event: { currentTarget: HTMLElement }) => { const v = event.currentTarget.querySelector('video'); if (v && v.paused) void v.play().catch(() => undefined); };
  const stop = (event: { currentTarget: HTMLElement }) => { const v = event.currentTarget.querySelector('video'); if (v && !autoPlay) v.pause(); };
  return <figure {...props} onMouseEnter={play} onMouseLeave={stop} className={cx('pv-frame', className)}>
    {src && failed !== src ? <video onError={() => setFailed(src)} src={poster || src.includes('#') ? src : `${src}#t=0.1`} poster={poster} muted playsInline autoPlay={autoPlay} loop={loop} preload="metadata" aria-label={label} /> : poster ? <img src={poster} alt={label} /> : null}
    {children}
  </figure>;
}

export interface ChatSlipProps extends HTMLAttributes<HTMLElement> { who?: string; children: ReactNode; }
/** One chat message as a small slip with a lime underside. */
export function ChatSlip({ who, children, className, ...props }: ChatSlipProps) {
  return <p {...props} className={cx('pv-slip', className)}>{who && <span className="pv-slip__who">{who}</span>}<span>{children}</span></p>;
}

/** The one highlighted phrase of a view, set on a plate. */
export function Plate({ children, tone = 'vermilion', className }: { children: ReactNode; tone?: 'vermilion' | 'paper'; className?: string }) {
  return <mark className={cx('pv-plate', tone === 'paper' && 'pv-plate--paper', className)}>{children}</mark>;
}

export interface LorePlateProps { term: string; explanation?: ReactNode; originMs?: number; className?: string; }
/** A running joke on a vermilion plate with its origin time stamped in the corner. */
export function LorePlate({ term, explanation, originMs, className }: LorePlateProps) {
  return <div className={cx('pv-lore', className)}>
    {originMs !== undefined && <span className="pv-lore__stamp">{formatTimecode(originMs)}</span>}
    <span className="pv-lore__term">{term}</span>
    {explanation && <span className="pv-lore__text">{explanation}</span>}
  </div>;
}

/** Listening or live state, with a lime dot. */
export function LiveState({ children, paused = false }: { children: ReactNode; paused?: boolean }) {
  return <span className="pv-live" data-state={paused ? 'paused' : 'live'}>{children}</span>;
}
