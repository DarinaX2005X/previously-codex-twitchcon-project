import { Router, type RequestHandler } from 'express';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ChannelSchema, type Channel, type Clock } from '../../shared/contracts/index.js';
import { ProviderTransport, OpenAIStoryProvider, OpenAITranscriptionProvider, OpenAIRealtimeNarrationProvider, SafetyService, OpenAIContextualPrivacy, OpenAIModeration, MODEL } from '../providers/index.js';
import { AudioIntakeService } from '../audio/intake.js';
import { createAudioRouter } from '../audio/router.js';
import { PrivateMediaCache } from '../media/cache.js';
import { createMediaRouter } from '../media/router.js';
import { resolveConfiguredChannel } from '../twitch/helix.js';
import { createTwitchRuntime } from './twitch-runtime.js';
import { createCloudRuntime } from './cloud-runtime.js';
import { createOverlayRouter, OverlayPresence } from './overlay-routes.js';
import { StoryEngine, type RuntimeStorage } from './engine.js';
import { createOwnerService } from './owner-service.js';
import { createOwnerRouter } from './owner-routes.js';
import { BoundedScheduler } from './scheduler.js';
import type { RuntimeConfig } from './config.js';
import type { RevisionStream } from './updates.js';
import { ApiError } from './errors.js';
import { createNarrationRuntime, type NarrationRuntime } from './narration-runtime.js';
import { RecordingController } from '../replay/recording-controller.js';
import { RecordingExportRegistry } from '../replay/recording-registry.js';
import { createRecordingRouter } from '../replay/recording-router.js';

async function channelIdentity(config: RuntimeConfig): Promise<Channel | null> {
  const {clientId, clientSecret, channelLogin} = config.twitch;
  if (!clientId || !clientSecret || !channelLogin) return null;
  const file = resolve(config.dataDir, 'channel-identity.json');
  try {
    const value = ChannelSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    if (value.login === channelLogin.toLowerCase() && /^\d+$/.test(value.id)) return value;
  } catch { /* An absent cache requires a fresh public identity lookup. */ }
  const value = await resolveConfiguredChannel({clientId, clientSecret, login: channelLogin.toLowerCase()});
  await mkdir(config.dataDir, {recursive: true});
  await writeFile(file, JSON.stringify(value), {mode: 0o600});
  return value;
}

/** Compose the live adapters only. Recorded replay has a separate, network-free composition. */
export async function createLiveRuntime(options: {config: RuntimeConfig; storage: RuntimeStorage; updates: RevisionStream; clock: Clock; channel?: Channel}) {
  const {config, storage, updates, clock} = options;
  const channel = options.channel ?? await channelIdentity(config);
  if (!channel || !config.sessionSecret || !storage.tokenVault || !config.twitch.clientId || !config.twitch.clientSecret) return null;
  const scope = {channelId: channel.id, runId: 'live'};
  storage.repository.ensureChannel(scope, channel.login);
  const settings = storage.repository.getSettings(scope);
  if (settings.revision === 0 && (settings.recapLanguage !== config.language || settings.publicationDelaySeconds !== config.publicationDelaySeconds)) {
    storage.repository.updateSettings(scope, settings.revision, {recapLanguage: config.language, publicationDelaySeconds: config.publicationDelaySeconds});
  }
  storage.budget.setPaidEnabled(Boolean(config.paidCallsEnabled && config.openaiApiKey && storage.budget.status().usedMicroUsd < storage.budget.status().limitMicroUsd));
  const transport = new ProviderTransport({apiKey: config.openaiApiKey, runId: 'live', budget: storage.budget, externalCallsEnabled: config.paidCallsEnabled, now: clock.now});
  const safety = new SafetyService(new OpenAIContextualPrivacy(transport), new OpenAIModeration(transport), clock.now);
  const story = new OpenAIStoryProvider(transport);
  let twitch: ReturnType<typeof createTwitchRuntime>;
  let cloud: ReturnType<typeof createCloudRuntime>;
  let narration: NarrationRuntime | undefined;
  let recorder: RecordingController | undefined;
  let recordingExports: RecordingExportRegistry;
  const engine = new StoryEngine({channel, scope, storage, clock, updates, safety, story,
    isOwnEcho: id => twitch?.isOwnEcho(id) ?? false,
    onCommittedTransition: transition => recorder?.onCommittedTransition(transition),
    onEffects: (sessionId, effects, state) => {
      twitch?.onEffects(sessionId, effects, state);
      cloud?.onEffects(sessionId, effects, state);
      narration?.onEffects(sessionId, effects, state);
      for (const effect of effects) {
        if (effect.type === 'playback.prepare' || effect.type === 'playback.start') {
          for (const asset of effect.playback.plan?.media ?? []) media.protect(asset.id, clock.now() + 30_000);
          if (effect.playback.plan?.audio) media.protect(effect.playback.plan.audio.id, clock.now() + 30_000);
        }
        if (effect.type === 'privacy') {
          for (const id of effect.receipt.hiddenEntityIds) void media.revoke(id).catch(() => {});
          // Access is already revoked by SQLite; retry physical erasure during cleanup if needed.
          try {recordingExports?.purgeInvalidated();} catch { /* Cleanup retries below. */ }
        }
      }
    },
  });
  const media = new PrivateMediaCache({directory: resolve(config.dataDir, 'media'), allowedHosts: ['production.assets.clips.twitchcdn.net'], now: clock.now,
    visible: input => !engine.outputsBlocked() && (input.id.startsWith('narration:') ? narration?.allowsMedia(input) ?? false : twitch?.allowsMedia(input) ?? false),
    onRevoke: () => updates.publish({...scope, event: 'privacy.invalidated', data: {sessionId: engine.activeSessionId(), revision: 0}}),
  });
  recordingExports = new RecordingExportRegistry({repository: storage.repository, scope, dataDir: config.dataDir, channelLogin: channel.login, publicOrigin: config.publicOrigin, outputsBlocked: () => engine.outputsBlocked()});
  recorder = new RecordingController({dataDir: config.dataDir, scope, clock, state: id => engine.state(id), source: id => storage.repository.getSource(scope, id), providerModel: MODEL, registerExport: recordingExports.register, resolveMedia: id => media.get(id), outputsBlocked: () => engine.outputsBlocked()});
  const suspendPrivacyOutput = (blocked: boolean) => {
    if (blocked) {engine.setOutputsBlocked(true);cloud?.suspend();}
    // Recovery is completed inside tick, after cancelling interrupted scenes.
  };
  twitch = createTwitchRuntime({config, scope, channel, storage, engine, updates, clock, media, onPrivacyBlocked: suspendPrivacyOutput, publicUrl: config.publicOrigin ? `${config.publicOrigin.replace(/\/$/, '')}/c/${channel.login}` : undefined});
  cloud = createCloudRuntime({scope, channel, engine, storage, publicOrigin: config.publicOrigin, sharedSecret: config.publishSharedSecret, clock, updates, recordingExports});
  const narrator = new OpenAIRealtimeNarrationProvider(transport, {approved: (text, language) => narration?.approved(text, language) ?? false});
  narration = createNarrationRuntime({engine, media, provider: narrator, clock, available: () => Boolean(config.paidCallsEnabled && config.openaiApiKey && storage.budget.status().enabled)});
  const audio = new AudioIntakeService({repository: storage.repository, secret: config.sessionSecret, directory: resolve(config.dataDir, 'audio'), transcription: new OpenAITranscriptionProvider(transport), safety, now: clock.now,
    onSource: source => engine.drain(source.sessionId),
    onGap: async (sessionId, startMs, endMs) => {await engine.dispatch(sessionId, {type: 'gap', startMs, endMs});},
  });
  const owner = createOwnerService(engine);
  const overlayPresence = new OverlayPresence({scope, clock,
    authorized: principal => Boolean(storage.sessions.verify(scope, principal.sessionId, 'overlay')),
    onStatus: status => engine.setStatus('overlay', status),
  });
  const stopObservingOverlay = updates.observeConnections(event => overlayPresence.observe(event));
  const ownerRouter = Router();
  ownerRouter.use(twitch.ownerRouter);
  let lastCaptureRenewal: number | null = null;
  ownerRouter.use((req, res, next) => {
    const path = req.path;
    res.once('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      if (path === '/capture/pause') {
        lastCaptureRenewal = null;
        engine.setStatus('mic', {state: 'paused', lastObservedAt: clock.iso(), message: 'Listening is paused.', action: 'Start listening'});
      } else if (path === '/capture/lease') {
        lastCaptureRenewal = clock.now();
        engine.setStatus('mic', {state: 'ready', lastObservedAt: clock.iso(), message: null, action: null});
      }
    });
    next();
  });
  ownerRouter.use(createAudioRouter(audio, (_req, _res, next) => next()));
  ownerRouter.use(createRecordingRouter(recorder, recordingExports));
  ownerRouter.use(createOwnerRouter(owner));
  const mediaAuthorization: RequestHandler = async (req, res, next) => {
    try {
      const principal = await twitch.auth.authenticate(req, 'owner') ?? await twitch.auth.authenticate(req, 'overlay');
      if (!principal || principal.expiresAtMs <= clock.now()) throw new ApiError(401, 'session_required', 'Sign in to continue.');
      if (principal.channelId !== scope.channelId || principal.runId !== 'live') throw new ApiError(403, 'role_forbidden', 'This session cannot access that media.');
      const mediaId = req.path.split('/').filter(Boolean).at(-1);
      if (principal.role === 'overlay' && (!mediaId || !(narration?.permitsOverlayMedia(decodeURIComponent(mediaId)) || twitch.permitsOverlayMedia(decodeURIComponent(mediaId))))) throw new ApiError(410, 'media_revoked', 'This media is no longer part of the active recap.');
      res.locals.principal = principal; next();
    } catch (error) {next(error);}
  };
  const scheduler = new BoundedScheduler(storage.repository, [
    {scope, kinds: ['stt'], concurrency: 2, execute: (job, signal) => audio.execute(scope, job, signal)},
    {scope, kinds: ['story'], concurrency: 1, execute: (job, signal) => engine.executeStory(job, signal)},
    {scope, kinds: ['owner.review'], concurrency: 1, retryOnShutdown: true, execute: (job, signal) => owner.executeReview(job, signal)},
    {scope, kinds: ['narration'], concurrency: 1, execute: (job, signal) => narration!.execute(job, signal)},
  ], undefined, clock.now);
  let stopped = false, ticking = false, lastCleanupAt = 0;
  let tickFlight: Promise<void> | undefined, safetyFlight: Promise<void> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      if (twitch.privacyBlocked()) suspendPrivacyOutput(true);
      else if (engine.outputsBlocked()) {
        await engine.recoverPlayback();
        if (!twitch.privacyBlocked()) {cloud.resume();engine.setOutputsBlocked(false);}
      }
      await engine.tick();
      if (lastCaptureRenewal !== null && clock.now() - lastCaptureRenewal > 12_000) {
        lastCaptureRenewal = null;
        engine.setStatus('mic', {state: 'disconnected', lastObservedAt: clock.iso(), message: 'The microphone connection ended.', action: 'Start listening'});
      }
      await twitch.tick();
      await cloud.tick();
      await narration?.tick();
      if (config.paidCallsEnabled && config.openaiApiKey && !safetyFlight) safetyFlight = engine.checkPendingSources().catch(() => {}).finally(() => {safetyFlight = undefined;});
      if (clock.now() - lastCleanupAt >= 30_000) {lastCleanupAt = clock.now(); await audio.cleanup(); recordingExports.purgeInvalidated();}
    } catch {
      engine.setStatus('story', {state: 'error', lastObservedAt: clock.iso(), message: 'An update could not be saved. The previous safe recap remains available.', action: 'Check local storage'});
    } finally {ticking = false;}
  };
  const scheduleTick = () => {if (!tickFlight) tickFlight = tick().finally(() => {tickFlight = undefined;});};
  return {
    engine, owner, audio, media, recorder, recordingExports, channel, scope, auth: twitch.auth,
    routers: {auth: twitch.authRouter, owner: ownerRouter, overlay: createOverlayRouter({engine, clock, presence: overlayPresence}), media: createMediaRouter(media, mediaAuthorization)},
    setup: () => ({twitch: twitch.status(), openai: {connected: false, configured: Boolean(config.openaiApiKey), paidCallsEnabled: storage.budget.status().enabled}, narration: narration?.status(), publicUrl: config.publicOrigin ? `${config.publicOrigin.replace(/\/$/, '')}/c/${channel.login}` : null}),
    authorizeStream: (principal: {sessionId: string; role: 'owner'|'overlay'|'demo'; channelId: string; runId: string}) => principal.channelId === scope.channelId && principal.runId === 'live' && Boolean(storage.sessions.verify(scope, principal.sessionId, principal.role)),
    async start() {
      overlayPresence.start();
      await engine.recoverPlayback();
      await media.initialize(); await audio.cleanup();
      recordingExports.purgeInvalidated();
      await narration?.tick();
      await twitch.start();
      scheduler.start();
      interval = setInterval(scheduleTick, 1000); interval.unref();
      scheduleTick();
    },
    async close() {
      if (stopped) return; stopped = true;
      overlayPresence.close(); stopObservingOverlay();
      if (interval) clearInterval(interval);
      await twitch.stop(); await narration?.close(); await scheduler.stop(); await cloud.close(); await tickFlight; await safetyFlight; await engine.idle();
    },
  };
}
