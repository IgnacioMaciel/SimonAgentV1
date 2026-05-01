// src/services/sessionService.js
//
// Maneja el historial de conversación por sesión.
// Cada session_id tiene su propio array de mensajes en RAM.
// El TTL se resetea en cada mensaje nuevo — si el usuario
// no escribe en SESSION_TTL_SECONDS, la sesión expira sola.

import NodeCache from 'node-cache';
import { randomUUID } from 'crypto';
import { logger }     from '../utils/logger.js';

const SESSION_TTL = parseInt(process.env.SESSION_TTL_SECONDS ?? '1800'); // 30 min default
const MAX_HISTORY = parseInt(process.env.SESSION_MAX_HISTORY ?? '20');   // máx 10 turnos

// useClones: false para que las mutaciones al array sean directas sin re-serializar
const store = new NodeCache({ useClones: false });

/**
 * Crea una nueva sesión y devuelve su ID.
 * @param {string} userId - sys_id del usuario de ServiceNow (opcional, para logging)
 * @returns {string} session_id
 */
export function createSession(userId = null) {
  const sessionId = randomUUID();
  store.set(sessionId, [], SESSION_TTL);
  logger.info({ event: 'session_created', session_id: sessionId, user_id: userId });
  return sessionId;
}

/**
 * Devuelve el historial de una sesión.
 * @param {string} sessionId
 * @returns {Array|null} null si la sesión no existe o expiró
 */
export function getHistory(sessionId) {
  return store.get(sessionId) ?? null;
}

/**
 * Agrega un turno al historial y resetea el TTL.
 * @param {string} sessionId
 * @param {string} userMessage   - Mensaje del usuario
 * @param {string} botResponse   - Respuesta del bot
 */
export function appendTurn(sessionId, userMessage, botResponse) {
  const history = store.get(sessionId);
  if (history === undefined) {
    logger.warn(`[Session] appendTurn called on expired/unknown session: ${sessionId}`);
    return;
  }

  history.push({ role: 'user',      content: userMessage });
  history.push({ role: 'assistant', content: botResponse });

  // Mantener solo los últimos MAX_HISTORY mensajes (sliding window)
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  // Resetear el TTL con cada mensaje nuevo
  store.set(sessionId, history, SESSION_TTL);

  logger.info({
    event:      'session_turn_appended',
    session_id: sessionId,
    turn_count: history.length / 2,
  });
}

/**
 * Elimina una sesión explícitamente (fin de conversación).
 * @param {string} sessionId
 */
export function endSession(sessionId) {
  const existed = store.del(sessionId);
  logger.info({ event: 'session_ended', session_id: sessionId, existed: existed > 0 });
  return existed > 0;
}

/**
 * Devuelve stats del store (útil para el endpoint /health).
 */
export function getSessionStats() {
  return {
    active_sessions: store.keys().length,
    ttl_seconds:     SESSION_TTL,
    max_history:     MAX_HISTORY,
  };
}