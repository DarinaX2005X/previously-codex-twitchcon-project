import type { ReactNode } from 'react';
import { Brand } from '../../ui';
import './landing.css';

export interface LandingPageProps {
  preview?: ReactNode;
  mobilePreview?: ReactNode;
  assemblySource?: ReactNode;
  proof?: ReactNode;
  fixtureLabel?: string;
  replayHref?: string;
  setupHref?: string;
}
export function LandingPage({
  preview, mobilePreview, assemblySource, proof,
  fixtureLabel = 'Explore a stream example in the recording.',
  replayHref = '/replay', setupHref = '/setup/local',
}: LandingPageProps) {
  return <main className="landing-page">
    <nav className="landing-nav" aria-label="Main navigation">
      <a href="/" aria-label="Previously home"><Brand /></a>
      <div><a href={replayHref}>Recorded stream</a><a href={setupHref}>Set up my channel</a></div>
    </nav>
    <section className="landing-hero">
      <h1>Help late arrivals<br />join the story</h1>
      <div className="landing-intro">
        <p>Catch up with the stream while it keeps going.<span className="landing-intro__detail">Give newcomers the goal, the turning point, and what you are doing now.</span></p>
        <a href={replayHref} className="pv-button pv-button--primary">Try a recorded stream</a>
      </div>
      <div className="landing-assembly">
        <div className="landing-source">{assemblySource ?? <><h2>What happened earlier</h2><p>A source moment gives the current story its context.</p></>}</div>
        <div className="landing-preview landing-preview--desktop">{preview ?? <CurrentExplanation />}</div>
        <div className="landing-preview landing-preview--mobile">{mobilePreview ?? <CurrentExplanation />}</div>
      </div>
      <p className="landing-example-caption">{fixtureLabel}</p>
    </section>
    <section className="landing-proof" aria-labelledby="landing-proof-title">
      <div className="landing-proof__intro">
        <h2 id="landing-proof-title">The reason behind the current step</h2>
        <p>A late arrival needs more than the latest event. Previously keeps the goal and what changed together, with the source close enough to check.</p>
        <a href={replayHref}>Follow the source in the recording</a>
      </div>
      <div className="landing-proof__record">{proof ?? <p>Open the recorded stream to follow a source into its published chapter.</p>}</div>
    </section>
    <section className="landing-control" aria-labelledby="landing-control-title">
      <h2 id="landing-control-title">Keep the story in your hands</h2>
      <div className="landing-control__explanation">
        <dl>
          <div><dt>Edit the chapter</dt><dd>Your checked correction becomes the version viewers read.</dd></div>
          <div><dt>Pause listening</dt><dd>Stop new capture while the published story stays available.</dd></div>
          <div><dt>Forget the source</dt><dd>Remove an interval and the story that depends on it.</dd></div>
        </dl>
        <a className="pv-button pv-button--quiet" href={replayHref}>Try the streamer controls</a>
      </div>
    </section>
    <section className="landing-close">
      <h2>Give the next arrival<br />a place to start</h2>
      <div><a className="pv-button pv-button--primary" href={setupHref}>Set up my channel</a><p>Run the collector locally and share your recap with viewers.</p></div>
    </section>
    <footer className="landing-footer"><a href="/" aria-label="Previously home"><Brand /></a><a href={replayHref}>Recorded stream</a><a href={setupHref}>Local setup</a></footer>
  </main>;
}
function CurrentExplanation() {
  return <div className="landing-current" data-theme="dark"><p>What matters now</p><h2>The goal<br />The change<br />The current step</h2><p>The context a late arrival needs to join in.</p></div>;
}

export interface LocalSetupInstructionsProps { replayHref?: string; localSetupHref?: string }
export function LocalSetupInstructions({ replayHref = '/replay', localSetupHref = 'https://localhost:4317/setup' }: LocalSetupInstructionsProps) {
  return <main className="local-setup-page">
    <nav className="landing-nav"><a href="/" aria-label="Previously home"><Brand /></a><a href={replayHref}>Try the recording first</a></nav>
    <article>
      <h1>Set up your channel locally</h1>
      <p className="local-setup-lead">The collector runs on your computer. Your viewers read the published recap online.</p>
      <ol className="local-setup-steps">
        <li><h2>Install and start the local app</h2><p>Use Node.js 22.13 or later. From the repository folder, run:</p><pre><code>{'npm ci\nnpm run setup:local\nnpm run build\nnpm start'}</code></pre><p>The certificate setup command uses the Windows user certificate store and writes local configuration to <code>.env</code>. Keep that file private.</p></li>
        <li><h2>Configure your channel</h2><p>Fill the named settings in <code>.env.example</code> using your local <code>.env</code>: Twitch application ID and secret, your channel login, an OpenAI API key, and your HTTPS public deployment origin.</p><p>Register this exact Twitch OAuth callback:</p><pre><code>https://localhost:4317/auth/twitch/callback</code></pre><p>The public deployment needs a private Vercel Blob store and the same <code>PUBLISH_SHARED_SECRET</code> as the local collector. Configure its token only on the server.</p><p>Paid requests begin only when <code>OPENAI_PAID_CALLS_ENABLED=true</code>. Keep it <code>false</code> while checking configuration or playing the recording.</p></li>
        <li><h2>Connect and choose what to share</h2><p>Restart the local app after changing configuration. Open setup to review diagnostics, connect the matching Twitch account, and start listening with a microphone you choose.</p><a className="pv-button pv-button--primary" href={localSetupHref}>Open local setup</a></li>
        <li><h2>Add the scene to OBS</h2><p>Copy the overlay URL from local setup into an OBS Browser Source at 1920 × 1080. Treat that URL as private. Preview the scene, set protected areas, and then copy your public recap link.</p><p>New capture stays off when you return until you start listening again. Automatic clip creation is a separate choice.</p></li>
      </ol>
      <div className="local-setup-recording"><h2>Just want to see how it works?</h2><p>The authored recording runs without provider keys and keeps its changes separate from your channel.</p><a className="pv-button pv-button--quiet" href={replayHref}>Try a recorded stream</a></div>
    </article>
  </main>;
}