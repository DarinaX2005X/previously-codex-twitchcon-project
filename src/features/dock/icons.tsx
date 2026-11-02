import './icons.css';
/** One small stroke icon family (24 grid, 2 px stroke, round joins) for the dock, setup and public recap. */
const paths = {
  gear: <><path d="m10 3-.7 2.1-1.6.9-2.2-.4-2 3.4 1.5 1.7v1.9L3.5 14l2 3.4 2.2-.4 1.6.9.7 2.1h4l.7-2.1 1.6-.9 2.2.4 2-3.4-1.5-1.7v-1.9l1.5-1.7-2-3.4-2.2.4-1.6-.9L14 3Z" /><circle cx="12" cy="11.5" r="3" /></>,
  pause: <><rect x="6.5" y="5" width="3.5" height="14" rx="1" /><rect x="14" y="5" width="3.5" height="14" rx="1" /></>,
  play: <path d="M7.5 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L8.7 4.5a.8.8 0 0 0-1.2.7Z" />,
  rewind: <><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v4.5h4.5" /><path d="M12 8v4l2.5 1.5" /></>,
  bookmark: <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z" />,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>,
  pin: <><path d="M9 4h6l-1 6 3.5 3.5h-11L10 10 9 4Z" /><path d="M12 13.5V20" /></>,
  pencil: <><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
  trash: <><path d="M4.5 7h15" /><path d="M9.5 7V4.5h5V7" /><path d="M6.5 7l1 12.5h9l1-12.5" /></>,
  quote: <><path d="M5 6h14v10H9l-4 3.5V6Z" /><path d="M9 10h6M9 13h4" /></>,
  alert: <><path d="M12 4 2.8 19.5h18.4L12 4Z" /><path d="M12 10v4.2M12 16.9v.1" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" /></>,
  mic: <><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" /></>,
  chat: <path d="M4 5.5h16v10.5H10l-4.5 3.5V16H4V5.5Z" />,
  cast: <><rect x="3" y="5" width="18" height="12" rx="2.5" /><path d="M8 20.5h8" /><path d="m10 9 4.5 2-4.5 2V9Z" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14.5 8.5l2 2" /></>,
  terminal: <><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17" /></>,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <svg className={['dk-icon', className].filter(Boolean).join(' ')} viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
