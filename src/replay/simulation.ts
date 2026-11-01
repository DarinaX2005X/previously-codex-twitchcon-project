import type { EffectsSink, SideEffectJob, DispatchResult } from '../shared/contracts/index.js';
import type { DomainEffect } from '../core/index.js';
/** Deliberately has no live adapter, environment or fetch dependency. */
export class SimulationSink implements EffectsSink {
  readonly mode='simulation' as const;
  readonly actions:{kind:string;id:string}[]=[];
  async dispatch(job:SideEffectJob):Promise<DispatchResult>{this.actions.push({kind:job.kind,id:job.id});return {status:'simulated'};}
  record(effect:DomainEffect){if(['publication','clip.request','playback.start','clip.cleanup'].includes(effect.type))this.actions.push({kind:effect.type,id:'simulated'});}
  clear(){this.actions.length=0;}
}
