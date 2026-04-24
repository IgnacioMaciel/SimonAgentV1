import { Router } from 'express';
import { classifyAndRespond }     from '../services/llmService.js';
import { buildIndex, indexExists } from '../services/indexerService.js';
import { invalidateContext }       from '../services/servicenowContextService.js';
import { logger }                  from '../utils/logger.js';

const router = Router();

function requireApiKey(req, res, next) {
  const key = req.headers['x-middleware-key'];
  if (!process.env.MIDDLEWARE_API_KEY || key === process.env.MIDDLEWARE_API_KEY) return next();
  logger.warn('[Auth] Request rejected — invalid API key');
  return res.status(401).json({ error: 'Unauthorized' });
}

router.post('/nlu/classify', requireApiKey, async (req, res) => {
  const { user_message, history = [], user_id, conversation_id, channel } = req.body;
  if (!user_message || typeof user_message !== 'string' || !user_message.trim())
    return res.status(400).json({ error: 'user_message is required' });

  const trimmedHistory = Array.isArray(history) ? history.slice(-10) : [];
  logger.info({ event: 'classify_request', user_id, conversation_id, channel, message_length: user_message.length });

  try {
    const result = await classifyAndRespond(user_message.trim(), trimmedHistory);
    return res.json(result);
  } catch (err) {
    logger.error('[Route] Unexpected error in /nlu/classify:', err);
    return res.status(500).json({
      error: 'Internal server error',
      intent: { name: 'out_of_scope', confidence: 0 },
      entities: [{ name: 'bot_response', value: 'An error occurred. Please try again.' }],
    });
  }
});

router.post('/admin/reindex', requireApiKey, async (req, res) => {
  logger.info('[Route] Reindex requested');
  try {
    invalidateContext();
    const result = await buildIndex();
    return res.json({ status: 'ok', ...result });
  } catch (err) {
    logger.error('[Route] Error during reindex:', err);
    return res.status(500).json({ error: 'Reindex failed', detail: err.message });
  }
});

router.get('/admin/index-status', requireApiKey, async (req, res) => {
  const exists = await indexExists();
  return res.json({ index_ready: exists });
});

router.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

export default router;