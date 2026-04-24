import * as lancedb from '@lancedb/lancedb';
import { getServiceNowContext } from './servicenowContextService.js';
import { embedBatch }           from './embeddingService.js';
import { logger }               from '../utils/logger.js';
import path                     from 'path';
import { fileURLToPath }        from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH    = path.resolve(__dirname, '../../data/vectors');
const TABLE_NAME = 'sn_content';

function buildChunks({ kbArticles, catalogItems, incidentTypes }) {
  const chunks = [];

  for (const art of kbArticles) {
    chunks.push({
      id:       art.number,
      type:     'kb',
      text:     `[Knowledge Base Article ${art.number}]\nTitle: ${art.title}\nCategory: ${art.category}\nContent: ${art.summary}`,
      metadata: JSON.stringify({ number: art.number, title: art.title, category: art.category }),
    });
  }

  for (const item of catalogItems) {
    chunks.push({
      id:       `catalog_${item.sys_id ?? item.name}`,
      type:     'catalog',
      text:     `[Service Catalog Item]\nName: ${item.name}\nCategory: ${item.category}\nDescription: ${item.description}`,
      metadata: JSON.stringify({ name: item.name, category: item.category, sys_id: item.sys_id }),
    });
  }

  for (const cat of incidentTypes) {
    const subs = cat.subcategories.length > 0
      ? cat.subcategories.map(s => `  - ${s.label} (value: ${s.value})`).join('\n')
      : '  (no subcategories)';

    chunks.push({
      id:       `incident_cat_${cat.value}`,
      type:     'incident_category',
      text:     `[Incident Category]\nCategory: ${cat.label} (value: ${cat.value})\nSubcategories:\n${subs}`,
      metadata: JSON.stringify({ value: cat.value, label: cat.label, subcategories: cat.subcategories }),
    });
  }

  return chunks;
}

async function openDB() {
  return await lancedb.connect(DB_PATH);
}

export async function indexExists() {
  try {
    const db    = await openDB();
    const names = await db.tableNames();
    if (!names.includes(TABLE_NAME)) return false;
    const table = await db.openTable(TABLE_NAME);
    const count = await table.countRows();
    return count > 0;
  } catch {
    return false;
  }
}

export async function buildIndex() {
  logger.info('[Indexer] Starting ServiceNow content indexing...');

  const snContext = await getServiceNowContext();
  const { kbArticles, catalogItems, incidentTypes } = snContext;

  logger.info(`[Indexer] Content to index: KB=${kbArticles.length} | Catalog=${catalogItems.length} | IncidentCats=${incidentTypes.length}`);

  const chunks = buildChunks(snContext);
  logger.info(`[Indexer] Total chunks: ${chunks.length}`);

  if (chunks.length === 0) {
    logger.warn('[Indexer] No content to index. Check ServiceNow connection.');
    return { indexed: 0, breakdown: {} };
  }

  logger.info('[Indexer] Generating embeddings with nomic-embed-text...');
  const texts   = chunks.map(c => c.text);
  const vectors = await embedBatch(texts);

  const rows = chunks.map((chunk, i) => ({
    id:       chunk.id,
    type:     chunk.type,
    text:     chunk.text,
    metadata: chunk.metadata,
    vector:   vectors[i],
  }));

  const db             = await openDB();
  const existingTables = await db.tableNames();

  if (existingTables.includes(TABLE_NAME)) {
    await db.dropTable(TABLE_NAME);
    logger.info('[Indexer] Dropped existing table for clean reindex.');
  }

  const table = await db.createTable(TABLE_NAME, rows);
  const count = await table.countRows();

  const breakdown = {
    kb_articles:         kbArticles.length,
    catalog_items:       catalogItems.length,
    incident_categories: incidentTypes.length,
    total_chunks:        count,
  };

  logger.info('[Indexer] Indexing complete:', breakdown);
  return { indexed: count, breakdown };
}

export async function searchIndex(queryVector, topK = 5, typeFilter = null) {
  const db    = await openDB();
  const table = await db.openTable(TABLE_NAME);

  let query = table.vectorSearch(queryVector).limit(topK);
  if (typeFilter) query = query.where(`type = '${typeFilter}'`);

  const results = await query.toArray();

  return results.map(r => ({
    id:       r.id,
    type:     r.type,
    text:     r.text,
    metadata: r.metadata,
    score:    r._distance,
  }));
}