import {Component, Suspense, lazy, type ReactNode} from 'react';
import {Brand, Button, ReadingLayout} from '../ui/index.js';
import {PublicHttpClient} from '../shared/http-client.js';

const Landing = lazy(() => import('../features/landing/index.js').then(module => ({default: module.RecordedLandingPage})));
const Instructions = lazy(() => import('../features/landing/index.js').then(module => ({default: module.LocalSetupInstructions})));
const PublicRecap = lazy(() => import('../features/public/index.js').then(module => ({default: module.PublicRecapPage})));
const Replay = lazy(() => import('../features/replay/index.js').then(module => ({default: module.ReplayPage})));
const ExampleRecap = lazy(() => import('../features/replay/index.js').then(module => ({default: module.ExampleRecapPage})));
/** The example recording's channel. Its public recap lives at /example, so /c/<login> always belongs to real channels. */
const EXAMPLE_LOGIN = 'foxlight_dev';
const LocalExperience = import.meta.env.MODE === 'public' ? null : lazy(() => import('./LocalExperience.js'));
const Foundation = import.meta.env.DEV ? lazy(() => import('../ui/FoundationShowcase.js').then(module => ({default: module.FoundationShowcase}))) : null;
const publicClient = new PublicHttpClient();

class PageBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() {return {failed: true};}
  render() {return this.state.failed ? <ReadingLayout><div className="app-message"><Brand/><h1>This page could not open</h1><p>Reload to reconnect to Previously.</p><Button onClick={() => location.reload()}>Reload page</Button></div></ReadingLayout> : this.props.children;}
}
export function App({local}: {local: boolean}) {
  const path = location.pathname;
  const match = /^\/c\/([a-z0-9_]{1,25})(?:\/episodes\/([^/]+))?\/?$/.exec(path);
  let page: ReactNode;
  if (path === '/') page = <Landing/>;
  else if (path === '/replay') {
    const recording = new URLSearchParams(location.search).get('recording');
    page = <Replay manifestUrl={recording ? `/api/public/replays/${/^[-a-zA-Z0-9_]{1,120}$/.test(recording) ? encodeURIComponent(recording) : 'invalid-recording'}` : undefined}/>;
  }
  else if (path === '/setup/local' || !local && ['/setup', '/dock', '/overlay'].includes(path)) page = <Instructions/>;
  else if (local && LocalExperience && ['/setup', '/dock', '/overlay'].includes(path)) page = <LocalExperience page={path.slice(1) as 'setup'|'dock'|'overlay'}/>;
  else if (local && Foundation && path === '/foundation') page = <Foundation/>;
  else if (path === '/example' || path === '/example/') page = <ExampleRecap login={EXAMPLE_LOGIN}/>;
  else if (match) page = <PublicRecap client={publicClient} login={match[1]} episodeId={match[2] ? decodeURIComponent(match[2]) : undefined}/>;
  else page = <ReadingLayout><div className="app-message"><Brand/><h1>This page is not here</h1><a className="pv-button pv-button--primary" href="/replay">Open the recorded stream</a></div></ReadingLayout>;
  return <PageBoundary><Suspense fallback={<div className="app-loading" role="status"><Brand/><p>Opening Previously…</p></div>}>{page}</Suspense></PageBoundary>;
}
