import { useEffect, useId, useRef, type ReactNode } from 'react';
import { IconButton } from './controls';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  dismissible?: boolean;
  closeLabel?: string;
  className?: string;
}

function Modal({ open, onOpenChange, title, description, children, footer, dismissible = true, closeLabel = 'Close', className, sheet = false }: DialogProps & { sheet?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    }
  }, [open]);
  useEffect(() => () => {
    if (returnFocus.current?.isConnected) returnFocus.current.focus();
  }, []);
  return <dialog ref={ref} className={['pv-dialog', sheet && 'pv-dialog--sheet', className].filter(Boolean).join(' ')} aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
    onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); if (dismissible) onOpenChange(false); }}
    onClose={event => { if (event.target === event.currentTarget && open) onOpenChange(false); }}>
    <div className="pv-dialog__header"><h2 id={titleId}>{title}</h2>{dismissible && <IconButton label={closeLabel} onClick={() => onOpenChange(false)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></IconButton>}</div>
    {description && <p id={descriptionId} className="pv-dialog__description">{description}</p>}
    <div className="pv-dialog__body">{children}</div>
    {footer && <div className="pv-dialog__footer">{footer}</div>}
  </dialog>;
}

export function Dialog(props: DialogProps) { return <Modal {...props} />; }
export function Sheet(props: DialogProps) { return <Modal {...props} sheet />; }
