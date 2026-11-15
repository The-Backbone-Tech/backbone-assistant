import { Button } from '../ui/button';

export function SettingsReadStatus({ label, pending, failed, hasValue, retry }: {
  label: string; pending: boolean; failed: boolean; hasValue: boolean; retry(): void;
}) {
  if (pending) return <p role="status" className="py-4 text-sm text-muted">{hasValue ? 'Checking the current list…' : 'Loading…'}</p>;
  if (!failed) return null;
  return <div className="space-y-2 py-4 text-sm">
    <p role="alert">{label} could not be loaded.{hasValue && ' Showing the last loaded list. Its current status could not be confirmed.'}</p>
    <Button variant="outline" onClick={retry}>Retry</Button>
  </div>;
}
