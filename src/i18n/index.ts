/** Interface controls remain English. These labels describe recap presentations. */
export type RecapLanguage = 'en' | 'ru';
export interface RecapMessages { whatMattersNow: string; chapters: string; watchLive: string; watchRecording: string; streamEnded: string; recapPaused: string; sources: string; clipUnavailable: string; originUnconfirmed: string; lastUpdated: string; }
export const recapMessages: Record<RecapLanguage, RecapMessages> = {
  en: { whatMattersNow: 'What matters now', chapters: 'Chapters', watchLive: 'Watch live', watchRecording: 'Watch the recording', streamEnded: 'This stream has ended', recapPaused: 'Recap paused', sources: 'See the sources', clipUnavailable: 'Clip unavailable', originUnconfirmed: 'No confirmed origin yet', lastUpdated: 'Last updated' },
  ru: { whatMattersNow: 'Что происходит сейчас', chapters: 'Главы', watchLive: 'Смотреть эфир', watchRecording: 'Смотреть запись', streamEnded: 'Этот эфир завершён', recapPaused: 'Обновление приостановлено', sources: 'Посмотреть источники', clipUnavailable: 'Клип недоступен', originUnconfirmed: 'Происхождение пока не подтверждено', lastUpdated: 'Последнее обновление' },
};
