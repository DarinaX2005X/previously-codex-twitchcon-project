import type {DockCapturePort, DockOwnerPort} from '../features/dock/ports.js';
import {CaptureController} from '../features/capture/controller.js';
import {createBrowserCaptureEnvironment, createCaptureHttpTransport} from '../features/capture/browser.js';
import {OwnerHttpClient} from '../shared/http-client.js';
import type {SetupPort, SetupDiagnostics} from '../features/setup/ports.js';

export function ownerPorts(client: OwnerHttpClient): DockOwnerPort {
  const id = encodeURIComponent;
  return {
    listMarkers: (sessionId, signal) => client.listMarkers(sessionId, signal),
    listHistory(query) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value));
      return client.request(`/history?${search}`);
    },
    listSources(query) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value));
      return client.request(`/sources?${search}`);
    },
    editLore: (key, patch) => client.request(`/lore/${id(key)}`, {method: 'PATCH', body: patch}),
    confirmLore: (key, baseRevision) => client.request(`/lore/${id(key)}/confirm`, {method: 'POST', body: {baseRevision}}),
    deleteLore: (key, baseRevision) => client.request(`/lore/${id(key)}`, {method: 'DELETE', body: {baseRevision}}),
    blockLore: (key, blocked, baseRevision) => client.request(`/lore/${id(key)}/block`, {method: 'POST', body: {blocked, baseRevision}}),
  };
}

export function browserCapture(client: OwnerHttpClient): DockCapturePort & {dispose: () => Promise<void>; offline: (offsetMs: number) => Promise<void>} {
  const controller = new CaptureController(createCaptureHttpTransport(() => client.csrfToken), createBrowserCaptureEnvironment(), crypto.randomUUID());
  return {
    getSnapshot: controller.getSnapshot, subscribe: controller.subscribe,
    start: async (sessionId, takeover) => {await client.initialize(); await controller.start(sessionId, takeover);},
    pause: () => controller.pause(), dispose: () => controller.dispose(), offline: offset => controller.offline(offset),
  };
}

export function setupPorts(client: OwnerHttpClient): SetupPort {
  return {
    diagnostics: async () => {const response = await fetch('/api/setup/status', {cache: 'no-store', credentials: 'same-origin'}); if (!response.ok) throw new Error('Could not check setup.'); return response.json() as Promise<SetupDiagnostics>;},
    connectUrl: '/api/auth/twitch/start?returnTo=%2Fsetup',
    overlayLink: rotate => client.request(rotate ? '/overlay/rotate' : '/overlay-key', {method: 'POST', body: {rotate}}),
    previousClip: () => client.request('/twitch/previous-clip'),
    preparePreviousClip: input => client.request('/twitch/previous-clip/prepare', {method: 'POST', body: input}),
    refreshPreviousClip: () => client.request('/twitch/previous-clip/refresh', {method: 'POST', body: {}}),
  };
}
