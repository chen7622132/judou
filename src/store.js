/* 业务层：导入、建卡、复习、统计、导入导出、可选 AI 挖空 */

import { splitBlocks, pickBlanks, gradeAnswer } from './core.js';
import { fsrs, createEmptyCard, generatorParameters, Rating } from '../vendor/ts-fsrs.js';
import * as db from './db.js';

export const DEFAULT_SETTINGS = {
  density: 0.28,
  maxBlanks: 5,
  retain: 0.9,
  terms: '',
  ai: { endpoint: 'https://api.deepseek.com/v1/chat/completions', key: '', model: 'deepseek-chat', enabled: false },
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const DAY = 86400000;

/* ---------- 设置 ---------- */
let _settings = null;
export async function getSettings() {
  if (_settings) return _settings;
  const row = await db.get('kv', 'settings');
  _settings = { ...DEFAULT_SETTINGS, ...(row?.v || {}), ai: { ...DEFAULT_SETTINGS.ai, ...(row?.v?.ai || {}) } };
  return _settings;
}
export async function saveSettings(patch) {
  const cur = await getSettings();
  _settings = { ...cur, ...patch, ai: { ...cur.ai, ...(patch.ai || {}) } };
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

/* ---------- 可选：AI 挖空 ---------- */
const AI_SYS = `你是中文背诵材料的关键词标注器。任务：从给定句子中挑出最值得挖空记忆的词或短语。
硬性要求：
1. 只能输出 JSON 数组，不要任何解释、不要 markdown 代码块。
2. 每个元素形如 {"quote":"原文中逐字出现的连续片段","reason":"为什么值得挖"}
3. quote 必须能在原文中一字不差地找到，长度 2-12 字；不得改写、不得补全、不得拼接。
4. 优先挖：专业术语、概念名、数量、分类词、因果链上的关键名词。禁止挖：助词、连词、语气词、代词。
5. 最多返回 6 个。`;

export async function aiBlanks(text, cfg) {
  if (!cfg?.endpoint || !cfg?.key) throw new Error('未配置 AI');
  const r = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      messages: [{ role: 'system', content: AI_SYS }, { role: 'user', content: text }],
    }),
  });
  if (!r.ok) throw new Error('API ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content || '';
  const m = content.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('模型没返回 JSON 数组');
  let arr;
  try { arr = JSON.parse(m[0]); } catch { throw new Error('JSON 解析失败'); }
  const out = [];
  for (const item of arr) {
    const q = (item?.quote || '').trim();
    if (q.length < 2 || q.length > 14) continue;
    const at = text.indexOf(q);
    if (at < 0) continue;                                  // 定位失败直接丢弃：绝不让模型改原文
    if (out.some((b) => !(at + q.length <= b.start || at >= b.end))) continue;
    out.push({ start: at, end: at + q.length, answer: q });
  }
  return out.sort((a, b) => a.start - b.start);
}
