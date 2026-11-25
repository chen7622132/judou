/* 句读 core —— 纯逻辑，无 DOM，可在 node 里单测 */

/* ========== 1. 归一化与判分 ========== */

const PUNCT = /[，。！？；：、“”‘’（）《》〈〉【】〔〕…—·,\.!\?;:"'’‘()\[\]{}<>\/\\_=+*&^%$#@~`|]/g;

export function normalize(s = '') {
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(PUNCT, '');
}

export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

export function tolerate(len) {
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  return 2;
}

/** 返回 {correct, rating(1-3), distance}，3=会了 2=模糊 1=忘了 */
export function gradeAnswer(input, answer, synonyms = []) {
  const a = normalize(answer);
  let b = normalize(input);
  if (!b) return { correct: false, rating: 1, distance: a.length };
  const pool = [a, ...synonyms.map(normalize)];
  let best = 99;
  for (const p of pool) best = Math.min(best, editDistance(b, p));
  const t = tolerate(Math.min(...pool.map((p) => p.length)));
  if (best === 0) return { correct: true, rating: 3, distance: 0 };
  if (best <= t && t > 0) return { correct: true, rating: 2, distance: best };
  return { correct: false, rating: 1, distance: best };
}

/* ========== 2. 分块 ========== */

const SENT_END = /(?<=[。！？；!?;])|\n/;
const SOFT_END = /(?<=[，、,])/;

function splitLong(s, max = 110) {
  if (s.length <= max) return [s];
  const parts = s.split(SOFT_END);
  const out = [];
  let buf = '';
  for (const p of parts) {
    if (buf.length + p.length > max && buf) { out.push(buf); buf = p; }
    else buf += p;
  }
  if (buf) out.push(buf);
  return out;
}

/** 原文 → [{title, text}]，一句一块 */
export function splitBlocks(raw) {
  const text = String(raw).replace(/\r/g, '');
  const paras = text.split(/\n{2,}|\n(?=#{1,6}\s)/);
  const out = [];
  let currentTitle = '';
  for (let para of paras) {
    para = para.trim();
    if (!para) continue;
    const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
    let body = lines;
    const h = para.match(/^#{1,6}\s+(.+)$/);
    if (h) {
      currentTitle = h[1].trim();
      body = para.replace(/^#{1,6}\s+.+$/m, '').split('\n').map((l) => l.trim()).filter(Boolean);
    } else if (lines.length > 1 && lines[0].length <= 30 && !/[。！？；，]/.test(lines[0]) && /[\u4e00-\u9fa5A-Za-z]/.test(lines[0])) {
      currentTitle = lines[0];
      body = lines.slice(1);
    } else if (lines.length === 1 && lines[0].length <= 24 && !/[。！？；，]/.test(lines[0]) && /[\u4e00-\u9fa5A-Za-z]/.test(lines[0])) {
      currentTitle = lines[0];
      continue;
    }
    const joined = body.join('\n');
    const sents = joined.split(SENT_END).map((s) => s.trim()).filter(Boolean);
    for (const s of sents) {
      for (const piece of splitLong(s)) {
        const t = piece.trim();
        if (t.length < 6) continue;
        out.push({ title: currentTitle, text: t });
      }
    }
  }
  return out;
}

/* ========== 3. 分词与挖空 ========== */

const STOP = new Set(
  ('的 地 得 了 着 过 是 和 与 在 对 为 把 被 而 也 都 就 又 很 更 最 不 没 会 能 要 可 这 那 其 之 所 以 及 等 有 无 人 上 下 中 个 们 他 她 它 我 你 您 自己 进行 具有 包括 属于 成为 通过 根据 由于 因此 但是 如果 虽然 已经 可以 需要 应该 一个 一种 一些 这样 那样 其中 以及 并且 或者 而是 就是 不是 没有 什么 怎么 如何 时候 因为 所以 方面 情况 问题 重要 主要 基本 一定 非常 十分 比较 更加' +
    ' the a an of to in on for and or is are was were be been being this that these those it its as at by with from')
    .split(/\s+/)
    .filter(Boolean)
);

const DEFAULT_TERMS = [];

let _seg = null;
function segmenter() {
  if (_seg !== null) return _seg;
  try {
    _seg = new Intl.Segmenter('zh-Hans', { granularity: 'word' });
  } catch (e) {
    _seg = false;
  }
  return _seg;
}

export function segmentWords(text) {
  const seg = segmenter();
  const out = [];
  if (seg) {
    for (const s of seg.segment(text)) {
      if (s.isWordLike) out.push({ w: s.segment, start: s.index, end: s.index + s.segment.length });
    }
    return out;
  }
  // 兜底：2/3/4 字滑窗 + 停用词
  const cjk = /[\u4e00-\u9fa5]/;
  for (let i = 0; i < text.length; i++) {
    for (const L of [4, 3, 2]) {
      const w = text.slice(i, i + L);
      if (w.length === L && [...w].every((c) => cjk.test(c)) && !STOP.has(w)) {
        out.push({ w, start: i, end: i + L });
        break;
      }
    }
  }
  return out;
}

const WEAK_EDGE = /^(的|地|得|了|着|过|是|和|与|在|对|为|把|被|而|也|都|就|又|很|更|最|不|没|会|能|要|可|这|那|其|之|所)|(的|了|着|过|们|等|者)$/;
const HAS_DIGIT = /[0-9A-Za-z%‰]/;

function scoreWord(w, isTerm) {
  if (STOP.has(w)) return -99;
  const n = [...w].length;
  const cjk = /[\u4e00-\u9fa5]/.test(w);
  if (!cjk && !HAS_DIGIT.test(w)) return -99;
  if (n === 1) {
    if (HAS_DIGIT.test(w)) return 1.2;
    return isTerm ? 1.6 : -1;
  }
  let s = n === 2 ? 1 : n <= 4 ? 2 : 1.5;
  if (HAS_DIGIT.test(w)) s += 1.6;
  if (isTerm) s += 3;
  if (WEAK_EDGE.test(w)) s -= 1.2;
  return s;
}

/**
 * 挖空：返回 [{start,end,answer}]
 * density: 目标挖空字数占比；maxBlanks: 单句上限；terms: 术语表（命中加权）
 */
export function pickBlanks(text, { density = 0.28, maxBlanks = 5, terms = DEFAULT_TERMS } = {}) {
  const termList = [...new Set(terms.map((t) => String(t).trim()).filter((t) => t.length >= 2 && t.length <= 12))]
    .sort((a, b) => b.length - a.length);
  const picked = [];

  // ① 术语表优先：整词命中就直接挖整个术语（不受分词边界影响）
  for (const term of termList) {
    let from = 0;
    while (picked.length < maxBlanks) {
      const at = text.indexOf(term, from);
      if (at < 0) break;
      from = at + term.length;
      if (picked.some((p) => !(at + term.length <= p.start || at >= p.end))) break;
      if (picked.some((p) => Math.abs(p.start - (at + term.length)) < 2 || Math.abs(at - p.end) < 2)) continue;
      picked.push({ start: at, end: at + term.length, answer: term });
    }
  }

  // ② 按词打分补齐剩余预算
  const cands = [];
  for (const s of segmentWords(text)) {
    if (picked.some((p) => !(s.end <= p.start || s.start >= p.end))) continue;
    const sc = scoreWord(s.w, false);
    if (sc <= 0) continue;
    cands.push({ ...s, sc });
  }
  const target = Math.max(1, Math.min(maxBlanks, Math.round((text.length * density) / 3)));
  let budget = Math.max(0, target - picked.length);
  cands.sort((a, b) => b.sc - a.sc || a.start - b.start);
  for (const c of cands) {
    if (budget <= 0) break;
    if (picked.some((p) => Math.abs(p.start - c.end) < 4 || Math.abs(c.start - p.end) < 4)) continue;
    picked.push(c);
    budget--;
  }

  return picked.sort((a, b) => a.start - b.start).map((p) => ({ start: p.start, end: p.end, answer: text.slice(p.start, p.end) }));
}

/** 把句子切成 [{type:'text'|'blank', ...}] 便于渲染 */
export function tokenize(text, blanks) {
  const parts = [];
  let cur = 0;
  for (const b of blanks) {
    if (b.start > cur) parts.push({ type: 'text', text: text.slice(cur, b.start) });
    parts.push({ type: 'blank', text: b.answer, start: b.start, end: b.end });
    cur = b.end;
  }
  if (cur < text.length) parts.push({ type: 'text', text: text.slice(cur) });
  return parts;
}
