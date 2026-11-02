import { LandingPage, type LandingPageProps } from './LandingPage';
import { useLandingStory } from './useLandingStory';

export interface RecordedLandingPageProps extends Pick<LandingPageProps, 'replayHref' | 'setupHref'> { manifestUrl?: string }
/** The landing reads one gated recording after its raid; editing and capture controls live on the separate replay route. */
export function RecordedLandingPage({ manifestUrl, ...links }: RecordedLandingPageProps) {
  const { story, error } = useLandingStory(manifestUrl);
  return <LandingPage {...links} story={story} unavailable={!!error} />;
}
