import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  pending?: boolean;
  tone?: 'primary' | 'quiet' | 'danger' | 'text';
  size?: 'regular' | 'large';
}

export function Button({ children, pending = false, disabled, tone = 'primary', size = 'regular', className, type = 'button', ...props }: ButtonProps) {
  return <button {...props} type={type} disabled={disabled || pending} aria-busy={pending || undefined} className={cx('pv-button', `pv-button--${tone}`, size === 'large' && 'pv-button--large', className)}>
    <span className="pv-button__label">{children}</span>
    {pending && <span className="pv-spinner" aria-hidden="true" />}
  </button>;
}

export function QuietButton(props: ButtonProps) { return <Button {...props} tone={props.tone ?? 'quiet'} />; }
export function TextButton(props: ButtonProps) { return <Button {...props} tone={props.tone ?? 'text'} />; }

/** Class names for a link that looks like a button: `<a className={buttonClass('primary')}>`. */
export function buttonClass(tone: NonNullable<ButtonProps['tone']> = 'primary', size: NonNullable<ButtonProps['size']> = 'regular', className?: string) {
  return cx('pv-button', `pv-button--${tone}`, size === 'large' && 'pv-button--large', className);
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'aria-label'> {
  label: string;
  children: ReactNode;
}
export function IconButton({ label, children, className, ...props }: IconButtonProps) {
  return <Button {...props} tone={props.tone ?? 'quiet'} aria-label={label} title={label} className={cx('pv-icon-button', className)}>{children}</Button>;
}

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> { label: string; hint?: ReactNode; error?: string; }
export function Field({ label, hint, error, id, className, 'aria-describedby': describedBy, ...props }: FieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  return <div className={cx('pv-field', className)}>
    <label htmlFor={fieldId}>{label}</label>
    <input {...props} id={fieldId} className="pv-input" aria-invalid={error ? true : props['aria-invalid']} aria-describedby={[describedBy, hint && `${fieldId}-hint`, error && `${fieldId}-error`].filter(Boolean).join(' ') || undefined} />
    {hint && <div id={`${fieldId}-hint`} className="pv-field__hint">{hint}</div>}
    {error && <p id={`${fieldId}-error`} className="pv-field__error">{error}</p>}
  </div>;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> { label: string; hint?: ReactNode; error?: string; }
export function Textarea({ label, hint, error, id, className, 'aria-describedby': describedBy, ...props }: TextareaProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  return <div className={cx('pv-field', className)}>
    <label htmlFor={fieldId}>{label}</label>
    <textarea rows={4} {...props} id={fieldId} className="pv-input pv-textarea" aria-invalid={error ? true : props['aria-invalid']} aria-describedby={[describedBy, hint && `${fieldId}-hint`, error && `${fieldId}-error`].filter(Boolean).join(' ') || undefined} />
    {hint && <div id={`${fieldId}-hint`} className="pv-field__hint">{hint}</div>}
    {error && <p id={`${fieldId}-error`} className="pv-field__error">{error}</p>}
  </div>;
}

export interface SelectOption { value: string; label: string; disabled?: boolean; }
export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> { label: string; hint?: ReactNode; error?: string; options: readonly SelectOption[]; }
export function Select({ label, hint, error, options, id, className, 'aria-describedby': describedBy, ...props }: SelectProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  return <div className={cx('pv-field', className)}>
    <label htmlFor={fieldId}>{label}</label>
    <div className="pv-select-wrap"><select {...props} id={fieldId} className="pv-input pv-select" aria-invalid={error ? true : props['aria-invalid']} aria-describedby={[describedBy, hint && `${fieldId}-hint`, error && `${fieldId}-error`].filter(Boolean).join(' ') || undefined}>
      {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7 5 5 5-5" /></svg></div>
    {hint && <div id={`${fieldId}-hint`} className="pv-field__hint">{hint}</div>}
    {error && <p id={`${fieldId}-error`} className="pv-field__error">{error}</p>}
  </div>;
}

export interface SegmentedControlProps { label: string; value: string; options: readonly SelectOption[]; onChange: (value: string) => void; disabled?: boolean; className?: string; }
export function SegmentedControl({ label, value, options, onChange, disabled, className }: SegmentedControlProps) {
  const name = useId();
  return <fieldset disabled={disabled} className={cx('pv-segments', className)}>
    <legend className="pv-sr-only">{label}</legend>
    <div className="pv-segments__rail">{options.map(option => <label key={option.value} className="pv-segment">
      <input type="radio" name={name} value={option.value} checked={value === option.value} disabled={option.disabled} onChange={() => onChange(option.value)} />
      <span>{option.label}</span>
    </label>)}</div>
  </fieldset>;
}
