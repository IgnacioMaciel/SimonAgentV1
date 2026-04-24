import OpenAI from 'openai';
import { buildSystemPrompt } from '../prompts/systemPromptBuilder.js';
import { retrieveContext }   from './ragService.js';
import { logger }            from '../utils/logger.js';

const openai = new OpenAI({
  apiKey:  process.env.LLM_API_KEY  ?? 'ollama',
  baseURL: process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1',
});

const VALID_INTENTS = new Set([
  'create_incident',
  'create_ritm',
  'check_status',
  'search_kb',
  'greeting',
  'out_of_scope',
]);

const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD ?? '0.6');

function fallbackResponse(reason) {
  logger.warn(`[LLM] Using fallback. Reason: ${reason}`);
  return {
    intent: { name: 'out_of_scope', confidence: 0 },
    entities: [
      { name: 'bot_response', value: 'I was unable to process your request. Please try again or contact support directly.' },
      { name: 'needs_more_info', value: 'false' },
    ],
    _fallback: true,
    _fallback_reason: reason,
  };
}

function validateLLMResponse(parsed) {
  const errors = [];
  if (!parsed.intent)                        errors.push('missing intent');
  if (!VALID_INTENTS.has(parsed.intent))     errors.push(`invalid intent: ${parsed.intent}`);
  if (typeof parsed.confidence !== 'number') errors.push('confidence is not a number');
  if (!parsed.bot_response)                  errors.push('missing bot_response');
  if (!parsed.slots || typeof parsed.slots !== 'object') errors.push('missing slots');
  return errors;
}

function toServiceNowFormat(parsed) {
  const entities = [];
  if (parsed.slots.category)
    entities.push({ name: 'category',    value: parsed.slots.category });
  if (parsed.slots.subcategory)
    entities.push({ name: 'subcategory', value: parsed.slots.subcategory });
  if (parsed.slots.description)
    entities.push({ name: 'description', value: parsed.slots.description });
  if (parsed.slots.ticket_number)
    entities.push({ name: 'ticket_number', value: parsed.slots.ticket_number });
  if (parsed.slots.catalog_item_name)
    entities.push({ name: 'catalog_item_name', value: parsed.slots.catalog_item_name });
  if (parsed.slots.kb_articles_referenced?.length)
    entities.push({ name: 'kb_articles_referenced', value: parsed.slots.kb_articles_referenced.join(',') });

  entities.push({ name: 'bot_response',    value: parsed.bot_response });
  entities.push({ name: 'needs_more_info', value: String(parsed.needs_more_info) });

  return {
    intent:   { name: parsed.intent, confidence: parsed.confidence },
    entities,
    _raw: parsed,
  };
}

function extractJSON(raw) {
  try { return JSON.parse(raw); } catch { /* continue */ }

  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(cleaned); } catch { /* continue */ }

  const start = cleaned.indexOf('{');
  if (start === -1) return null;

  let depth = 0, inString = false, escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape)                  { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true;  continue; }
    if (ch === '"')              { inString = !inString; continue; }
    if (inString)                continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export async function classifyAndRespond(userMessage, history = []) {
  const startTime = Date.now();
  const model     = process.env.LLM_MODEL      ?? 'llama3.1:8b';
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS ?? '15000');

  // 1. RAG — recuperar solo los chunks relevantes para esta query
  const { contextText, sources } = await retrieveContext(userMessage);

  // 2. System prompt con el contexto recuperado
  const systemPrompt = buildSystemPrompt({ retrievedContext: contextText });

  // 3. Historial — SN usa role 'bot', Ollama espera 'assistant'
  const historyMessages = history.map((m) => ({
    role:    m.role === 'bot' ? 'assistant' : 'user',
    content: m.content,
  }));

  // 4. Llamada al LLM
  let llmRawResponse;
  try {
    const response = await Promise.race([
      openai.chat.completions.create({
        model,
        max_tokens:      800,
        temperature:     0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          ...historyMessages,
          { role: 'user',   content: userMessage  },
        ],
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('LLM_TIMEOUT')), timeoutMs)
      ),
    ]);
    llmRawResponse = response.choices[0].message.content;
  } catch (err) {
    if (err.message === 'LLM_TIMEOUT') {
      logger.error(`[LLM] Timeout exceeded (${timeoutMs}ms). Is Ollama running? → ollama serve`);
      return fallbackResponse('llm_timeout');
    }
    logger.error('[LLM] Error calling LLM:', err.message);
    return fallbackResponse('llm_api_error');
  }

  // 5. Parsear JSON
  const parsed = extractJSON(llmRawResponse);
  if (!parsed) {
    logger.error('[LLM] JSON extraction failed:', llmRawResponse.slice(0, 300));
    return fallbackResponse('json_parse_error');
  }

  // 6. Validar
  const errors = validateLLMResponse(parsed);
  if (errors.length > 0) {
    logger.error('[LLM] Validation errors:', errors);
    return fallbackResponse(`validation_failed: ${errors.join(', ')}`);
  }

  // 7. Threshold de confianza
  if (parsed.confidence < CONFIDENCE_THRESHOLD) {
    logger.warn(`[LLM] Low confidence (${parsed.confidence}) for intent "${parsed.intent}"`);
    parsed.intent       = 'low_confidence';
    parsed.bot_response = 'Could you give me more detail? I am not sure I fully understood your request.';
  }

  logger.info({
    event:                  'llm_classification',
    user_message:           userMessage,
    intent:                 parsed.intent,
    confidence:             parsed.confidence,
    latency_ms:             Date.now() - startTime,
    model,
    rag_sources:            sources,
    kb_articles_referenced: parsed.slots?.kb_articles_referenced ?? [],
  });

  return toServiceNowFormat(parsed);
}