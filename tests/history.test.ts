import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseCsv, queryHistory } from '../src/tools/history.js';

const text = (response: Awaited<ReturnType<typeof queryHistory>>) =>
  (response.content[0] as { text: string }).text;
const query = (args: Record<string, unknown>) => queryHistory(undefined as never, args);

test('parseCsv handles quotes, embedded commas and line breaks, and CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, ""y""","line\nbreak"\r\n,\r\n'), [
    ['a', 'b'],
    ['x, "y"', 'line\nbreak'],
    ['', ''],
  ]);
});

test('query_history filters by date and text, picks columns and limits rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tonal-history-'));
  await writeFile(
    join(dir, 'tonal_sets.csv'),
    'date,movement,weight_lb,reps\r\n' +
      '2026-03-02,Bench Press,60,8\r\n' +
      '2026-02-01,"Row, Bent Over",50,10\r\n' +
      '2026-01-15,Bench Press,55,8\r\n' +
      '2025-12-01,Bench Press,50,8\r\n'
  );
  await writeFile(join(dir, 'tonal_custom_sets.csv'), 'workout,movement\r\nA,Plank\r\n');
  process.env.TONAL_HISTORY_DIR = dir;

  const bench = text(await query({ table: 'sets', from: '2026-01-01', search: 'bench', columns: ['date', 'weight_lb'], limit: 1 }));
  assert.match(bench, /1 of 2 matching rows \(4 in the file\)/);
  assert.ok(bench.endsWith('date,weight_lb\n2026-03-02,60'));

  const row = text(await query({ table: 'sets', to: '2026-02-28', from: '2026-02-01' }));
  assert.ok(row.endsWith('date,movement,weight_lb,reps\n2026-02-01,"Row, Bent Over",50,10'));

  for (const bad of [
    { table: 'nope' },
    { table: '../etc/passwd' },
    { table: 'sets', columns: ['missing'] },
    { table: 'sets', limit: 0 },
    { table: 'custom_sets', from: '2026-01-01' },
  ]) {
    assert.equal((await query(bad)).isError, true, JSON.stringify(bad));
  }
});
