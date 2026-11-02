import type { OwnerIssue } from '../../shared/contracts/index.js';
import type { ProviderComponent, ProviderIssue } from '../providers/transport.js';

type Key = `${OwnerIssue['source']}:${OwnerIssue['component']}`;
type TwitchStatusView = {connected: boolean; missingPermissions: string[]; connection: {state: string; privacyBlocked?: boolean}; lastFailure: string | null};

/** Fixed owner-facing wording for the Twitch connection, derived from runtime status only. */
export function twitchIssues(status: TwitchStatusView): Omit<OwnerIssue, 'since'>[] {
  const chat = {source: 'twitch' as const, component: 'chat' as const};
  if (status.missingPermissions.length) return [{...chat, code: 'twitch_missing_permissions', reason: `Twitch did not grant: ${status.missingPermissions.join(', ')}.`, recovery: 'Reconnect Twitch in setup and approve every requested permission.'}];
  if (status.connection.state === 'revoked') return [{...chat, code: 'twitch_revoked', reason: 'Twitch withdrew this app\'s access.', recovery: 'Reconnect Twitch to receive new chat.'}];
  if (!status.connected) return [{...chat, code: 'twitch_not_connected', reason: 'Twitch is not connected, so new chat and raids are not received.', recovery: 'Open setup and connect Twitch with the broadcaster account.'}];
  const issues: Omit<OwnerIssue, 'since'>[] = [];
  if (status.connection.privacyBlocked) issues.push({...chat, code: 'twitch_privacy_pending', reason: 'A chat removal from Twitch is not applied yet, so recap output is paused.', recovery: 'Check free disk space; output resumes automatically once it is saved.'});
  else if (status.connection.state === 'gap') issues.push({...chat, code: 'twitch_reconnecting', reason: 'The Twitch chat connection dropped.', recovery: 'Previously is reconnecting. Reconnect Twitch in setup if this persists.'});
  if (status.lastFailure) issues.push({source: 'twitch', component: 'chat', code: 'twitch_action_failed', reason: status.lastFailure, recovery: 'Open Twitch setup for details.'});
  return issues;
}

/** Remembers provider problems until the same component succeeds again; Twitch problems are derived on read. */
export class IssueBoard {
  private readonly provider = new Map<Key, OwnerIssue>();
  private readonly firstSeen = new Map<string, string>();
  constructor(private readonly now: () => string, private readonly twitch: () => Omit<OwnerIssue, 'since'>[] = () => [], private readonly onChange: (component: ProviderComponent, issue: ProviderIssue | null) => void = () => {}) {}
  setProvider(component: ProviderComponent, issue: ProviderIssue | null): void {
    const key: Key = `openai:${component}`, previous = this.provider.get(key);
    if (!issue) {if (!previous) return; this.provider.delete(key); this.onChange(component, null); return;}
    if (previous?.code === issue.code && previous.reason === issue.reason) return;
    this.provider.set(key, {source: 'openai', component, ...issue, since: previous?.code === issue.code ? previous.since : this.now()});
    this.onChange(component, issue);
  }
  list(): OwnerIssue[] {
    let derived: Omit<OwnerIssue, 'since'>[] = [];
    try {derived = this.twitch();} catch { /* Status reads never break the owner snapshot. */ }
    const live = new Set(derived.map(issue => issue.code));
    for (const code of [...this.firstSeen.keys()]) if (!live.has(code)) this.firstSeen.delete(code);
    const twitch = derived.map(issue => {if (!this.firstSeen.has(issue.code)) this.firstSeen.set(issue.code, this.now()); return {...issue, since: this.firstSeen.get(issue.code)!};});
    return structuredClone([...twitch, ...this.provider.values()]);
  }
}
