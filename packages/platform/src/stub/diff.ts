// A small line diff (LCS) producing a unified patch, for document versions outside git.
import type { FileChange } from '../api.ts';

export function lineDiff(path: string, before: string, after: string): FileChange {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      lines.push(`+${b[j++]}`);
      added++;
    } else {
      lines.push(`-${a[i++]}`);
      removed++;
    }
  }
  const header = `--- a/${path}\n+++ b/${path}\n@@ -${n ? 1 : 0},${n} +${m ? 1 : 0},${m} @@\n`;
  return { path, added, removed, patch: header + lines.join('\n') + '\n' };
}
