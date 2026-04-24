import { logger } from '../utils/logger.js';

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'nomic-embed-text';
const OLLAMA_BASE     = (process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1')
                          .replace('/v1', '');

export async function embedText(text) {
  const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: EMBEDDING_MODEL, input: text }),    
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    throw new Error(`Ollama embed error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const vector = data.embeddings?.[0] ?? data.embedding;

  if (!vector || !Array.isArray(vector)) {
    throw new Error('Unexpected embeddings response: ' + JSON.stringify(data).slice(0, 200));
  }

  return vector;
}

export async function embedBatch(texts, batchSize = 20) {
  const results = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    logger.info(`[Embed] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)} (${batch.length} texts)`);
    const vectors = await Promise.all(batch.map(embedText));
    results.push(...vectors);
  }

  return results;
}