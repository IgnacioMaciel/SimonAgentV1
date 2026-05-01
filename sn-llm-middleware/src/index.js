import 'dotenv/config';
import express from 'express';
import router  from './routes/index.js';
import { buildIndex, indexExists } from './services/indexerService.js';
import { logger } from './utils/logger.js';

const app  = express();
const PORT = parseInt(process.env.PORT ?? '3000');

app.use(express.json({ limit: '256kb' }));
app.use((req, _res, next) => { logger.info(`${req.method} ${req.path}`); next(); });
app.use('/', router);
app.use((req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.path}` }));
app.use((err, _req, res, _next) => { logger.error('Unhandled error:', err); res.status(500).json({ error: 'Internal server error' }); });

async function start() {
  const required = ['LLM_BASE_URL', 'SN_INSTANCE', 'SN_USER', 'SN_PASSWORD'];
  const missing  = required.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    logger.error(`Missing env variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  logger.info(`LLM → ${process.env.LLM_BASE_URL} | model: ${process.env.LLM_MODEL ?? 'llama3.1:8b'}`);
  logger.info(`Embedding model → ${process.env.EMBEDDING_MODEL ?? 'nomic-embed-text'}`);
  logger.info(`Session TTL → ${process.env.SESSION_TTL_SECONDS ?? '1800'}s | Max history → ${process.env.SESSION_MAX_HISTORY ?? '20'} messages`);

  const ready = await indexExists().catch(() => false);
  if (!ready) {
    logger.info('[RAG] Vector index not found — building from ServiceNow...');
    try {
      const result = await buildIndex();
      logger.info(`[RAG] Index built: ${result.indexed} chunks indexed`);
    } catch (err) {
      logger.error('[RAG] Failed to build index on startup: ' + err.message + ' | ' + err.stack);
      logger.warn('[RAG] Middleware will start but RAG may not work. Use POST /admin/reindex to retry.');
    }
  } else {
    logger.info('[RAG] Vector index found — ready to serve');
  }

  app.listen(PORT, () => {
    logger.info(`Middleware listening on http://0.0.0.0:${PORT}`);
    logger.info('Endpoints: POST /conversation/start | POST /conversation/end | POST /nlu/classify | POST /admin/reindex | GET /health');
  });
}

start();