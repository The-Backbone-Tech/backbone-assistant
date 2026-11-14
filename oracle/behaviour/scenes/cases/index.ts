import type { Scenario } from '../scenario.ts';
import { EXFILTRATION } from './exfiltration.ts';
import { GROUP_A } from './group-a.ts';
import { GROUP_B } from './group-b.ts';
import { GROUP_C } from './group-c.ts';

/** Every restated scenario, in the legacy harness's families. */
export const SCENES: readonly Scenario[] = [...EXFILTRATION, ...GROUP_A, ...GROUP_B, ...GROUP_C];
