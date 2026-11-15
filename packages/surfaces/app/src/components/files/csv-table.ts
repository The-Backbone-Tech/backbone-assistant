// Cell editing always owns a complete CSV. The bounded preview parser must never write a file.
import Papa from 'papaparse';

export const CSV_MAX_ROWS = 1000;
export const CSV_MAX_COLUMNS = 100;
export const CSV_MAX_CELLS = 10000;
const DELIMITERS = [',', ';', '\t', '|'];
interface RecordSpan { raw: string; ending: string; values: string[] }
export interface CsvTable { rows: string[][]; delimiter: string; newline: '\n' | '\r\n' | '\r'; bom: boolean; records: RecordSpan[] }
export type CsvRead = { ok: true; table: CsvTable } | { ok: false; reason: string };

// Keep source record spans; Papa owns field parsing and quoting. Only separators outside a
// quoted field end a record, including files that mix CRLF, LF and CR. A final ending is not
// another empty record. Escaped quotes inside a field do not close it.
function recordsOf(source: string, delimiter: string): { raw: string; ending: string }[] | null {
  const records: { raw: string; ending: string }[] = [];
  let start = 0, quoted = false, fieldStart = true;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { index++; continue; }
      if (quoted) quoted = false;
      else if (fieldStart) quoted = true;
      fieldStart = false;
    } else if (!quoted && (char === '\n' || char === '\r')) {
      const ending = char === '\r' && source[index + 1] === '\n' ? '\r\n' : char;
      records.push({ raw: source.slice(start, index), ending });
      if (records.length > CSV_MAX_ROWS) return records;
      index += ending.length - 1; start = index + 1; fieldStart = true;
    } else if (!quoted) fieldStart = char === delimiter;
  }
  if (quoted) return null;
  if (start < source.length || records.length === 0) records.push({ raw: source.slice(start), ending: '' });
  return records;
}

function readRecord(raw: string, delimiter: string): string[] | null {
  if (raw === '') return [''];
  const parsed = Papa.parse<string[]>(raw, { delimiter, newline: '\n', dynamicTyping: false, skipEmptyLines: false });
  return parsed.errors.length || parsed.data.length !== 1 ? null : parsed.data[0];
}

export function parseCsvTable(source: string, separator?: string): CsvRead {
  const tooLarge = 'This CSV is too large for cell editing. Use Text to edit the complete file.';
  if (source.length > 1024 * 1024) return { ok: false, reason: tooLarge };
  const bom = source.startsWith('\uFEFF');
  const text = bom ? source.slice(1) : source;
  const candidates = (separator && DELIMITERS.includes(separator) ? [separator] : DELIMITERS).map(delimiter => {
    const spans = recordsOf(text, delimiter);
    if (!spans) return null;
    const sample = spans.filter(span => span.raw.trim() !== '').slice(0, 10).map(span => readRecord(span.raw, delimiter));
    if (sample.some(row => row === null)) return null;
    const counts = new Map<number, number>();
    for (const row of sample) if (row!.length > 1) counts.set(row!.length, (counts.get(row!.length) ?? 0) + 1);
    const score = counts.size ? Math.max(...counts.values()) / Math.max(1, sample.length) : 0;
    return { delimiter, spans, score };
  }).filter(candidate => candidate !== null);
  const bestScore = Math.max(0, ...candidates.map(candidate => candidate.score));
  const best = candidates.filter(candidate => candidate.score === bestScore && (bestScore > 0 || candidate.delimiter === ',' || separator));
  if (best.length > 1 && !separator) return { ok: false, reason: 'More than one separator fits this CSV. Choose its separator to edit cells, or open Text.' };
  const chosen = best[0];
  if (!chosen) return { ok: false, reason: 'This CSV could not be read as a complete table. Use Text to inspect it.' };
  if (chosen.spans.length > CSV_MAX_ROWS) return { ok: false, reason: tooLarge };
  const records: RecordSpan[] = [];
  for (const span of chosen.spans) {
    const values = readRecord(span.raw, chosen.delimiter);
    if (!values) return { ok: false, reason: 'This CSV could not be read as a complete table. Use Text to inspect it.' };
    records.push({ ...span, values });
  }
  const rows = records.map(record => record.values);
  const columns = Math.max(1, ...rows.map(row => row.length));
  if (columns > CSV_MAX_COLUMNS || rows.length * columns > CSV_MAX_CELLS) return { ok: false, reason: tooLarge };
  const ending = records.find(record => record.ending)?.ending;
  const newline = ending === '\r\n' || ending === '\r' ? ending : '\n';
  return { ok: true, table: { rows, delimiter: chosen.delimiter, newline, bom, records } };
}

export function serializeCsvTable(table: CsvTable): string {
  return (table.bom ? '\uFEFF' : '') + table.rows.map((row, index) => {
    const original = table.records[index];
    const unchanged = original && row.length === original.values.length && row.every((value, column) => value === original.values[column]);
    let raw = unchanged ? original.raw : Papa.unparse([row], {
      delimiter: table.delimiter, header: false, skipEmptyLines: false,
      quotes: value => /[,;\t|]/.test(String(value)) || String(value).startsWith('\uFEFF'),
    });
    if (!unchanged && raw === '' && index === table.rows.length - 1) raw = '""';
    // Appending a row supplies a boundary if the old last record had no ending.
    const ending = original ? original.ending || (index < table.rows.length - 1 ? table.newline : '') : table.newline;
    return raw + ending;
  }).join('');
}

export function setCsvCell(table: CsvTable, row: number, column: number, value: string): CsvTable {
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || row >= table.rows.length || column < 0 || column >= CSV_MAX_COLUMNS) throw new Error('The cell is outside this table.');
  const rows = table.rows.map((cells, index) => {
    if (index !== row) return cells;
    const next = [...cells];
    while (next.length <= column) next.push('');
    next[column] = value;
    return next;
  });
  return { ...table, rows };
}
