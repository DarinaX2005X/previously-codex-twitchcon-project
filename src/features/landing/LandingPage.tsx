import type { ReactNode } from 'react';
import { Brand } from '../../ui';
import './landing.css';

export interface LandingPageProps { preview?: ReactNode; mobilePreview?: ReactNode; assemblySource?: ReactNode; proof?: ReactNode; controls?: ReactNode; fixtureLabel?: string; replayHref?: string; setupHref?: string }
export function LandingPage({ preview, mobilePreview, assemblySource, proof, controls, fixtureLabel = 'Open the recording to inspect its source and published context.', replayHref = '/replay', setupHref = '/setup/local' }: LandingPageProps) {
  return <main className="landing-page">
    <nav className="landing-nav" aria-label="Main navigation"><a href="/" aria-label="Previously home"><Brand /></a><div><a href={replayHref}>Recorded stream</a><a href={setupHref}>Set up my channel</a></div></nav>
    <section className="landing-hero">
      <h1>Help late arrivals<br />join the story</h1>
      <div className="landing-intro"><p>Catch up with the stream while it keeps going.<br className="landing-desktop-break" /> Turn the moments people missed into the context they need now.</p><a href={replayHref} className="pv-button pv-button--primary">Try a recorded stream <span aria-hidden="true">↗</span></a></div>
      <div className="landing-assembly">
        <div className="landing-source">{assemblySource ?? <><p className="landing-source__time">The source</p><h2>What happened earlier</h2><p>Follow an eligible source into the current story.</p></>}</div>
        <div className="landing-preview landing-preview--desktop">{preview ?? <AuthoredCurrent />}</div>
        <div className="landing-preview landing-preview--mobile">{mobilePreview ?? <AuthoredCurrent />}</div>
        <p className="landing-fixture-label">{fixtureLabel}</p>
      </div>
    </section>
    <section className="landing-proof" aria-labelledby="landing-proof-title"><div className="landing-proof__intro"><h2 id="landing-proof-title">A useful recap keeps the cause</h2><p>Keep what changed beside the source that explains it. A late arrival gets the reason behind the current step, with a way to check it.</p><a href={replayHref}>Follow the source in the recording <span aria-hidden="true">↗</span></a></div><div className="landing-proof__record">{proof ?? <p>Open the recorded stream to inspect the permitted source and its published chapter.</p>}</div></section>
    <section className="landing-control" aria-labelledby="landing-control-title"><div className="landing-control__copy"><h2 id="landing-control-title">Your words.<br />Your call.</h2><p>Edit the chapter people will read. Pause new capture. Forget a source and remove the story that depends on it.</p></div><div className="landing-control__demo">{controls ?? <div className="landing-demo-output"><p>Try the controls in the recorded stream. Your changes stay separate from a live channel.</p><a href={replayHref}>Open recorded controls</a></div>}</div></section>
    <section className="landing-close"><h2>Keep the story.<br />Stay in control.</h2><a className="pv-button pv-button--primary" href={setupHref}>Set up my channel <span aria-hidden="true">↗</span></a><p>Run the collector locally. Share the published recap with your viewers.</p></section>
    <footer className="landing-footer"><Brand variant="small-mark" /><p>Previously</p><a href={replayHref}>Recorded stream</a><a href={setupHref}>Local setup</a></footer>
  </main>;
}
function AuthoredCurrent() { return <div className="landing-current" data-theme="dark"><p>What matters now</p><h2>The context<br />people need now</h2><div><p>A goal, a change, and the current step.</p><p>Explore the source in the recorded stream.</p></div><a href="/replay">Open the recorded stream <span aria-hidden="true">↗</span></a></div>; }

export interface LocalSetupInstructionsProps { replayHref?: string; localSetupHref?: string }
export function LocalSetupInstructions({ replayHref = '/replay', localSetupHref = 'https://localhost:4317/setup' }: LocalSetupInstructionsProps) {
  return <main className="local-setup-page"><nav className="landing-nav"><a href="/" aria-label="Previously home"><Brand /></a><a href={replayHref}>Try the recording first</a></nav><article><h1>Set up your channel locally</h1><p className="local-setup-lead">The collector runs on your computer. Your viewers read the published recap online.</p><ol className="local-setup-steps"><li><h2>Install and start the local app</h2><p>Use Node.js 22.13 or later. From the repository folder, run:</p><pre><code>{'npm ci\nnpm run setup:local\nnpm run build\nnpm start'}</code></pre><p>The certificate setup command uses the Windows user certificate store and writes local configuration to <code>.env</code>. Keep that file private.</p></li><li><h2>Configure your channel</h2><p>Fill the named settings in <code>.env.example</code> using your local <code>.env</code>: Twitch application ID and secret, your channel login, an OpenAI API key, and your HTTPS public deployment origin.</p><p>Register this exact Twitch OAuth callback:</p><pre><code>https://localhost:4317/auth/twitch/callback</code></pre><p>The public deployment needs a private Vercel Blob store and the same <code>PUBLISH_SHARED_SECRET</code> as the local collector. Configure its token only on the server.</p><p>Paid requests begin only when <code>OPENAI_PAID_CALLS_ENABLED=true</code>. Keep it <code>false</code> while checking configuration or playing the recording.</p></li><li><h2>Connect and choose what to share</h2><p>Restart the local app after changing configuration. Open setup to review diagnostics, connect the matching Twitch account, and start listening with a microphone you choose.</p><a className="pv-button pv-button--primary" href={localSetupHref}>Open local setup</a></li><li><h2>Add the scene to OBS</h2><p>Copy the overlay URL from local setup into an OBS Browser Source at 1920 × 1080. Treat that URL as private. Preview the scene, set protected areas, and then copy your public recap link.</p><p>New capture stays off when you return until you start listening again. Automatic clip creation is a separate choice.</p></li></ol><div className="local-setup-recording"><h2>Just want to see how it works?</h2><p>The authored recording runs without provider keys and keeps its changes separate from your channel.</p><a className="pv-button pv-button--quiet" href={replayHref}>Try a recorded stream</a></div></article></main>;
}


