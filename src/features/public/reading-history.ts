export interface ReadingMarker { channel: string; session: string; time: number }
export type ReadingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const KEY = 'previously.reading.v1';
/** Reading history contains identifiers and a time only, never story text. */
export class ReadingHistory {
  constructor(private readonly storage?: ReadingStorage) {}
  private all(): ReadingMarker[] {
    try {
      const value: unknown = JSON.parse(this.storage?.getItem(KEY) ?? '[]');
      return Array.isArray(value) ? value.filter((item): item is ReadingMarker => !!item && typeof item.channel === 'string' && typeof item.session === 'string' && Number.isSafeInteger(item.time) && item.time >= 0 && item.time <= 172_800_000).slice(-30) : [];
    } catch { return []; }
  }
  get(channel: string, session: string): number | undefined { return this.all().find(item => item.channel === channel && item.session === session)?.time; }
  set(channel: string, session: string, time: number | undefined) {
    const markers = this.all().filter(item => item.channel !== channel || item.session !== session);
    if (time !== undefined && Number.isSafeInteger(time) && time >= 0 && time <= 172_800_000) markers.push({ channel, session, time });
    try { this.storage?.setItem(KEY, JSON.stringify(markers.slice(-30))); } catch { /* Reading works when storage is unavailable. */ }
  }
  clear() { try { this.storage?.removeItem(KEY); } catch { /* Private browsing may deny storage. */ } }
}
export function parseReadingTime(value: string): number | null {
  const parts = value.trim().split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some(item => !/^\d{1,3}$/.test(item))) return null;
  const numbers = parts.map(Number);
  if (numbers.at(-1)! > 59 || (parts.length === 3 && numbers[1] > 59)) return null;
  const seconds = numbers.reduce((sum, item) => sum * 60 + item, 0);
  return seconds * 1000 <= 172_800_000 ? seconds * 1000 : null;
}
