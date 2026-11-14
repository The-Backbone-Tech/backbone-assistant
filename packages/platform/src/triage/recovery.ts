// One bounded pass over current UNKNOWN receipts. Provider failures leave their uncertainty intact.
export async function reconcileMailboxUnknowns(
  effects: () => Promise<Map<string, { status: string; operation: string }>>,
  probe: (id: string) => Promise<unknown>,
): Promise<void> {
  for (const [id, row] of await effects()) {
    if (row.status === 'unknown' && row.operation.startsWith('mail.')) await probe(id).catch(() => {});
  }
}
