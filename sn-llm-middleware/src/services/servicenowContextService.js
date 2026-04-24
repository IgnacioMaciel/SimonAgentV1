import NodeCache from 'node-cache';
import { logger } from '../utils/logger.js';

const cache = new NodeCache();

function snHeaders() {
  const credentials = Buffer.from(`${process.env.SN_USER}:${process.env.SN_PASSWORD}`).toString('base64');
  return {
    Authorization: `Basic ${credentials}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

async function snGet(path, params = {}) {
  const url = new URL(`${process.env.SN_INSTANCE}/api/now${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { method: 'GET', headers: snHeaders(), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`ServiceNow API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.result;
}

async function fetchKBArticles() {
  logger.info('[SN] Fetching KB articles...');
  const records = await snGet('/table/kb_knowledge', {
    sysparm_query: 'workflow_state=published^active=true',
    sysparm_fields: 'number,short_description,text,kb_category,sys_id',
    sysparm_limit: '100',
    sysparm_display_value: 'true',
  });
  return records.map((r) => ({
    number: r.number,
    title: r.short_description,
    category: r.kb_category?.display_value ?? 'General',
    summary: (r.text ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500),
    sys_id: r.sys_id,
  }));
}

async function fetchIncidentTypes() {
  logger.info('[SN] Fetching incident categories...');
  const categories = await snGet('/table/sys_choice', {
    sysparm_query: 'name=incident^element=category^inactive=false',
    sysparm_fields: 'value,label',
    sysparm_limit: '50',
  });
  const subcategories = await snGet('/table/sys_choice', {
    sysparm_query: 'name=incident^element=subcategory^inactive=false',
    sysparm_fields: 'value,label,dependent_value',
    sysparm_limit: '200',
  });
  const subMap = {};
  for (const sub of subcategories) {
    const parent = sub.dependent_value;
    if (!subMap[parent]) subMap[parent] = [];
    subMap[parent].push({ value: sub.value, label: sub.label });
  }
  return categories.map((cat) => ({
    value: cat.value,
    label: cat.label,
    subcategories: subMap[cat.value] ?? [],
  }));
}

async function fetchCatalogItems() {
  logger.info('[SN] Fetching catalog items...');
  const records = await snGet('/table/sc_cat_item', {
    sysparm_query: 'active=true^sys_class_name=sc_cat_item',
    sysparm_fields: 'name,short_description,category,sys_id',
    sysparm_limit: '100',
    sysparm_display_value: 'true',
  });
  return records.map((r) => ({
    name: r.name,
    description: r.short_description,
    category: r.category?.display_value ?? 'General',
    sys_id: r.sys_id,
  }));
}

export async function getServiceNowContext() {
  const ttlKB = parseInt(process.env.CACHE_TTL_KB ?? '3600');
  const ttlCatalog = parseInt(process.env.CACHE_TTL_CATALOG ?? '7200');
  const ttlIncident = parseInt(process.env.CACHE_TTL_INCIDENT_TYPES ?? '7200');

  let kbArticles = cache.get('kb_articles');
  if (!kbArticles) {
    kbArticles = await fetchKBArticles();
    cache.set('kb_articles', kbArticles, ttlKB);
    logger.info(`[Cache] KB articles loaded: ${kbArticles.length}`);
  }

  let incidentTypes = cache.get('incident_types');
  if (!incidentTypes) {
    incidentTypes = await fetchIncidentTypes();
    cache.set('incident_types', incidentTypes, ttlIncident);
    logger.info(`[Cache] Incident categories loaded: ${incidentTypes.length}`);
  }

  let catalogItems = cache.get('catalog_items');
  if (!catalogItems) {
    catalogItems = await fetchCatalogItems();
    cache.set('catalog_items', catalogItems, ttlCatalog);
    logger.info(`[Cache] Catalog items loaded: ${catalogItems.length}`);
  }
  return { kbArticles, incidentTypes, catalogItems };
}

export function invalidateContext() {
  cache.flushAll();
  logger.info('[Cache] ServiceNow context manually invalidated');
}