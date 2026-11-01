import { useEffect, useState } from 'react';
import type { RecapPlan, Source } from '../../shared/contracts';
import { QuietButton, formatTimecode } from '../../ui';
import { ScenePlayer, SceneSummary } from '../overlay';
import { useRecording } from '../replay/useRecording';
import { LandingPage, type LandingPageProps } from './LandingPage';

export interface RecordedLandingPageProps extends Pick<LandingPageProps, 'replayHref' | 'setupHref'> { manifestUrl?: string }
/** All source text, proof, controls and scene share one revocable recording and one reducer. */
export function RecordedLandingPage({ manifestUrl, ...links }: RecordedLandingPageProps) {
  const { client, view, error, origin } = useRecording(manifestUrl);
  const [resolved, setResolved] = useState<{ revision: number; evidence: Source[]; plan: RecapPlan | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [playingScene, setPlayingScene] = useState(false);
  const snapshot = client && view ? view.snapshot : null;
  const chapter = snapshot?.published?.chapters.at(-1);
  const permitted = !!client && !!snapshot && !error;
  const ready = permitted && resolved?.revision === snapshot.revision ? resolved : null;
  const source = ready?.evidence.find(item => item.kind === 'speech' && item.status === 'active') ?? ready?.evidence.find(item => item.status === 'active');
  const unavailable = error ? 'The recorded scene is currently unavailable.' : 'Loading the current recorded scene…';
  useEffect(() => {
    let active = true;
    setResolved(null); setMessage(null); setPlayingScene(false);
    if (client) void client.controlReplay({ action: 'seek', milestone: 'published' }).catch(() => { if (active) setMessage('The recording could not be opened.'); });
    return () => { active = false; };
  }, [client]);
  useEffect(() => {
    let active = true;
    if (!client || !snapshot || !snapshot.session) return;
    const revision = snapshot.revision, id = snapshot.session.id;
    void Promise.all([chapter ? client.getEvidence(chapter.id) : Promise.resolve([]), client.previewRecap(id)]).then(([evidence, plan]) => {
      if (active) setResolved({ revision, evidence, plan });
    }).catch(() => { if (active) setResolved(null); });
    return () => { active = false; };
  }, [client, snapshot?.revision, chapter?.id]);
  const run = async (action: () => Promise<unknown>, result: string) => {
    setBusy(true); setMessage(null); setPlayingScene(false);
    try { await action(); setMessage(result); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'This action could not be completed.'); }
    finally { setBusy(false); }
  };
  const scene = ready?.plan ? <div className="landing-recorded-scene"><ScenePlayer key={ready.plan.id + ':' + playingScene} plan={ready.plan} timeMs={playingScene ? undefined : 8500} playing={playingScene} cropToLayout soundEnabled={false} onEnded={() => setPlayingScene(false)} /><QuietButton onClick={() => setPlayingScene(value => !value)}>{playingScene ? 'Pause scene' : 'Play scene'}</QuietButton></div> : <div className="landing-recording-unavailable" role="status">{permitted && !chapter ? 'No published story remains in this recording.' : unavailable}</div>;
  const mobile = ready?.plan ? <SceneSummary plan={ready.plan} className="landing-mobile-summary" /> : <div className="landing-recording-unavailable">{permitted && !chapter ? 'No published context remains.' : unavailable}</div>;
  const sourcePlane = source && chapter ? <><p className="landing-source__time">Source at {formatTimecode(source.startMs)}</p><h2>{chapter.title}</h2><p>“{source.text && excerpt(source.text, 130)}”</p></> : <><p className="landing-source__time">The source</p><h2>{permitted && !chapter ? 'Source removed' : 'Recorded context'}</h2><p>{permitted && !chapter ? 'Its dependent story is no longer published.' : unavailable}</p></>;
  const proof = permitted && chapter ? <><p className="landing-section-label">{origin === 'own-stream' ? 'From the owned recording' : 'From the authored recording'}</p>{source?.text ? <blockquote>“{excerpt(source.text, 360)}”</blockquote> : <p className="landing-section-label">Checking permitted source details.</p>}<div className="landing-proof__result"><span>Published chapter</span><h3>{chapter.title}</h3><p>{chapter.summary}</p></div></> : <p>{permitted ? 'The dependent chapter has been removed from this recording.' : unavailable}</p>;
  const controls = <><div className="landing-demo-controls" data-theme="dark"><p>{permitted ? snapshot.settings.listeningPaused ? 'Recorded capture is paused' : 'Recorded capture is active' : 'Recorded controls unavailable'}</p><div><QuietButton pending={busy} disabled={!permitted || !chapter || chapter.edited} onClick={() => void run(() => client!.editChapter(chapter!.id, { ...view!.transport.correction, baseRevision: chapter!.revision }), 'The checked correction is now in the published chapter.')}>Apply chapter correction</QuietButton><QuietButton disabled={!permitted || busy} onClick={() => void run(() => client!.setSettings({ baseRevision: snapshot!.settings.revision, listeningPaused: !snapshot!.settings.listeningPaused }), snapshot?.settings.listeningPaused ? 'Recorded capture resumed.' : 'Recorded capture paused. Published context stays visible.')}>{snapshot?.settings.listeningPaused ? 'Resume listening' : 'Pause listening'}</QuietButton><QuietButton disabled={!permitted || !chapter || busy} onClick={() => void run(() => client!.privacy({ kind: 'interval', sessionId: snapshot!.session!.id, fromMs: 0, toMs: view!.transport.atMs }, 'Forget the recorded source interval'), 'The source interval and its dependent story were removed from this recording.')}>Forget this source</QuietButton></div></div><div className="landing-demo-output">{permitted && chapter ? <><p className="landing-section-label">Viewer’s published chapter</p><h3>{chapter.title}</h3><p>{chapter.summary}</p></> : <><h3>{permitted ? 'No published chapter remains' : 'Recording unavailable'}</h3><p>{permitted ? 'Reset the recording to try its source again.' : 'The source and its output are hidden until the recording is available.'}</p></>}{message && permitted && <p className="landing-edit-receipt" role="status">{message}</p>}<p className="landing-example-note">Recorded controls run in this tab. They do not affect a live channel.</p></div><QuietButton disabled={!permitted || busy} onClick={() => void run(async () => { await client!.controlReplay({ action: 'reset' }); await client!.controlReplay({ action: 'seek', milestone: 'published' }); }, 'Recording reset to its first published context.')}>Reset recording</QuietButton></>;
  return <LandingPage {...links} preview={scene} mobilePreview={mobile} assemblySource={sourcePlane} proof={proof} controls={controls} fixtureLabel={permitted ? origin === 'own-stream' ? 'Owned stream recording. Preview uses the current permitted export.' : 'Authored fixture. No live stream or source video is represented.' : 'Recorded content is hidden until its current export is available.'} />;
}
function excerpt(text: string, limit: number) { return text.length <= limit ? text : text.slice(0, limit).trimEnd() + '…'; }
