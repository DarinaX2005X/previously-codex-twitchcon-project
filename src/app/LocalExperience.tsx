import {useEffect, useMemo, useState} from 'react';
import {DockPage} from '../features/dock/index.js';
import {SetupPage} from '../features/setup/index.js';
import {OverlayPage, ScenePreview} from '../features/overlay/index.js';
import {OwnerHttpClient, OverlayHttpClient} from '../shared/http-client.js';
import type {RecapPlan} from '../shared/contracts/index.js';
import {browserCapture, ownerPorts, setupPorts} from './owner-adapters.js';
import {QuietButton} from '../ui/index.js';

function LocalPreview({plan}: {plan: RecapPlan}) {
  const [status, setStatus] = useState('ready');
  return <div className="app-preview"><ScenePreview plan={plan} playing resolveMedia={id => `/api/media/${encodeURIComponent(id)}`} soundEnabled={false} onStatus={setStatus}/>
    {status === 'text_too_long' && <p>Shorten the published wording to fit two readable lines in the scene.</p>}
    {status === 'layout_required' && <p>Leave more free space in scene settings, then preview again.</p>}
    {status === 'media_unavailable' && <p>The source video could not load. This preview uses the published text.</p>}
  </div>;
}
function OwnerExperience({page}: {page: 'setup'|'dock'}) {
  useEffect(() => {
    if (page !== 'dock') return;
    document.documentElement.dataset.ownerDock = 'true';
    return () => {delete document.documentElement.dataset.ownerDock;};
  }, [page]);
  const client = useMemo(() => new OwnerHttpClient(), []);
  const capture = useMemo(() => browserCapture(client), [client]);
  const owner = useMemo(() => ownerPorts(client), [client]), setup = useMemo(() => setupPorts(client), [client]);
  useEffect(() => {
    let closed = false, endingSession = '';
    const inspect = async () => {
      if (!['listening', 'delayed'].includes(capture.getSnapshot().status)) return;
      try {
        const {session} = await client.getSnapshot();
        if (closed || !session?.endedAt || session.id === endingSession) return;
        endingSession = session.id;
        await capture.offline(Math.max(0, Date.parse(session.endedAt) - Date.parse(session.startedAt)));
      } catch { /* Capture lease renewal independently stops an orphaned producer. */ }
    };
    const unsubscribe = client.subscribe(() => void inspect());
    const leaving = () => {void capture.pause();};
    window.addEventListener('pagehide', leaving);
    return () => {closed = true; unsubscribe(); window.removeEventListener('pagehide', leaving); void capture.dispose();};
  }, [client, capture]);
  const renderPreview = (plan: RecapPlan, _close: () => void) => <LocalPreview plan={plan}/>;
  return page === 'setup' ? <SetupPage client={client} setup={setup} capture={capture} renderPreview={renderPreview}/> : <DockPage client={client} owner={owner} capture={capture} recordingPort={client} renderPreview={renderPreview}/>;
}
function BroadcastSource() {
  const client = useMemo(() => new OverlayHttpClient(), []);
  const [state, setState] = useState<'connecting'|'ready'|'error'>('connecting');
  useEffect(() => {
    document.documentElement.dataset.broadcast = 'true';
    let stopped = false;
    void client.connect(location.hash.slice(1) || undefined).then(() => {if (!stopped) {history.replaceState(null, '', location.pathname); setState('ready');}}).catch(() => {if (!stopped) setState('error');});
    return () => {stopped = true; delete document.documentElement.dataset.broadcast;};
  }, [client]);
  if (state === 'error') return <div className="app-overlay-error"><p>This overlay link could not connect. Copy a new link from local setup.</p><QuietButton onClick={() => location.reload()}>Reconnect source</QuietButton></div>;
  return state === 'ready' ? <OverlayPage client={client}/> : null;
}
export default function LocalExperience({page}: {page: 'setup'|'dock'|'overlay'}) {return page === 'overlay' ? <BroadcastSource/> : <OwnerExperience page={page}/>;}
