import { LandingPage, type LandingPageProps } from './LandingPage';
import { useLandingStory, type LandingStory } from './useLandingStory';

export interface RecordedLandingPageProps extends Pick<LandingPageProps, 'replayHref' | 'setupHref'> { manifestUrl?: string }
/** The landing reads one gated recording after its raid; editing and capture controls live on the separate replay route. */
export function RecordedLandingPage({ manifestUrl, ...links }: RecordedLandingPageProps) {
  const { story, error } = useLandingStory(manifestUrl);
  // Development only: a design review harness may inject a story before the example recording ships.
  const draft = import.meta.env.DEV ? (globalThis as { __PV_LANDING_DRAFT__?: LandingStory }).__PV_LANDING_DRAFT__ : undefined;
  return <LandingPage {...links} story={draft ? { ...draft, plan: story?.plan ?? null, resolveMedia: story?.resolveMedia ?? draft.resolveMedia } : story ?? null} unavailable={!!error && !draft} />;
}
