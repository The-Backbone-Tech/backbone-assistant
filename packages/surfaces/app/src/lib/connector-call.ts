/** Reversible display of exact JSON; hidden direction controls are escaped, never silently removed. */
export function exactText(value: unknown): string {
  return JSON.stringify(value).replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, char => char.split('').map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
}
