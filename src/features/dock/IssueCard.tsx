import type { ReactNode } from 'react';
import type { OwnerIssue } from '../../shared/contracts';
import { Icon } from './icons';
import './issues.css';

const clockTime = (iso: string) => { const time = Date.parse(iso); return Number.isFinite(time) ? new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; };
const issueSubject: Record<OwnerIssue['component'], string> = { transcription: 'Speech', story: 'Chapters', moderation: 'Safety checks', narration: 'Narration', chat: 'Chat' };

/** One integration problem with the owner's recovery, shown where the owner works (dock and setup). */
export function IssueCard({ issue, action }: { issue: OwnerIssue; action?: ReactNode }) {
  return <article className="dk-issue" data-source={issue.source}>
    <Icon name="alert" className="dk-issue__icon" />
    <div className="dk-issue__body">
      <p className="dk-issue__reason">{issue.reason}</p>
      <p className="dk-issue__recovery">{issue.recovery}</p>
      <p className="dk-issue__meta">{issue.source === 'twitch' ? 'Twitch' : 'OpenAI'} {issueSubject[issue.component].toLowerCase()}{clockTime(issue.since) && <>, since {clockTime(issue.since)}</>}</p>
      {action && <div className="dk-issue__action">{action}</div>}
    </div>
  </article>;
}

