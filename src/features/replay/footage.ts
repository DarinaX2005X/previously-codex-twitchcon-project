import { useEffect, useState } from 'react';

/** Gameplay footage of the example recording. It sits behind the overlay scene, the way a stream would. */
const VIDEO = ['/demo/foxlight/stream-full.mp4', '/demo/foxlight/clip-run.mp4'];
const POSTER = ['/demo/foxlight/stream-full-poster.jpg', '/demo/foxlight/clip-run.jpg', '/demo/foxlight/clip-moon.jpg'];

async function firstOf(urls: string[], type: string, signal: AbortSignal) {
  for (const url of urls) {
    try {
      const response = await fetch(url, { method: 'HEAD', signal, cache: 'force-cache' });
      if (response.ok && (response.headers.get('content-type') ?? '').startsWith(type)) return url;
    } catch { if (signal.aborted) return undefined; }
  }
  return undefined;
}

export interface Footage { src?: string; poster?: string; full: boolean; ready: boolean }

export function useFootage(): Footage {
  const [value, setValue] = useState<Footage>({ ready: false, full: false });
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([firstOf(VIDEO, 'video/', controller.signal), firstOf(POSTER, 'image/', controller.signal)]).then(([src, poster]) => {
      if (!controller.signal.aborted) setValue({ src, poster, full: src === VIDEO[0], ready: true });
    });
    return () => controller.abort();
  }, []);
  return value;
}
