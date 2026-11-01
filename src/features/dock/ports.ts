import type { CaptureState } from '../capture/controller';
import type { Lore, Source, InvalidationReceipt, RecapPlan, OwnerHistoryQuery, OwnerHistoryPage } from '../../shared/contracts';
import type { ReactNode } from 'react';

/** Optional capabilities are injected. A recorded dock never discovers or calls live routes. */
export interface DockOwnerPort {
  listHistory?(query: OwnerHistoryQuery): Promise<OwnerHistoryPage>;
  listSources(query: { sessionId: string; fromMs?: number; toMs?: number; cursor?: string; limit: number }): Promise<{ items: Source[]; nextCursor: string | null }>;
  editLore(id: string, patch: { term: string; explanation: string; originMs: number | null; baseRevision: number }): Promise<Lore>;
  confirmLore(id: string, baseRevision: number): Promise<Lore>;
  deleteLore(id: string, baseRevision: number): Promise<InvalidationReceipt>;
  blockLore(id: string, blocked: boolean, baseRevision: number): Promise<Lore>;
}
export interface DockCapturePort {
  getSnapshot(): CaptureState;
  subscribe(listener: () => void): () => void;
  start(sessionId: string, takeover?: boolean): Promise<void>;
  pause(): Promise<void>;
}
export type DockPreviewRenderer = (plan: RecapPlan, close: () => void) => ReactNode;
