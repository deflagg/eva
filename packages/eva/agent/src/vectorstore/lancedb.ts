import path from 'node:path';
import { mkdir } from 'node:fs/promises';

import * as lancedb from '@lancedb/lancedb';
import type {
  Connection,
  MergeResult,
  SchemaLike,
  Table,
} from '@lancedb/lancedb';

const LANCEDB_RELATIVE_DIR = path.join('vector_db', 'lancedb');
const VECTOR_COLUMN_NAME = 'vector';

export function deriveLanceDbDir(memoryDir: string): string {
  return path.resolve(memoryDir, LANCEDB_RELATIVE_DIR);
}

export async function openDb(lancedbDir: string): Promise<Connection> {
  const resolvedDir = path.resolve(lancedbDir);
  await mkdir(resolvedDir, { recursive: true });
  return await lancedb.connect(resolvedDir);
}

export async function getOrCreateTable(
  db: Connection,
  name: string,
  schema: SchemaLike,
): Promise<Table> {
  const existingTableNames = await db.tableNames();
  if (existingTableNames.includes(name)) {
    return await db.openTable(name);
  }

  return await db.createEmptyTable(name, schema, {
    mode: 'create',
    existOk: true,
  });
}

export async function mergeUpsertById(
  table: Table,
  rows: Array<Record<string, unknown>>,
): Promise<MergeResult | null> {
  if (rows.length === 0) {
    return null;
  }

  return await table
    .mergeInsert(['id'])
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute(rows);
}

export async function queryTopK(
  table: Table,
  queryVector: number[],
  k: number,
): Promise<Array<Record<string, unknown>>> {
  if (k <= 0) {
    return [];
  }

  const rows = await table.vectorSearch(queryVector).column(VECTOR_COLUMN_NAME).limit(k).toArray();
  return rows as Array<Record<string, unknown>>;
}
