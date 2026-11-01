import {
  PublicSnapshotSchema, type Chapter, type InvalidationReceipt, type Moment, type OwnerSnapshot,
  type PlaybackRef, type PrivacyTarget, type RecapClient, type RecapPlan, type ReplayControl,
  type Settings, type UpdateEvent,
} from './contracts/index.js';

export class ClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false, readonly details?: unknown) {
    super(message); this.name = 'ClientError';
  }
}
export type FetchPort = typeof fetch;
type RequestOptions = {method?: string; body?: unknown; signal?: AbortSignal; idempotencyKey?: string};
const updateNames: UpdateEvent['event'][] = ['snapshot.changed', 'snapshot.reset', 'privacy.invalidated', 'source.status', 'publication.synced', 'playback.prepare', 'playback.start', 'playback.cancel'];
export type StreamCallbacks = {onUpdate: (event: UpdateEvent) => void; onHeartbeat?: () => void; onDisconnect?: () => void};

/** Heartbeat comments are observable through a stream reader, unlike EventSource. */
export function subscribeUpdates(url: string, callbacks: StreamCallbacks, fetcher: FetchPort = fetch): () => void {
  let stopped = false, active: AbortController | undefined, reconnect: ReturnType<typeof setTimeout> | undefined;
  let lastId = '', retry = 1000;
  async function connect() {
    active = new AbortController();
    try {
      const response = await fetcher(url, {credentials: 'same-origin', cache: 'no-store', signal: active.signal, headers: {Accept: 'text/event-stream', ...(lastId ? {'Last-Event-ID': lastId} : {})}});
      if (!response.ok || !response.body) throw new Error('Update stream unavailable.');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!stopped) {
          const result = await reader.read(); if (result.done) break;
          buffer += decoder.decode(result.value, {stream: true}).replace(/\r\n/g, '\n');
          if (buffer.length > 256_000) throw new Error('Update stream overflow.');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            let name = '', id = '', data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) name = line.slice(6).trim();
              else if (line.startsWith('id:')) id = line.slice(3).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trimStart();
            }
            if (frame.startsWith(':') || updateNames.includes(name as UpdateEvent['event'])) {retry = 1000; callbacks.onHeartbeat?.();}
            if (updateNames.includes(name as UpdateEvent['event'])) {
              const value = JSON.parse(data || '{}') as UpdateEvent['data'];
              if (id && /^\d+$/.test(id)) lastId = id;
              callbacks.onUpdate({id: Number(id) || 0, event: name as UpdateEvent['event'], data: {sessionId: value.sessionId ?? null, revision: value.revision ?? 0, ...(value.affectedIds ? {affectedIds: value.affectedIds} : {})}});
            }
          }
        }
      } finally {void reader.cancel().catch(() => undefined); reader.releaseLock();}
    } catch { /* Lease consumers clear their content; reconnect never invents freshness. */ }
    if (!stopped) {callbacks.onDisconnect?.(); reconnect = setTimeout(() => void connect(), retry); retry = Math.min(10_000, retry * 2);}
  }
  void connect();
  return () => {stopped = true; active?.abort(); clearTimeout(reconnect);};
}

export class HttpClient {
  private csrfValue = '';
  private csrfFlight?: Promise<string>;
  constructor(readonly base = '/api/owner', readonly fetcher: FetchPort = fetch) {}
  get csrfToken() {return this.csrfValue;}
  setCsrfToken(value: string) {this.csrfValue = value;}
  async initialize(): Promise<string> {
    if (this.csrfValue) return this.csrfValue;
    if (!this.csrfFlight) this.csrfFlight = this.request<{csrfToken: string}>('/csrf').then(value => this.csrfValue = value.csrfToken).finally(() => {this.csrfFlight = undefined;});
    return this.csrfFlight;
  }
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET', mutation = method !== 'GET' && method !== 'HEAD';
    if (mutation) await this.initialize();
    const response = await this.fetcher(this.base + path, {method, credentials: 'same-origin', cache: 'no-store', signal: options.signal,
      headers: {...(options.body !== undefined ? {'Content-Type': 'application/json'} : {}), ...(mutation ? {'X-CSRF-Token': this.csrfValue, 'Idempotency-Key': options.idempotencyKey ?? crypto.randomUUID()} : {})},
      ...(options.body !== undefined ? {body: JSON.stringify(options.body)} : {}),
    });
    if (!response.ok) {
      const value = await response.json().catch(() => null) as {error?: {code?: string; message?: string; retryable?: boolean; details?: unknown}} | null;
      if (response.status === 401 || value?.error?.code === 'csrf_rejected') this.csrfValue = '';
      throw new ClientError(response.status, value?.error?.code ?? 'request_failed', value?.error?.message ?? 'This action could not be completed.', value?.error?.retryable ?? response.status >= 500, value?.error?.details);
    }
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }
}

export class OwnerHttpClient extends HttpClient implements RecapClient {
  getSnapshot() {return this.request<OwnerSnapshot>('/bootstrap');}
  subscribe(listener: (event: UpdateEvent) => void) {return subscribeUpdates(this.base + '/updates', {onUpdate: listener}, this.fetcher);}
  editChapter(id: string, patch: {title: string; summary: string; baseRevision: number}) {return this.request<Chapter>(`/chapters/${encodeURIComponent(id)}`, {method: 'PATCH', body: patch});}
  deleteChapter(id: string, baseRevision: number) {return this.request<InvalidationReceipt>(`/chapters/${encodeURIComponent(id)}`, {method: 'DELETE', body: {baseRevision}});}
  pinChapter(id: string, pinned: boolean, baseRevision: number) {return this.request<Chapter>(`/chapters/${encodeURIComponent(id)}`, {method: 'PATCH', body: {pinned, baseRevision}});}
  saveMoment(input: {sessionId: string; label?: string}) {return this.request<Moment>('/moments', {method: 'POST', body: input});}
  privacy(target: PrivacyTarget, reason: string) {return this.request<InvalidationReceipt>('/privacy', {method: 'POST', body: {target, reason}});}
  setSettings(patch: Partial<Settings> & {baseRevision: number}) {const {revision: _revision, ...body} = patch; return this.request<Settings>('/settings', {method: 'PATCH', body});}
  triggerRecap(sessionId: string) {return this.request<PlaybackRef>('/recaps', {method: 'POST', body: {sessionId, reason: 'manual'}});}
  previewRecap(sessionId: string) {return this.request<RecapPlan | null>(`/recaps/preview?sessionId=${encodeURIComponent(sessionId)}`);}
  cancelRecap(id: string) {return this.request<void>(`/recaps/${encodeURIComponent(id)}/cancel`, {method: 'POST', body: {}});}
  controlReplay(_control: ReplayControl): Promise<void> {return Promise.reject(new ClientError(400, 'live_replay_unavailable', 'Open the recorded stream to control its playback.'));}
}

export class PublicHttpClient {
  constructor(readonly base = '/api/public', readonly fetcher: FetchPort = fetch) {}
  async getPublicSnapshot(login: string, options: {episodeId?: string; untilMs?: number; signal?: AbortSignal} = {}) {
    const path = options.episodeId ? `sessions/${encodeURIComponent(options.episodeId)}` : `channels/${encodeURIComponent(login)}`;
    const query = options.untilMs === undefined ? '' : `?untilMs=${Math.max(0, Math.round(options.untilMs))}`;
    const response = await this.fetcher(`${this.base}/${path}${query}`, {cache: 'no-store', credentials: 'same-origin', signal: options.signal});
    if (!response.ok) throw new ClientError(response.status, 'public_unavailable', 'The live recap is temporarily unavailable.', response.status >= 500);
    return PublicSnapshotSchema.parse(await response.json());
  }
}

export type OverlayHttpState = {sessionId: string | null; privacyEpoch: number; revision: number; serverNow: string; active: PlaybackRef | null; queued: PlaybackRef[]; channel?: string; title?: string; soundEnabled?: boolean; volume?: number};
export class OverlayHttpClient extends HttpClient {
  constructor(fetcher: FetchPort = fetch) {super('/api/overlay', fetcher);}
  async connect(capability?: string) {
    if (capability) {
      const response = await this.fetcher('/api/overlay/session', {method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({capability})});
      if (!response.ok) throw new ClientError(response.status, 'overlay_capability', 'This overlay link is no longer valid. Copy a new link from setup.');
      const value = await response.json() as {csrfToken: string}; this.setCsrfToken(value.csrfToken);
    } else await this.initialize();
  }
  getState(signal?: AbortSignal) {return this.request<OverlayHttpState>('/state', {signal});}
  acknowledge(id: string, state: 'prepared' | 'started' | 'ended' | 'error', timestamp: string) {return this.request<void>(`/recaps/${encodeURIComponent(id)}/ack`, {method: 'POST', body: {state, timestamp}});}
  subscribe(callbacks: StreamCallbacks) {return subscribeUpdates(this.base + '/updates', callbacks, this.fetcher);}
  mediaUrl(id: string) {return `/api/media/${encodeURIComponent(id)}`;}
}
