import type { Scope } from '../../shared/contracts/index.js';
import type { WorkLease } from '../storage/index.js';

export interface SchedulerRepository {
  claimJob(scope: Scope, options: {kinds: string[]; leaseMs: number; sessionId?: string}): WorkLease | null;
  renewJob(scope: Scope, id: string, leaseToken: string, leaseMs?: number): boolean;
  finishJob(scope: Scope, id: string, leaseToken: string, state: 'done' | 'failed' | 'unknown_outcome', nextAtMs?: number): boolean;
}
export type JobResult = {state: 'done' | 'failed' | 'unknown_outcome'; retryAtMs?: number};
export type JobLane = {scope: Scope; kinds: string[]; concurrency: number; sessionId?: string; execute(job: WorkLease, signal: AbortSignal): Promise<JobResult>};

/** SQLite owns pending work. Only a fixed number of active leases live in memory. */
export class BoundedScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly active = new Map<Promise<void>, {controller: AbortController; lane: JobLane; job: WorkLease; renewal: ReturnType<typeof setInterval>}>();
  private stopped = false;
  constructor(private readonly repository: SchedulerRepository, private readonly lanes: JobLane[], private readonly onError: () => void = () => {}) {
    if (lanes.length > 32 || lanes.some(lane => !Number.isInteger(lane.concurrency) || lane.concurrency < 1 || lane.concurrency > 2 || !lane.kinds.length)) throw new Error('Scheduler lanes exceed their configured bounds.');
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.tick(); this.timer = setInterval(() => this.tick(), 250); this.timer.unref();
  }
  tick(): void {
    if (this.stopped) return;
    for (const lane of this.lanes) {
      const used = [...this.active.values()].filter(value => value.lane === lane).length;
      for (let i = used; i < lane.concurrency; i++) {
        let job: WorkLease | null;
        try {job = this.repository.claimJob(lane.scope, {kinds: lane.kinds, leaseMs: 30_000, ...(lane.sessionId ? {sessionId: lane.sessionId} : {})});}
        catch {this.onError(); break;}
        if (!job) break;
        const controller = new AbortController();
        const leased = job;
        const renewal = setInterval(() => {
          try {if (!this.repository.renewJob(lane.scope, leased.id, leased.leaseToken, 30_000)) controller.abort();}
          catch {controller.abort(); this.onError();}
        }, 10_000);
        renewal.unref();
        const task = Promise.resolve().then(() => lane.execute(leased, controller.signal)).then(result => {
          if (!controller.signal.aborted) this.repository.finishJob(lane.scope, leased.id, leased.leaseToken, result.state, result.state === 'unknown_outcome' ? undefined : result.retryAtMs);
        }).catch(() => {
          // A thrown network task may have reached its provider; never blindly resend it.
          if (!controller.signal.aborted) {
            try {this.repository.finishJob(lane.scope, leased.id, leased.leaseToken, 'unknown_outcome');} catch {this.onError();}
          }
          this.onError();
        }).finally(() => {clearInterval(renewal); this.active.delete(task);});
        this.active.set(task, {controller, lane, job: leased, renewal});
      }
    }
  }
  async stop(graceMs = 10_000): Promise<void> {
    this.stopped = true; if (this.timer) clearInterval(this.timer);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.active.keys()]), new Promise<void>(resolve => {timeout = setTimeout(resolve, graceMs);})]);
    if (timeout) clearTimeout(timeout);
    for (const {controller, lane, job, renewal} of this.active.values()) {
      clearInterval(renewal);
      controller.abort();
      // A dispatched external effect may have happened. Persist ambiguity before closing storage.
      try {this.repository.finishJob(lane.scope, job.id, job.leaseToken, 'unknown_outcome');} catch {this.onError();}
    }
    // Undispatched jobs remain queued in SQLite; no in-memory queue is discarded.
  }
}
