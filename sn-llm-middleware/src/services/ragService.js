import { embedText }   from './embeddingService.js';
import { searchIndex } from './indexerService.js';
import { logger }      from '../utils/logger.js';

const TOP_K     = parseInt(process.env.RAG_TOP_K      ?? '5');
const MIN_SCORE = parseFloat(process.env.RAG_MIN_SCORE ?? '0.7');

export async function retrieveContext(userMessage) {
  const startTime = Date.now();

  let queryVector;
  try {
    queryVector = await embedText(userMessage);
  } catch (err) {
    logger.error('[RAG] Error generating query embedding:', err.message);
    return { contextText: '(context unavailable)', sources: [] };
  }

  let results = [];
  try {
    results = await searchIndex(queryVector, TOP_K + 3);
  } catch (err) {
    logger.error('[RAG] Error searching index:', err.message);
    return { contextText: '(context unavailable)', sources: [] };
  }

  const relevant = results.filter(r => r.score <= MIN_SCORE).slice(0, TOP_K);

  // Always include at least one incident_category chunk for classification
  const hasIncidentCat = relevant.some(r => r.type === 'incident_category');
  if (!hasIncidentCat) {
    try {
      const incidentChunks = await searchIndex(queryVector, 3, 'incident_category');
      if (incidentChunks.length > 0) relevant.push(incidentChunks[0]);
    } catch { /* non-critical */ }
  }

  logger.info({
    event:            'rag_retrieval',
    user_message:     userMessage.slice(0, 80),
    results_total:    results.length,
    results_relevant: relevant.length,
    top_scores:       relevant.slice(0, 3).map(r => r.score.toFixed(3)),
    latency_ms:       Date.now() - startTime,
  });

  if (relevant.length === 0) {
    logger.warn('[RAG] No relevant chunks found for query.');
    return { contextText: 'No relevant content found in the knowledge base for this query.', sources: [] };
  }

  const contextText = relevant
    .map((chunk, i) => `--- RELEVANT CONTENT ${i + 1} (relevance: ${(1 - chunk.score).toFixed(2)}) ---\n${chunk.text}`)
    .join('\n\n');

  const sources = relevant.map(r => ({ id: r.id, type: r.type, score: r.score }));

  return { contextText, sources };
}