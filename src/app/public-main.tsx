import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Brand, ReadingLayout } from '../ui/index.js';
import '../styles/index.css';
import './shell.css';

function PublicEntry() {
  return <main className="setup-shell"><header className="setup-shell__header"><Brand /></header><ReadingLayout><h1>Catch up with the stream while it keeps going</h1><p className="setup-shell__lead">Previously brings the moments that explain what is happening now into one readable story.</p><a href="https://github.com/DarinaX2005X/previously-codex-twitchcon-project">Open the project</a></ReadingLayout></main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><PublicEntry /></StrictMode>);
