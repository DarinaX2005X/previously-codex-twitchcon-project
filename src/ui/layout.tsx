import type { HTMLAttributes, ReactNode } from 'react';

export interface DockLayoutProps extends HTMLAttributes<HTMLElement> { header: ReactNode; children: ReactNode; }
export function DockLayout({ header, children, className, ...props }: DockLayoutProps) {
  return <section {...props} data-theme="dark" className={['pv-dock', className].filter(Boolean).join(' ')}><div className="pv-dock__top">{header}</div><div className="pv-dock__history">{children}</div></section>;
}
export interface ReadingLayoutProps extends HTMLAttributes<HTMLElement> { children: ReactNode; }
export function ReadingLayout({ children, className, ...props }: ReadingLayoutProps) { return <section {...props} data-theme="light" className={['pv-reading', className].filter(Boolean).join(' ')}>{children}</section>; }
export interface ActionGroupProps { children: ReactNode; className?: string; }
export function ActionGroup({ children, className }: ActionGroupProps) { return <div className={['pv-actions', className].filter(Boolean).join(' ')}>{children}</div>; }
export interface BrandProps { variant?: 'wordmark' | 'mark' | 'small-mark'; tone?: 'light' | 'dark'; className?: string; }
/** The mark plus the outlined word. The word takes the surrounding text colour; `tone` forces ink (light ground) or paper (dark ground). */
export function Brand({ variant = 'wordmark', tone, className }: BrandProps) {
  const style = tone ? { color: tone === 'dark' ? 'var(--pv-paper)' : 'var(--pv-ink)' } : undefined;
  const mark = variant === 'small-mark' ? 'mark-small' : 'mark';
  return <span role="img" aria-label="Previously" style={style} className={['pv-brand', `pv-brand--${variant}`, className].filter(Boolean).join(' ')}>
    <img className="pv-brand__mark" src={`/brand/${mark}.svg`} alt="" width="96" height="96" />
    {variant === 'wordmark' && <span className="pv-brand__word" aria-hidden="true" />}
  </span>;
}
