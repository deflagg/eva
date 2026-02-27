import { Field, FixedSizeList, Float32, Float64, List, Schema, Utf8 } from 'apache-arrow';

import { getOrCreateTable, openDb, queryTopK } from './long_term/lancedb.js';
import { selectTopSemanticItems } from './long_term/semantic_db.js';

const VECTOR_EMBEDDING_DIMENSIONS = 64;
const LONG_TERM_EXPERIENCES_TABLE = 'long_term_experiences';
const MAX_TRAIT_ITEMS = 12;
const MAX_EXPERIENCE_ITEMS = 8;
const MAX_LINE_CHARS = 220;

interface BuildRespondLongTermContextInput {
  semanticDbPath: string;
  lancedbDir: string;
  userText: string;
  tokenBudget: number;
}

interface RetrievedExperience {
  text: string;
  tags: string[];
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function truncateText(value: string, maxLength = MAX_LINE_CHARS): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function appendLineWithinBudget(
  lines: string[],
  line: string,
  budget: { usedTokens: number; maxTokens: number },
): boolean {
  const normalized = line.trim();
  if (!normalized) {
    return false;
  }

  const lineTokens = estimateTokens(normalized) + 1;
  if (budget.usedTokens + lineTokens > budget.maxTokens) {
    return false;
  }

  lines.push(normalized);
  budget.usedTokens += lineTokens;
  return true;
}

function hashToken(token: string): number {
  let hash = 2166136261;

  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function tokenizeTextForEmbedding(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9_]+/g);
  return matches ?? [];
}

function buildHashedEmbedding(text: string, dimensions = VECTOR_EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenizeTextForEmbedding(text);

  if (tokens.length === 0) {
    return vector;
  }

  for (const token of tokens) {
    const hash = hashToken(token);
    const index = hash % dimensions;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[index] += sign;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const tags: string[] = [];
  for (const tag of raw) {
    if (typeof tag !== 'string') {
      continue;
    }

    const normalized = tag.trim().toLowerCase();
    if (!normalized || tags.includes(normalized)) {
      continue;
    }

    tags.push(normalized);
  }

  return tags;
}

function getLanceTableSchema(): Schema {
  return new Schema([
    new Field('id', new Utf8(), false),
    new Field('ts_ms', new Float64(), false),
    new Field('source_summary_id', new Float64(), false),
    new Field('source_created_at_ms', new Float64(), false),
    new Field('updated_at_ms', new Float64(), false),
    new Field('text', new Utf8(), false),
    new Field('tags', new List(new Field('item', new Utf8(), true)), false),
    new Field('vector', new FixedSizeList(VECTOR_EMBEDDING_DIMENSIONS, new Field('item', new Float32(), true)), false),
  ]);
}

async function retrieveRelevantExperiences(
  lancedbDir: string,
  userText: string,
  limit: number,
): Promise<RetrievedExperience[]> {
  const db = await openDb(lancedbDir);
  let table: Awaited<ReturnType<typeof getOrCreateTable>> | null = null;

  try {
    table = await getOrCreateTable(db, LONG_TERM_EXPERIENCES_TABLE, getLanceTableSchema());
    const queryEmbedding = buildHashedEmbedding(userText);
    const rows = await queryTopK(table, queryEmbedding, limit);

    const experiences: RetrievedExperience[] = [];

    for (const row of rows) {
      const text = typeof row.text === 'string' ? row.text.trim() : '';
      if (!text) {
        continue;
      }

      experiences.push({
        text,
        tags: normalizeTags(row.tags),
      });
    }

    return experiences;
  } finally {
    if (table) {
      table.close();
    }

    db.close();
  }
}

export async function buildRespondLongTermContext(input: BuildRespondLongTermContextInput): Promise<string> {
  const tokenBudget = Math.max(1, Math.floor(input.tokenBudget));
  const budget = {
    usedTokens: 0,
    maxTokens: tokenBudget,
  };

  const lines: string[] = [];

  appendLineWithinBudget(lines, 'Traits (long-term):', budget);

  try {
    const traits = selectTopSemanticItems(input.semanticDbPath, MAX_TRAIT_ITEMS, 'support');

    if (traits.length === 0) {
      appendLineWithinBudget(lines, '- No long-term traits captured yet.', budget);
    } else {
      const sortedTraits = [...traits].sort(
        (a, b) =>
          b.supportCount - a.supportCount ||
          b.confidence - a.confidence ||
          b.lastSeenMs - a.lastSeenMs ||
          a.id.localeCompare(b.id),
      );

      for (const trait of sortedTraits) {
        if (
          !appendLineWithinBudget(
            lines,
            `- [${trait.kind}] ${truncateText(trait.text, 180)} (confidence=${trait.confidence.toFixed(2)}, support=${trait.supportCount})`,
            budget,
          )
        ) {
          break;
        }
      }
    }
  } catch {
    appendLineWithinBudget(lines, '- Traits unavailable (semantic memory lookup failed).', budget);
  }

  appendLineWithinBudget(lines, 'Relevant experiences (retrieved):', budget);

  try {
    const experiences = await retrieveRelevantExperiences(input.lancedbDir, input.userText, MAX_EXPERIENCE_ITEMS);

    if (experiences.length === 0) {
      appendLineWithinBudget(lines, '- No relevant long-term experiences found.', budget);
    } else {
      for (const experience of experiences) {
        const tagsText = experience.tags.length > 0 ? ` tags=[${experience.tags.join(',')}]` : '';
        if (!appendLineWithinBudget(lines, `- ${truncateText(experience.text, 170)}${tagsText}`, budget)) {
          break;
        }
      }
    }
  } catch {
    appendLineWithinBudget(lines, '- Relevant experiences unavailable (LanceDB retrieval failed).', budget);
  }

  if (lines.length === 0) {
    return 'Traits (long-term):\n- No long-term memory context available.';
  }

  return lines.join('\n');
}
