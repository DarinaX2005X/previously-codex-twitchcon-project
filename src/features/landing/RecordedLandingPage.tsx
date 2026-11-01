import { useEffect, useState } from 'react';
import type { RecapPlan, Source } from '../../shared/contracts';
import { QuietButton, formatTimecode } from '../../ui';
import { ScenePlayer, SceneSummary } from '../overlay';
import { useRecording } from '../replay/useRecording';
import { LandingPage, type LandingPageProps } from './LandingPage';

export interface RecordedLandingPageProps extends Pick<LandingPageProps, 'replayHref' | 'setupHref'> { manifestUrl?: string }
/** The landing reads one gated recording; editing and capture controls live on the separate replay route. */
export function RecordedLandingPage({ manifestUrl, ...links }: RecordedLandingPageProps) {
  const { client, view, error, origin, resolveMedia } = useRecording(manifestUrl);
  const [resolved, setResolved] = useState<{ revision: number; evidence: Source[]; plan: RecapPlan | null } | null>(null);
  const [playingScene, setPlayingScene] = useState(false);
  const snapshot = client && view ? view.snapshot : null;
  const chapter = snapshot?.published?.chapters.at(-1);
  const permitted = !!client && !!snapshot && !error;
  const ready = permitted && resolved?.revision === snapshot.revision ? resolved : null;
  const source = ready?.evidence.find(item => item.kind === 'speech' && item.status === 'active') ?? ready?.evidence.find(item => item.status === 'active');
  const unavailable = error ? 'The stream example is unavailable. Open the recording to try again.' : 'Opening the stream example…';
  useEffect(() => {
    let active = true;
    setResolved(null); setPlayingScene(false);
    if (client) void client.controlReplay({ action: 'seek', milestone: 'published' }).catch(() => { if (active) setResolved(null); });
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
  const scene = ready?.plan ? <div className="landing-recorded-scene">
    <ScenePlayer key={ready.plan.id + ':' + playingScene} plan={ready.plan} timeMs={playingScene ? undefined : 8500} playing={playingScene} cropToLayout soundEnabled={false} resolveMedia={resolveMedia} onEnded={() => setPlayingScene(false)} />
    <QuietButton onClick={() => setPlayingScene(value => !value)}>{playingScene ? 'Pause scene' : 'Play scene'}</QuietButton>
  </div> : <div className="landing-recording-unavailable" role="status">{permitted && !chapter ? 'This example has no published story.' : unavailable}</div>;
  const mobile = ready?.plan ? <SceneSummary plan={ready.plan} className="landing-mobile-summary" /> : <div className="landing-recording-unavailable">{unavailable}</div>;
  const sourcePlane = source?.text && chapter ? <>
    <p className="landing-source__time">Source at {formatTimecode(source.startMs)}</p>
    <blockquote className="landing-source__desktop">“{excerpt(source.text, 190)}”</blockquote>
    <blockquote className="landing-source__mobile">“{excerpt(source.text, 95)}”</blockquote>
  </> : <p>{unavailable}</p>;
  const proof = permitted && chapter ? <>
    {source?.text ? <div className="landing-proof__source"><p>Source at {formatTimecode(source.startMs)}</p><blockquote>“{excerpt(source.text, 360)}”</blockquote></div> : <p>Opening the source.</p>}
    <div className="landing-proof__result"><p>Published chapter</p><h3>{chapter.title}</h3><p>{chapter.summary}</p></div>
  </> : <p>{unavailable}</p>;
  return <LandingPage {...links} preview={scene} mobilePreview={mobile} assemblySource={sourcePlane} proof={proof}
    fixtureLabel={permitted ? origin === 'own-stream' ? 'From an owned stream recording.' : 'Authored stream example with text sources and no source video.' : 'Open the recorded stream to explore this example.'} />;
}
function excerpt(text: string, limit: number) { return text.length <= limit ? text : text.slice(0, limit).trimEnd() + '…'; }