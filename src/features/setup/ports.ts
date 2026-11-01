import type { RecapPlan } from '../../shared/contracts';

export type SetupDiagnostics = {
  mode: 'local' | 'replay'; runtime: string; storage: 'ready' | 'unavailable'; missing: string[]; configured: boolean;
  twitch: { connected: boolean; lastFailure?: string | null; connection?: { state: string } };
  openai: { connected: boolean; configured?: boolean; paidCallsEnabled: boolean };
  auth: { available: boolean; authenticated: boolean }; publicUrl?: string | null; integrationError?: string;
};
export type PreviousClipCandidate = {
  clip: { id: string; title: string; created_at: string; url: string; embed_url: string };
  status: 'candidate' | 'preparing' | 'ready' | 'unavailable' | 'rejected'; sessionId: string | null; reason?: string;
};
/** Live setup capabilities are separate from the replay-compatible RecapClient. */
export interface SetupPort {
  diagnostics(): Promise<SetupDiagnostics>;
  overlayLink(rotate: boolean): Promise<{ url: string }>;
  previousClip(): Promise<{ candidate: PreviousClipCandidate | null; previousSession?: boolean; checkedAt?: number | null }>;
  preparePreviousClip(input: { clipId: string; sessionId: string | null; use: boolean }): Promise<{ jobId: string; status: 'ready' | 'queued'; mediaId: string; previousSession: boolean; ownerApproved: boolean }>;
  refreshPreviousClip?(): Promise<unknown>;
  connectUrl?: string;
}
export type SetupPreview = (plan: RecapPlan, close: () => void) => React.ReactNode;
