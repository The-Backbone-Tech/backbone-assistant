import type { ProjectFile } from '@backbone-next/platform';
const LABELS: Record<ProjectFile['class'], string> = { original: 'Original', working: 'Working', accepted: 'Saved', unregistered: 'Unregistered: not given to the engine; attach to use it' };
export const fileClassLabel = (kind: ProjectFile['class']): string => LABELS[kind];
export const reviewFiles = (files: readonly ProjectFile[]): ProjectFile[] => files.filter(file => file.class === 'working');
