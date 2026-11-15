import * as React from 'react';
import { Button } from '../ui/button';
import { CSV_MAX_CELLS, CSV_MAX_COLUMNS, CSV_MAX_ROWS, parseCsvTable, serializeCsvTable, setCsvCell } from './csv-table';

export default function CsvEditor({ name, value, separator, onSeparator, onChange, onSave, onText }: {
  name: string; value: string; separator?: string; onSeparator(value: string | undefined): void;
  onChange(value: string): void; onSave(): void; onText(): void;
}) {
  const parsed = React.useMemo(() => parseCsvTable(value, separator), [value, separator]);
  const [page, setPage] = React.useState(0);
  const separatorChoice = <label className="flex items-center gap-2 text-xs text-muted">Separator
    <select aria-label="CSV separator" className="rounded border border-border bg-surface px-2 py-1 text-fg" value={separator ?? ''} onChange={event => { onSeparator(event.target.value || undefined); setPage(0); }}>
      <option value="">Automatic</option><option value=",">Comma</option><option value=";">Semicolon</option><option value={'\t'}>Tab</option><option value="|">Pipe</option>
    </select>
    {parsed.ok && !separator && <span>({({ ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' } as Record<string, string>)[parsed.table.delimiter]})</span>}
  </label>;
  if (!parsed.ok) return <div className="space-y-3 p-4 text-sm">{separatorChoice}<p role="status">{parsed.reason}</p><Button variant="outline" onClick={onText}>Open Text</Button></div>;
  const table = parsed.table;
  const update = (next: typeof table) => { onSeparator(table.delimiter); onChange(serializeCsvTable(next)); };
  const columns = Math.max(1, ...table.rows.map(row => row.length));
  const pageSize = Math.max(5, Math.min(25, Math.floor(500 / columns)));
  const lastPage = Math.max(0, Math.ceil(table.rows.length / pageSize) - 1);
  const shownPage = Math.min(page, lastPage);
  const start = shownPage * pageSize;
  const canAddRow = table.rows.length < CSV_MAX_ROWS && (table.rows.length + 1) * columns <= CSV_MAX_CELLS;
  const canAddColumn = columns < CSV_MAX_COLUMNS && table.rows.length * (columns + 1) <= CSV_MAX_CELLS;
  return <div className="flex h-full min-h-0 flex-col" data-testid="csv-editor" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); onSave(); }
  }}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
      <span className="text-muted">{table.rows.length} rows · {columns} columns</span>
      {separatorChoice}
      <Button variant="outline" size="sm" disabled={!canAddRow} onClick={() => {
        update({ ...table, rows: [...table.rows, Array.from({ length: columns }, () => '')] });
        setPage(Math.floor(table.rows.length / pageSize));
      }}>Add row</Button>
      <Button variant="outline" size="sm" disabled={!canAddColumn} onClick={() => update({ ...table, rows: table.rows.map(row => [...row, ...Array.from({ length: columns + 1 - row.length }, () => '')]) })}>Add column</Button>
      {lastPage > 0 && <span className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>Previous rows</Button>
        <span role="status">{start + 1}–{Math.min(start + pageSize, table.rows.length)} of {table.rows.length}</span>
        <Button variant="ghost" size="sm" disabled={shownPage === lastPage} onClick={() => setPage(shownPage + 1)}>Next rows</Button>
      </span>}
    </div>
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-sm" aria-label={`Edit ${name} as table`}>
        <thead className="sticky top-0 z-10 bg-surface"><tr><th scope="col" className="border-b border-r border-border px-2 py-1 text-xs text-muted">Row</th>
          {Array.from({ length: columns }, (_, column) => <th key={column} scope="col" className="border-b border-r border-border px-2 py-1 text-left text-xs font-normal text-muted">Column {column + 1}</th>)}
        </tr></thead>
        <tbody>{table.rows.slice(start, start + pageSize).map((row, offset) => {
          const index = start + offset;
          return <tr key={index}><th scope="row" className="border-b border-r border-border px-2 py-1 text-xs font-normal text-muted">{index + 1}</th>
            {Array.from({ length: columns }, (_, column) => <td key={column} className="border-b border-r border-border p-0 align-top">
              <textarea aria-label={`Row ${index + 1}, column ${column + 1}`} className="block min-h-8 w-full min-w-32 resize-y bg-transparent px-2 py-1 text-fg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent" rows={Math.min(4, (row[column] ?? '').split('\n').length)} value={row[column] ?? ''} onChange={event => update(setCsvCell(table, index, column, event.target.value))} />
            </td>)}
          </tr>;
        })}</tbody>
      </table>
    </div>
  </div>;
}
