import type { DomainEvent } from '../../core/types.js';
import { asksForClip, isLaughter } from '../../core/chat-signals.js';
import type { EventEnvelope, Session, Source } from '../../shared/contracts/index.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 12000) => typeof value === 'string' ? value.slice(0, max) : '';

/** Normalize provider data into a bounded event. Nothing in a chat message is executable. */
export function normalizeInput(envelope: EventEnvelope, session: Session, options: {paused: boolean; ownEcho?: boolean}): {event: EventEnvelope; domain: DomainEvent | null} {
  const payload = object(envelope.payload);
  const atMs = Math.max(0, Math.min(172_800_000, envelope.sessionOffsetMs ?? Date.parse(envelope.occurredAt) - Date.parse(session.startedAt)));
  const event = {...envelope, sessionId: session.id, sessionOffsetMs: atMs};
  const ignored = () => ({event: {...event, payload: null}, domain: null});
  switch (event.kind) {
    case 'channel.chat.message': {
      if (options.paused || options.ownEcho || payload.late || payload.quotesReady === false) return ignored();
      const message = object(payload.message);
      const content = text(message.text);
      const actorId = text(payload.chatter_user_id, 160), externalMessageId = text(payload.message_id, 160);
      if (!actorId || !externalMessageId || !content) return ignored();
      const fragments = Array.isArray(message.fragments) ? message.fragments.slice(0, 100).map(object) : [];
      const source: Source = {
        channelId: event.channelId, runId: event.runId, sessionId: session.id,
        id: `chat:${externalMessageId}`, revision: 1, kind: 'chat', startMs: atMs, endMs: atMs,
        actorId, languageCodes: [], timePrecision: 'event', text: content,
        status: 'active', externalMessageId, moderation: 'pending',
      };
      return {event: {...event, payload: {source}}, domain: {type: 'source', source, signals: {
        emote: fragments.some(fragment => fragment.type === 'emote'),
        laughter: isLaughter(content),
        clipIt: asksForClip(content),
      }, ...(content.length <= 80 && !content.trim().startsWith('!') ? {phrase: content} : {})}};
    }
    case 'channel.chat.message_delete':
      return {event: {...event, payload: {messageId: text(payload.message_id, 160)}}, domain: {type: 'privacy', target: {kind: 'message', sessionId: session.id, externalMessageId: text(payload.message_id, 160)}}};
    case 'channel.chat.clear_user_messages':
      return {event: {...event, payload: {actorId: text(payload.target_user_id, 160)}}, domain: {type: 'privacy', target: {kind: 'user', sessionId: session.id, actorId: text(payload.target_user_id, 160), throughMs: atMs}}};
    case 'channel.chat.clear':
      return {event: {...event, payload: null}, domain: {type: 'chat.clear', throughMs: atMs}};
    case 'channel.ban':
      return {event: {...event, payload: {actorId: text(payload.user_id, 160)}}, domain: {type: 'ban', actorId: text(payload.user_id, 160), throughMs: atMs}};
    case 'channel.unban':
      return {event: {...event, payload: {actorId: text(payload.user_id, 160)}}, domain: {type: 'unban', actorId: text(payload.user_id, 160)}};
    case 'channel.raid': {
      if (payload.late) return ignored();
      const viewers = Number(payload.viewers);
      return {event, domain: {type: 'recap.trigger', trigger: {
        id: event.eventId, sessionId: session.id, reason: 'raid', occurredAt: event.occurredAt,
        fromLogin: text(payload.from_broadcaster_user_login, 25), viewers: Number.isSafeInteger(viewers) ? Math.max(0, viewers) : 0,
      }}};
    }
    case 'stream.offline':
      return {event: {...event, payload: null}, domain: {type: 'closing', endedAt: event.occurredAt}};
    case 'speech.transcribed': {
      const source = payload.source as Source | undefined;
      return source ? {event, domain: {type: 'source', source}} : ignored();
    }
    default: return {event, domain: null};
  }
}
