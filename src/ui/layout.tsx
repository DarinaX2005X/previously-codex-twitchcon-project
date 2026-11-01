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
export function Brand({ variant = 'wordmark', tone = 'light', className }: BrandProps) {
  const asset = variant === 'wordmark' ? `wordmark${tone === 'dark' ? '-dark' : ''}` : variant === 'small-mark' ? `mark-small${tone === 'dark' ? '-dark' : ''}` : 'mark';
  return <img className={['pv-brand', `pv-brand--${variant}`, className].filter(Boolean).join(' ')} src={`/brand/${asset}.svg`} alt="Previously" width={variant === 'wordmark' ? 480 : 96} height="96" />;
}
