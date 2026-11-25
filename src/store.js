/* 业务层：导入、建卡、复习、统计、导入导出、可选 AI 挖空 */

import { splitBlocks, pickBlanks, gradeAnswer } from './core.js';
import { fsrs, createEmptyCard, generatorParameters, Rating } from '../vendor/ts-fsrs.js';
import * as db from './db.js';

export const DEFAULT_SETTINGS = {
  density: 0.28,
  maxBlanks: 5,
  retain: 0.9,
  terms: '',
  server: { url: '', token: '' },
  ai: { endpoint: '', key: '', model: 'deepseek-chat', enabled: false },
  ima: { enabled: false },
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const DAY = 86400000;

/* ---------- 设置 ---------- */
let _settings = null;
export async function getSettings() {
  if (_settings) return _settings;
  const row = await db.get('kv', 'settings');
  const v = row?.v || {};
  _settings = { ...DEFAULT_SETTINGS, ...v, server: { ...DEFAULT_SETTINGS.server, ...(v.server || {}) }, ai: { ...DEFAULT_SETTINGS.ai, ...(v.ai || {}) }, ima: { ...DEFAULT_SETTINGS.ima, ...(v.ima || {}) } };
  return _settings;
}
export async function saveSettings(patch) {
  const cur = await getSettings();
  _settings = { ...cur, ...patch, server: { ...cur.server, ...(patch.server || {}) }, ai: { ...cur.ai, ...(patch.ai || {}) }, ima: { ...cur.ima, ...(patch.ima || {}) } };
  await db.put('kv', { k: 'settings', v: _settings });
  _sched = null;
  return _settings;
}

/* ---------- FSRS ---------- */
let _sched = null;
let _schedKey = '';
async function scheduler() {
  const s = await getSettings();
  const key = String(s.retain);
  if (_sched && _schedKey === key) return _sched;
  _sched = fsrs(generatorParameters({ request_retention: s.retain, enable_fuzz: true }));
  _schedKey = key;
  return _sched;
}
const revive = (o) => {
  if (!o) return null;
  const c = { ...o };
  for (const k of ['due', 'last_review']) if (c[k]) c[k] = new Date(c[k]);
  return c;
};
const freeze = (c) => {
  const o = { ...c };
  for (const k of ['due', 'last_review']) if (o[k] instanceof Date) o[k] = o[k].toISOString();
  return o;
};
export const dueOf = (card) => (card.srs?.due ? new Date(card.srs.due).getTime() : 0);

/* ---------- 导入 ---------- */
export async function importDoc({ title, raw, source = 'paste' }) {
  const s = await getSettings();
  const terms = s.terms.split(/[\n,，、;；]/).map((x) => x.trim()).filter(Boolean);
  const blocks = splitBlocks(raw);
  if (!blocks.length) return { doc: null, blocks: 0, cards: 0 };
  const docId = uid();
  const now = Date.now();
  const cards = blocks.map((b) => ({
    id: uid(),
    docId,
    title: b.title || title || '',
    text: b.text,
    blanks: pickBlanks(b.text, { density: s.density, maxBlanks: s.maxBlanks, terms }),
    srs: null,
    createdAt: now,
  }));
  const doc = { id: docId, title: title || blocks[0].title || '未命名', source, raw, createdAt: now, count: cards.length };
  await db.writeMany([
    { store: 'docs', val: doc },
    ...cards.map((c) => ({ store: 'cards', val: c })),
  ]);
  return { doc, blocks: blocks.length, cards: cards.length };
}

export async function reblankDoc(docId) {
  const s = await getSettings();
  const terms = s.terms.split(/[\n,，、;；]/).map((x) => x.trim()).filter(Boolean);
  const cards = await db.all('cards');
  const mine = cards.filter((c) => c.docId === docId);
  const next = mine.map((c) => ({ ...c, blanks: pickBlanks(c.text, { density: s.density, maxBlanks: s.maxBlanks, terms }) }));
  await db.writeMany(next.map((c) => ({ store: 'cards', val: c })));
  return next.length;
}

export async function deleteDoc(docId) {
  const cards = await db.all('cards');
  for (const c of cards.filter((x) => x.docId === docId)) await db.del('cards', c.id);
  await db.del('docs', docId);
}

export async function listDocs() {
  const docs = await db.all('docs');
  const cards = await db.all('cards');
  const now = Date.now();
  return docs
    .map((d) => {
      const mine = cards.filter((c) => c.docId === d.id);
      return { ...d, total: mine.length, due: mine.filter((c) => dueOf(c) <= now).length };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/* ---------- 复习 ---------- */
export async function dueQueue(limit = 40) {
  const cards = await db.all('cards');
  const now = Date.now();
  const due = cards.filter((c) => dueOf(c) <= now);
  due.sort((a, b) => {
    const an = a.srs ? 1 : 0, bn = b.srs ? 1 : 0;
    if (an !== bn) return an - bn;          // 新卡优先
    return dueOf(a) - dueOf(b);
  });
  return due.slice(0, limit);
}

export async function review(card, grade, input = '', synonyms = []) {
  const sched = await scheduler();
  const now = new Date();
  const prev = revive(card.srs) || createEmptyCard(now);
  const rec = sched.next(prev, now, grade);
  const updated = { ...card, srs: freeze(rec.card) };
  await db.writeMany([
    { store: 'cards', val: updated },
    { store: 'logs', val: { id: uid(), cardId: card.id, at: Date.now(), grade, input, prevDue: card.srs?.due || null } },
  ]);
  return updated;
}

export function check(input, blank, synonyms = []) {
  return gradeAnswer(input, blank, synonyms);
}

/** 预览"会了"的下次复习时间 */
export async function previewNext(card) {
  const sched = await scheduler();
  const now = new Date();
  const prev = revive(card.srs) || createEmptyCard(now);
  return sched.next(prev, now, Rating.Good).card.due.toISOString();
}

/* ---------- 统计 ---------- */
export async function stats() {
  const cards = await db.all('cards');
  const logs = await db.all('logs');
  const now = Date.now();
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const today = logs.filter((l) => l.at >= t0.getTime());
  const recent = logs.slice(-300);
  const acc = recent.length ? recent.filter((l) => l.grade >= 2).length / recent.length : 0;

  const days = new Set(logs.map((l) => new Date(l.at).toLocaleDateString('sv')));
  let streak = 0;
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (!days.has(d.toLocaleDateString('sv'))) d.setDate(d.getDate() - 1);
  while (days.has(d.toLocaleDateString('sv'))) { streak++; d.setDate(d.getDate() - 1); }

  const forecast = Array.from({ length: 7 }, (_, i) => {
    const a = new Date(); a.setHours(0, 0, 0, 0); a.setDate(a.getDate() + i);
    const b = new Date(a.getTime() + DAY);
    return { day: i, n: cards.filter((c) => { const t = dueOf(c); return t >= a.getTime() && t < b.getTime(); }).length };
  });
  const weak = cards.filter((c) => (c.srs?.lapses || 0) > 0).sort((a, b) => b.srs.lapses - a.srs.lapses).slice(0, 5);

  return {
    total: cards.length,
    due: cards.filter((c) => dueOf(c) <= now).length,
    todayReviews: today.length,
    todayCorrect: today.filter((l) => l.grade >= 2).length,
    reviews: logs.length,
    acc,
    streak,
    forecast,
    weak,
    newCards: cards.filter((c) => !c.srs).length,
  };
}

/* ---------- 备份 ---------- */
export async function exportAll() {
  const payload = {
    app: 'judou', version: 1, exportedAt: new Date().toISOString(),
    settings: await getSettings(),
    docs: await db.all('docs'),
    cards: await db.all('cards'),
    logs: await db.all('logs'),
  };
  return payload;
}

export async function importAll(payload) {
  if (!payload || payload.app !== 'judou') throw new Error('不是句读的备份文件');
  const ops = [];
  for (const d of payload.docs || []) ops.push({ store: 'docs', val: d });
  for (const c of payload.cards || []) ops.push({ store: 'cards', val: c });
  for (const l of payload.logs || []) ops.push({ store: 'logs', val: l });
  await db.writeMany(ops);
  if (payload.settings) await saveSettings(payload.settings);
  return { docs: (payload.docs || []).length, cards: (payload.cards || []).length, logs: (payload.logs || []).length };
}

export async function wipe() {
  await db.clear('docs');
  await db.clear('cards');
  await db.clear('logs');
}

/* ---------- 中转服务（AI + ima 共用） ---------- */
const serverBase = (s) => (s.server?.url || '').trim().replace(/\/+$/, '');

function serverHeaders(s, extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (s.server?.token) h['x-judou-token'] = s.server.token;
  return h;
}

async function serverCall(path, body, { raw = false, timeout = 60000 } = {}) {
  const s = await getSettings();
  const base = serverBase(s);
  if (!base) throw new Error('还没填中转服务地址（设置 → 中转服务）');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let r;
  try {
    r = await fetch(base + path, { method: 'POST', headers: serverHeaders(s), body: JSON.stringify(body || {}), signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? '请求超时（' + Math.round(timeout / 1000) + 's）' : '连不上中转服务：检查地址是否正确、是否已部署');
  }
  clearTimeout(timer);
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try {
      const j = await r.json();
      msg = j.msg || j.error || msg;
    } catch { try { const t = (await r.text()).slice(0, 160); if (t) msg = t; } catch {} }
    throw new Error(msg);
  }
  if (raw) return r;
  try { return await r.json(); } catch { throw new Error('中转服务返回的不是 JSON'); }
}

export async function pingServer() {
  const s = await getSettings();
  const base = serverBase(s);
  if (!base) throw new Error('还没填中转服务地址');
  const r = await serverCall('/ping', {});
  return r;
}

/* ---------- ima 知识库 ---------- */
const pickId = (x) => x.folder_id || x.id || x.media_id || x.kb_id || '';
const pickName = (x) => x.title || x.name || x.folder_name || '(未命名)';

export async function imaListKb(query = '') {
  const d = await serverCall('/ima/kb', { query, cursor: '', limit: 20 });
  const list = (d.info_list || d.list || []).map((x) => ({ id: pickId(x), name: pickName(x), desc: x.description || '' }));
  return { list: list.filter((x) => x.id), isEnd: !!d.is_end, cursor: d.next_cursor || '' };
}

export async function imaFolder(kb, folder = '') {
  const d = await serverCall('/ima/list', { kb, folder, cursor: '', limit: 50 });
  const items = (d.knowledge_list || []).map((x) => {
    const isFolder = x.is_folder === true || x.type === 'folder' || x.is_dir === true || (!x.media_id && !!pickId(x));
    return { id: pickId(x), name: pickName(x), isFolder, mediaId: x.media_id || '', raw: x };
  });
  return { items: items.filter((x) => x.id), path: d.current_path || [], isEnd: !!d.is_end, cursor: d.next_cursor || '' };
}

export async function imaSearch(kb, query) {
  const d = await serverCall('/ima/search', { kb, query, cursor: '' });
  return (d.info_list || []).map((x) => ({ mediaId: x.media_id || '', name: pickName(x), hint: x.highlight_content || '' })).filter((x) => x.mediaId);
}

export async function imaFetchFile(mediaId, title = '') {
  const r = await serverCall('/ima/file', { media_id: mediaId, title }, { raw: true, timeout: 180000 });
  const buffer = new Uint8Array(await r.arrayBuffer());
  let name = r.headers.get('x-filename') || '';
  if (!name) {
    const dispo = r.headers.get('content-disposition') || '';
    const m = dispo.match(/filename\*?=(?:UTF-8'')?([^;]+)/i);
    if (m) { try { name = decodeURIComponent(m[1].replace(/["']/g, '')); } catch { name = m[1]; } }
  }
  return { buffer, name: name || title || 'ima-文件' };
}

/* ---------- AI 挖空 ---------- */
const AI_SYS = `你是中文背诵材料的关键词标注器。任务：从给定句子中挑出最值得挖空记忆的词或短语。
硬性要求：
1. 只能输出 JSON 数组，不要任何解释、不要 markdown 代码块。
2. 每个元素形如 {"quote":"原文中逐字出现的连续片段","reason":"为什么值得挖"}
3. quote 必须能在原文中一字不差地找到，长度 2-12 字；不得改写、不得补全、不得拼接。
4. 优先挖：专业术语、概念名、数量、分类词、因果链上的关键名词。禁止挖：助词、连词、语气词、代词。
5. 最多返回 6 个。`;

/** 有中转服务就走中转（Key 在服务端）；否则退回直连配置 */
export async function aiTarget() {
  const s = await getSettings();
  if (serverBase(s)) {
    return { url: serverBase(s) + '/ai', headers: serverHeaders(s), model: s.ai.model || 'deepseek-chat', via: 'server' };
  }
  if (s.ai.endpoint && s.ai.key) {
    return { url: s.ai.endpoint, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.ai.key }, model: s.ai.model, via: 'direct' };
  }
  throw new Error('未配置 AI：在设置里填中转服务地址（推荐），或填接口地址 + Key');
}

function parseQuotes(text, content) {
  const m = String(content).match(/\[[\s\S]*\]/);
  if (!m) throw new Error('模型没返回 JSON 数组');
  let arr;
  try { arr = JSON.parse(m[0]); } catch { throw new Error('JSON 解析失败'); }
  const out = [];
  for (const item of arr) {
    const q = String(item?.quote || item?.word || '').trim();
    if (q.length < 2 || q.length > 14) continue;
    const at = text.indexOf(q);
    if (at < 0) continue;
    if (out.some((b) => !(at + q.length <= b.start || at >= b.end))) continue;
    out.push({ start: at, end: at + q.length, answer: q });
  }
  return out.sort((a, b) => a.start - b.start);
}

export async function aiBlanks(text, cfg) {
  const t = await aiTarget();
  const r = await fetch(t.url, {
    method: 'POST',
    headers: t.headers,
    body: JSON.stringify({
      model: cfg?.model || t.model,
      temperature: 0.2,
      messages: [{ role: 'system', content: AI_SYS }, { role: 'user', content: text }],
    }),
  });
  if (!r.ok) {
    let msg = 'API ' + r.status;
    try { const j = await r.json(); msg = j.msg || j.error?.message || j.error || msg; } catch {}
    throw new Error(msg);
  }
  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content || j?.content || '';
  return parseQuotes(text, content);
}
