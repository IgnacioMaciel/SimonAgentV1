import { Router } from 'express';
import { classifyAndRespond }      from '../services/llmService.js';
import { buildIndex, indexExists } from '../services/indexerService.js';
import { invalidateContext }       from '../services/servicenowContextService.js';
import {
  createSession,
  getHistory,
  appendTurn,
  endSession,
  getSessionStats,
} from '../services/sessionService.js';
import { logger } from '../utils/logger.js';

const router = Router();

function requireApiKey(req, res, next) {
  const key = req.headers['x-middleware-key'];
  if (!process.env.MIDDLEWARE_API_KEY || key === process.env.MIDDLEWARE_API_KEY) return next();
  logger.warn('[Auth] Request rejected — invalid API key');
  return res.status(401).json({ error: 'Unauthorized' });
}

// ── POST /conversation/start ─────────────────────────────────────────────────
// Crea una nueva sesión. ServiceNow lo llama al inicio de cada conversación
// del Virtual Agent y guarda el session_id como variable del topic.
//
// Body: { "user_id": "sys_id_opcional" }
// Response: { "session_id": "uuid" }

router.post('/conversation/start', requireApiKey, (req, res) => {
  const { user_id } = req.body ?? {};
  const sessionId   = createSession(user_id);
  return res.json({ session_id: sessionId });
});

// ── POST /conversation/end ───────────────────────────────────────────────────
// Elimina la sesión explícitamente. Llamarlo desde el Topic Flow de cierre
// del VA (cuando el usuario dice "goodbye", resuelve el ticket, etc.)
//
// Body: { "session_id": "uuid" }

router.post('/conversation/end', requireApiKey, (req, res) => {
  const { session_id } = req.body ?? {};
  if (!session_id) return res.status(400).json({ error: 'session_id is required' });
  const ended = endSession(session_id);
  return res.json({ ended, session_id });
});

// ── POST /nlu/classify ───────────────────────────────────────────────────────
// Webhook principal para el NLU Profile de ServiceNow.
// Ahora lee y escribe el historial desde el session store.
//
// Body:
// {
//   "user_message": "my outlook won't open",
//   "session_id": "uuid-de-la-sesion",   ← nuevo campo
//   "user_id": "sys_id_opcional",
//   "conversation_id": "sn_conv_id"
// }

router.post('/nlu/classify', requireApiKey, async (req, res) => {
  const { user_message, session_id, user_id, conversation_id } = req.body ?? {};

  if (!user_message || typeof user_message !== 'string' || !user_message.trim())
    return res.status(400).json({ error: 'user_message is required' });

  // Recuperar historial de la sesión
  // Si no hay session_id o la sesión expiró, continuar sin historial
  let history = [];
  if (session_id) {
    const stored = getHistory(session_id);
    if (stored === null) {
      logger.warn(`[Session] session_id ${session_id} not found or expired — continuing without history`);
    } else {
      history = stored;
    }
  }

  logger.info({
    event:           'classify_request',
    session_id,
    user_id,
    conversation_id,
    message_length:  user_message.length,
    history_turns:   history.length / 2,
  });

  try {
    const result = await classifyAndRespond(user_message.trim(), history);

    // Guardar el turno en la sesión si existe
    if (session_id && getHistory(session_id) !== null) {
      const botResponse = result.entities?.find(e => e.name === 'bot_response')?.value ?? '';
      appendTurn(session_id, user_message.trim(), botResponse);
    }

    return res.json(result);
  } catch (err) {
    logger.error('[Route] Unexpected error in /nlu/classify:', err);
    return res.status(500).json({
      error:   'Internal server error',
      intent:  { name: 'out_of_scope', confidence: 0 },
      entities: [{ name: 'bot_response', value: 'An error occurred. Please try again.' }],
    });
  }
});

// ── POST /admin/reindex ──────────────────────────────────────────────────────

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

// ── GET /admin/index-status ──────────────────────────────────────────────────

router.get('/admin/index-status', requireApiKey, async (req, res) => {
  const exists = await indexExists();
  return res.json({ index_ready: exists });
});

// ── GET /health ──────────────────────────────────────────────────────────────

router.get('/health', (_, res) => {
  return res.json({
    status: 'ok',
    ts:     new Date().toISOString(),
    sessions: getSessionStats(),
  });
});

// GET /admin/inspect-index — ver los primeros 5 chunks indexados
router.get('/admin/inspect-index', requireApiKey, async (req, res) => {
  try {
    const lancedb = await import('@lancedb/lancedb');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const DB_PATH   = path.resolve(__dirname, '../../data/vectors');

    const db    = await lancedb.connect(DB_PATH);
    const table = await db.openTable('sn_content');
    const rows  = await table.query().limit(10).toArray();

    return res.json({
      total: await table.countRows(),
      sample: rows.map(r => ({
        id:   r.id,
        type: r.type,
        text: r.text.slice(0, 300), // primeros 300 chars
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /admin/test-rag — ver qué chunks recupera para una query
router.post('/admin/test-rag', requireApiKey, async (req, res) => {
  const { query } = req.body ?? {};
  if (!query) return res.status(400).json({ error: 'query is required' });

  const { retrieveContext } = await import('../services/ragService.js');
  const { contextText, sources } = await retrieveContext(query);

  return res.json({ sources, contextText });
});

export default router;