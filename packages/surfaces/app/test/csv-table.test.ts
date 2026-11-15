import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvTable, serializeCsvTable, setCsvCell } from '../src/components/files/csv-table.ts';

test('cell edits keep quoted multiline text, numeric-looking identifiers, formula text and empty rows', () => {
  const source = '\uFEFFName,ID,Notes,Value\r\n"North, west",0012,"First\nSecond",=SUM(A1)\r\n"A ""quote""",0003,,\r\n\r\n';
  const read = parseCsvTable(source);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  const changed = setCsvCell(read.table, 1, 1, '0042');
  assert.equal(read.table.rows[1][1], '0012', 'a draft does not mutate its saved input');
  const reopened = parseCsvTable(serializeCsvTable(changed));
  assert.equal(reopened.ok, true);
  if (!reopened.ok) return;
  assert.deepEqual(reopened.table.rows, [
    ['Name', 'ID', 'Notes', 'Value'],
    ['North, west', '0042', 'First\nSecond', '=SUM(A1)'],
    ['A "quote"', '0003', '', ''], [''],
  ]);
  assert.equal(reopened.table.bom, true);
  assert.equal(reopened.table.newline, '\r\n');
});

test('semicolon dialect and ragged rows survive editing, including a new empty column', () => {
  const read = parseCsvTable('a;b;c\nx;y\n');
  assert.equal(read.ok, true);
  if (!read.ok) return;
  const reopened = parseCsvTable(serializeCsvTable(setCsvCell(read.table, 1, 2, 'two; words')));
  assert.equal(reopened.ok, true);
  if (!reopened.ok) return;
  assert.deepEqual(reopened.table.rows, [['a', 'b', 'c'], ['x', 'y', 'two; words']]);
  assert.equal(reopened.table.delimiter, ';');
});

test('large or malformed sources never become a truncated editable table', () => {
  for (const source of ['a,b\n"unclosed,value', 'x'.repeat(1024 * 1024 + 1), Array.from({ length: 1002 }, () => 'a,b').join('\n'), Array.from({ length: 101 }, () => 'a').join(',')]) {
    const result = parseCsvTable(source);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.reason.length > 0);
  }
});

test('one-column and empty tables can be edited without inventing values or dropping blanks', () => {
  for (const source of ['', 'one\n\nthree\n']) {
    const read = parseCsvTable(source);
    assert.equal(read.ok, true);
    if (!read.ok) continue;
    const reopened = parseCsvTable(serializeCsvTable(setCsvCell(read.table, 0, 0, 'new, value')));
    assert.equal(reopened.ok, true);
    if (!reopened.ok) continue;
    assert.equal(reopened.table.rows[0][0], 'new, value');
    assert.deepEqual(reopened.table.rows.slice(1), read.table.rows.slice(1));
  }
});

test('a delimiter inside a new single-column value cannot silently change the table shape', () => {
  const read = parseCsvTable('one');
  assert.equal(read.ok, true);
  if (!read.ok) return;
  for (const value of ['a;b;c', 'a|b|c', 'a\tb\tc']) {
    const reopened = parseCsvTable(serializeCsvTable(setCsvCell(read.table, 0, 0, value)));
    assert.equal(reopened.ok, true);
    if (reopened.ok) assert.deepEqual(reopened.table.rows, [[value]]);
  }
});

test('a small source containing many blank records returns to Text without exhausting the renderer stack', () => {
  assert.equal(parseCsvTable('\n'.repeat(150000)).ok, false);
});

test('short locale exports detect semicolons and tabs despite trailing newlines and decimal commas', () => {
  for (const [source, delimiter, expected] of [
    ['Nombre;Ciudad\nAna;Madrid\n', ';', [['Nombre', 'Ciudad'], ['Ana', 'Madrid']]],
    ['Producto;Precio\r\nCafé;1,50\r\nTé;2,00\r\n', ';', [['Producto', 'Precio'], ['Café', '1,50'], ['Té', '2,00']]],
    ['Name\tID\nAna\t0012\n', '\t', [['Name', 'ID'], ['Ana', '0012']]],
  ] as const) {
    const read = parseCsvTable(source);
    assert.equal(read.ok, true);
    if (!read.ok) continue;
    assert.equal(read.table.delimiter, delimiter);
    assert.deepEqual(read.table.rows, expected);
    assert.equal(serializeCsvTable(read.table), source);
  }
});

test('ambiguous decimal-comma data needs an explicit separator instead of silently rewriting its shape', () => {
  const source = 'A;1,5\nB;2,5\n';
  assert.equal(parseCsvTable(source).ok, false);
  const read = parseCsvTable(source, ';');
  assert.equal(read.ok, true);
  if (read.ok) assert.deepEqual(read.table.rows, [['A', '1,5'], ['B', '2,5']]);
});

test('mixed record endings remain separate records and untouched bytes survive a cell edit', () => {
  for (const source of ['h1,h2\r\na,b\nc,d\r\n', 'h1,h2\nc,d\r\ne,f\n']) {
    const read = parseCsvTable(source);
    assert.equal(read.ok, true);
    if (!read.ok) continue;
    assert.equal(read.table.rows.length, 3);
    assert.equal(serializeCsvTable(read.table), source);
    const changed = serializeCsvTable(setCsvCell(read.table, 0, 0, 'changed'));
    assert.equal(changed.slice(changed.indexOf(read.table.newline)), source.slice(source.indexOf(read.table.newline)));
  }
  const source = '"h1","h2"\r\n" a "," b "\n"",""\r\n';
  const read = parseCsvTable(source);
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(serializeCsvTable(setCsvCell(read.table, 0, 0, 'changed')).split('\r\n').slice(1).join('\r\n'), source.split('\r\n').slice(1).join('\r\n'));
});

test('the row ceiling counts records, with no phantom row after the last newline', () => {
  assert.equal(parseCsvTable(Array.from({ length: 1000 }, () => 'a,b').join('\n') + '\n').ok, true);
  assert.equal(parseCsvTable(Array.from({ length: 1001 }, () => 'a,b').join('\n') + '\n').ok, false);
});

test('clearing the last one-column cell keeps its empty record reachable', () => {
  const read = parseCsvTable('Name\nAna\nBob');
  assert.equal(read.ok, true);
  if (!read.ok) return;
  const result = parseCsvTable(serializeCsvTable(setCsvCell(read.table, 2, 0, '')));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.table.rows, [['Name'], ['Ana'], ['']]);
});
