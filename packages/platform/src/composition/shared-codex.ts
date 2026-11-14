import type {Turn} from '../api.ts';
/** One visible explanation per turn, including after recovery. */
export function noteSharedCodex(turn:Turn){
 const label='Your Codex connectors are off in shared projects';
 if(!turn.work.steps.some(step=>step.kind==='note'&&step.label===label))turn.work.steps.push({kind:'note',label});
}
