import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Brand, FoundationShowcase, InlineNotice, ReadingLayout } from '../ui/index.js';
import '../styles/index.css';
import './shell.css';

type SetupStatus = {
  mode: 'local' | 'replay'; runtime: string; storage: string;
  missing: string[]; configured: boolean;
  twitch: { connected: boolean };
  openai: { connected: boolean; paidCallsEnabled: boolean };
  auth: { available: boolean; authenticated: boolean };
};
function LocalSetup() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/setup/status', { cache: 'no-store', signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('setup'); return response.json() as Promise<SetupStatus>; })
      .then(setStatus).catch(error => { if (error.name !== 'AbortError') setError(true); });
    return () => controller.abort();
  }, []);
  return <main className="setup-shell">
    <header className="setup-shell__header"><Brand /><a href="/foundation">Interface examples</a></header>
    <ReadingLayout>
      <h1>Set up your channel</h1>
      <p className="setup-shell__lead">Bring the story of your stream to people arriving late.</p>
      {!status && !error && <p role="status">Checking local setup…</p>}
      {error && <InlineNotice tone="danger">Local setup could not be checked. Reload this page after restarting Previously.</InlineNotice>}
      {status && <>
        <dl className="setup-shell__checks">
          <div><dt>Local storage</dt><dd>{status.storage === 'ready' ? 'Ready on this computer' : 'Unavailable'}</dd></div>
          <div><dt>Twitch</dt><dd>{status.twitch.connected ? 'Connected' : 'Not connected'}</dd></div>
          <div><dt>Microphone</dt><dd>Not listening</dd></div>
          <div><dt>OpenAI requests</dt><dd>{status.openai.paidCallsEnabled ? 'Enabled' : 'Off'}</dd></div>
        </dl>
        {status.missing.length > 0 && <div className="setup-shell__missing"><h2>Settings to complete</h2><p>Add these values to your local <code>.env</code> file. Keep their values private.</p><ul>{status.missing.map(name => <li key={name}><code>{name}</code></li>)}</ul></div>}
        <InlineNotice>Listening starts only when you choose to start it. No speech or chat is being captured.</InlineNotice>
        {status.auth.available && <a className="setup-shell__connect" href="/api/auth/twitch/start?returnTo=%2Fdock">Connect Twitch</a>}
      </>}
    </ReadingLayout>
  </main>;
}

function App() {
  return location.pathname === '/foundation' ? <FoundationShowcase /> : <LocalSetup />;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
