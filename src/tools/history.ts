// Complete workout history, read from the CSV files that tonal-export writes
// (https://tangled.org/ian.gay/tonal-export). Tonal's API only reaches back so far; the export
// keeps everything. The tool is registered only when TONAL_HISTORY_DIR names the export's
// output folder, so without that variable the server is unchanged.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type TonalClient from '@dlwiest/ts-tonal-client';
import type { MCPResponse, MCPToolDefinition } from '../types/index.js';
import { TonalMCPError, handleToolError } from '../utils/error-handler.js';

// table -> the column that from/to filter on (null: the table has no date)
const TABLES: Record<string, string | null> = {
  workouts: 'date',
  sets: 'date',
  strength_scores: 'date',
  movement_progress: 'week',
  custom_workouts: 'created',
  custom_sets: null,
};
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

// RFC 4180: quoted fields may hold commas, doubled quotes and line breaks.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toCsvLine(fields: string[]): string {
  return fields.map(f => (/[",\r\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(',');
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new TonalMCPError(`${name} must be a string`, 'VALIDATION_ERROR', 400);
  return value;
}

export async function queryHistory(_client: TonalClient, args?: Record<string, unknown>): Promise<MCPResponse> {
  try {
    const dir = process.env.TONAL_HISTORY_DIR;
    if (!dir) throw new TonalMCPError('TONAL_HISTORY_DIR is not set', 'CONFIGURATION_ERROR', 500);

    const table = args?.table;
    if (typeof table !== 'string' || !Object.hasOwn(TABLES, table)) {
      throw new TonalMCPError(`table must be one of: ${Object.keys(TABLES).join(', ')}`, 'VALIDATION_ERROR', 400);
    }
    const from = optionalString(args?.from, 'from');
    const to = optionalString(args?.to, 'to');
    const search = optionalString(args?.search, 'search')?.toLowerCase();
    const limit = args?.limit ?? DEFAULT_LIMIT;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new TonalMCPError(`limit must be an integer from 1 to ${MAX_LIMIT}`, 'VALIDATION_ERROR', 400);
    }

    const file = join(dir, `tonal_${table}.csv`);
    const [header, ...rows] = parseCsv(await readFile(file, 'utf8'));
    if (!header) throw new TonalMCPError(`tonal_${table}.csv is empty`, 'CONFIGURATION_ERROR', 500);

    const dateColumn = TABLES[table];
    if ((from || to) && !dateColumn) {
      throw new TonalMCPError(`${table} has no date column; use search instead of from/to`, 'VALIDATION_ERROR', 400);
    }
    const dateIndex = dateColumn ? header.indexOf(dateColumn) : -1;

    let picked = header.map((_, index) => index);
    if (args?.columns !== undefined) {
      if (!Array.isArray(args.columns) || args.columns.length === 0) {
        throw new TonalMCPError('columns must be a non-empty array of column names', 'VALIDATION_ERROR', 400);
      }
      picked = args.columns.map(name => {
        const index = header.indexOf(String(name));
        if (index === -1) throw new TonalMCPError(`${table} has no column "${name}". Columns: ${header.join(', ')}`, 'VALIDATION_ERROR', 400);
        return index;
      });
    }

    const matching = rows.filter(row =>
      (!from || row[dateIndex] >= from) &&
      (!to || row[dateIndex] <= to) &&
      (!search || row.some(field => field.toLowerCase().includes(search)))
    );
    const shown = matching.slice(0, limit);
    const exported = (await stat(file)).mtime.toISOString();
    const text = [
      `tonal_${table}.csv, exported ${exported}: ${shown.length} of ${matching.length} matching rows (${rows.length} in the file)`,
      '',
      toCsvLine(picked.map(index => header[index])),
      ...shown.map(row => toCsvLine(picked.map(index => row[index] ?? ''))),
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return handleToolError(error, 'query_history');
  }
}

const queryHistoryTool: MCPToolDefinition = {
  name: 'query_history',
  description:
    "Query the complete Tonal workout history from a local export (every workout and set since the account began), for questions that reach further back than the live tools do. Returns CSV rows in the file's order, newest first for the dated tables. The export is refreshed on a schedule, so the newest few days may be missing: the first line of the result says when it was written. Tables: workouts (one row per workout), sets (one row per set: movement, weight, reps, volume, estimated 1RM, power), strength_scores (score after each workout), movement_progress (per movement per ISO week), custom_workouts and custom_sets (the user's custom workout definitions). The sets table is wide; pass columns to keep results small.",
  inputSchema: {
    type: 'object',
    properties: {
      table: { type: 'string', enum: Object.keys(TABLES), description: 'Which table to read.' },
      from: { type: 'string', description: 'Earliest date to include, YYYY-MM-DD. For movement_progress use an ISO week such as 2026-W05.' },
      to: { type: 'string', description: 'Latest date to include, in the same format as from.' },
      search: { type: 'string', description: 'Case-insensitive text that must appear somewhere in the row, for example a movement or workout name.' },
      columns: { type: 'array', items: { type: 'string' }, description: 'Column names to return. Omit for all columns. A wrong name is answered with the list of valid ones.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Most rows to return (default ${DEFAULT_LIMIT}).` },
    },
    required: ['table'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
  handler: queryHistory,
};

export const historyTools: MCPToolDefinition[] = process.env.TONAL_HISTORY_DIR ? [queryHistoryTool] : [];
