// Nondefault windows identify their data folder even when the usual shell is unavailable.
export function DataFolderLabel({ folder }: { folder?: string }) {
  return folder ? <p data-testid="startup-data-folder" className="break-all font-mono text-xs text-muted">Data folder: {folder}</p> : null;
}
