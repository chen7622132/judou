/* 应用外壳：状态、路由、事件、文件解析 */

import * as store from './store.js';
import * as ui from './ui.js';
import * as db from './db.js';

const el = document.getElementById('app');

const S = {
  view: 'today',
  docId: null,
  busy: false,
  draft: { title: '', raw: '' },
  review: null,
  lastSummary: null,
};

/* ---------- 小工具 ---------- */
let toastTimer = null;
function toast(msg, ms = 2200) {
  document.querySelectorAll('.toast').forEach((n) => n.remove());
  const d = document.createElement('div');
  d.className = 'toast';
  d.textContent = msg;
  document.body.appendChild(d);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => d.remove(), ms);
}

function render(html) {
  el.innerHTML = html;
  if (S.view === 'review' && S.review?.phase === 'ask') {
    const inp = document.getElementById('ans');
    if (inp && S.review.focus) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }
}

/* ---------- 路由 ---------- */
async function go(view, opts = {}) {
  if (view === 'doc') S.docId = opts.docId;
  S.view = view;
  await refresh();
}

async function refresh() {
  const v = S.view;
  try {
    if (v === 'today') render(ui.viewToday(await store.stats()));
    else if (v === 'docs') render(ui.viewDocs(await store.listDocs(), S.busy));
    else if (v === 'doc') {
      const docs = await store.listDocs();
      const doc = docs.find((d) => d.id === S.docId);
      const cards = (await db.all('cards')).filter((c) => c.docId === S.docId).sort((a, b) => a.createdAt - b.createdAt);
      render(ui.viewDoc(doc || { title: '已删除' }, cards));
    }
    else if (v === 'stats') render(ui.viewStats(await store.stats()));
    else if (v === 'settings') render(ui.viewSettings(await store.getSettings()));
    else if (v === 'review') render(ui.viewReview(S.review));
  } catch (e) {
    console.error(e);
    toast('出错了：' + e.message, 4000);
  }
}

/* ---------- 复习流程 ---------- */
async function startReview(cardIds) {
  let queue;
  if (cardIds) {
    const all = await db.all('cards');
    queue = cardIds.map((id) => all.find((c) => c.id === id)).filter(Boolean);
  } else {
    queue = await store.dueQueue(40);
  }
  if (!queue.length) return toast('现在没有到期的句子');
  S.review = { queue, i: 0, card: queue[0], revealed: new Set(), revealAll: false, typed: '', phase: 'ask', result: null, suggest: 3, nextDue: null, focus: false };
  await go('review');
}

function resetCard() {
  const r = S.review;
  r.card = r.queue[r.i];
  r.revealed = new Set();
  r.revealAll = false;
  r.typed = '';
  r.phase = 'ask';
  r.result = null;
  r.focus = true;
}

function submit() {
  const r = S.review;
  if (!r || r.phase === 'judged') return;
  const c = r.card;
  const answers = c.blanks.map((b) => b.answer);
  const parts = (r.typed || '').split(/[\s,，、;；/]+/).filter(Boolean);
  r.result = answers.map((a, i) => {
    const input = parts.length === answers.length ? parts[i] || '' : i === 0 ? parts[0] || '' : '';
    const g = store.check(input, a);
    return { input, ok: g.correct };
  });
  const okCount = r.result.filter((x) => x.ok).length;
  r.phase = 'judged';
  r.suggest = okCount === answers.length ? 3 : okCount > 0 ? 2 : 1;
  // 预估下次时间用于展示
  store.previewNext(c).then((d) => { r.nextDue = d; if (S.view === 'review' && S.review.phase === 'judged') render(ui.viewReview(S.review)); }).catch(() => {});
  render(ui.viewReview(r));
}

async function grade(g) {
  const r = S.review;
  if (!r) return;
  try {
    const updated = await store.review(r.card, g);
    r.i++;
    if (r.i >= r.queue.length) {
      const done = r.queue.length;
      const summary = r.result ? r.result.filter((x) => x.ok).length : 0;
      S.review = null;
      S.lastSummary = `复习 ${done} 句`;
      await go('today');
      toast(`${S.lastSummary} · 记得导出备份`);
      return;
    }
    resetCard();
    render(ui.viewReview(r));
  } catch (e) {
    console.error(e);
    toast('保存失败：' + e.message, 4000);
  }
}

/* ---------- 文件解析 ---------- */
async function pdfToText(file) {
  const pdfjs = await import('../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  const buf = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  let out = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 4) * 4;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], s: it.str });
    }
    const ys = [...rows.keys()].sort((a, b) => b - a);
    let prevY = null;
    for (const y of ys) {
      const line = rows.get(y).sort((a, b) => a.x - b.x).map((o) => o.s).join('').trim();
      if (!line) continue;
      if (prevY !== null && prevY - y > 24) out += '\n';
      out += line + '\n';
      prevY = y;
    }
    out += '\n';
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

async function handleFile(file) {
  if (!file) return;
  const name = file.name.replace(/\.[^.]+$/, '');
  try {
    let text = '';
    if (/\.pdf$/i.test(file.name)) {
      toast('正在解析 PDF…', 6000);
      text = await pdfToText(file);
    } else {
      text = await file.text();
    }
    if (!text.trim()) return toast('这个文件里没有提取到文字（可能是扫描件）', 3500);
    S.busy = true;
    await refresh();
    const r = await store.importDoc({ title: name, raw: text, source: file.name });
    S.busy = false;
    S.draft = { title: '', raw: '' };
    await go('today');
    toast(`已导入《${r.doc.title}》· ${r.cards} 句`, 3000);
  } catch (e) {
    S.busy = false;
    console.error(e);
    await refresh();
    toast('导入失败：' + e.message, 4000);
  }
}

/* ---------- 导入导出 ---------- */
async function doExport() {
  const data = await store.exportAll();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `judou-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast('备份已导出');
}

async function doImport(file) {
  try {
    const text = await file.text();
    const r = await store.importAll(JSON.parse(text));
    await refresh();
    toast(`已导入 ${r.cards} 句 / ${r.docs} 篇`);
  } catch (e) {
    toast('导入失败：' + e.message, 3500);
  }
}

/* ---------- 事件 ---------- */
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-go],[data-act],[data-grade],[data-doc],[data-blank],[data-card]');
  if (!t) return;

  if (t.dataset.go) return go(t.dataset.go);

  if (t.dataset.grade) return grade(+t.dataset.grade);

  if (t.dataset.blank !== undefined && S.review) {
    const r = S.review;
    if (r.phase === 'judged') return;
    const i = +t.dataset.blank;
    if (r.revealed.has(i)) r.revealed.delete(i); else r.revealed.add(i);
    t.classList.toggle('on', r.revealed.has(i));
    return;
  }

  if (t.dataset.doc) {
    if (t.tagName === 'BUTTON' || t.classList.contains('t')) return go('doc', { docId: t.dataset.doc });
  }

  if (t.dataset.card) return startReview([t.dataset.card]);

  const act = t.dataset.act;
  if (act === 'start') {
    const s = await store.stats();
    if (s.due === 0 && s.total > 0) return startReview((await db.all('cards')).map((c) => c.id));
    return startReview();
  }
  if (act === 'import-text') {
    const raw = (document.getElementById('doc-raw')?.value || '').trim();
    const title = (document.getElementById('doc-title')?.value || '').trim();
    if (!raw) return toast('先贴一段文字');
    S.busy = true; await refresh();
    try {
      const r = await store.importDoc({ title, raw, source: 'paste' });
      S.busy = false; S.draft = { title: '', raw: '' };
      await go('today');
      toast(`已导入《${r.doc.title}》· ${r.cards} 句`, 3000);
    } catch (e) { S.busy = false; await refresh(); toast('失败：' + e.message, 4000); }
    return;
  }
  if (act === 'back') return go('docs');
  if (act === 'reblank') {
    if (!S.docId) return;
    const n = await store.reblankDoc(S.docId);
    await refresh();
    toast(`已重新挖空 ${n} 句`);
    return;
  }
  if (act === 'del-doc') {
    if (!S.docId) return;
    if (!confirm('删除这篇材料及其全部句子？（不可恢复）')) return;
    await store.deleteDoc(S.docId);
    await go('docs');
    toast('已删除');
    return;
  }
  if (act === 'quit') {
    S.review = null;
    return go('today');
  }
  if (act === 'reveal') {
    S.review.revealAll = true;
    S.review.phase = 'self';
    S.review.suggest = 3;
    render(ui.viewReview(S.review));
    return;
  }
  if (act === 'submit') return submit();
  if (act === 'export') return doExport();
  if (act === 'wipe') {
    if (!confirm('清空全部材料、句子与学习记录？')) return;
    await store.wipe();
    await go('today');
    toast('已清空');
    return;
  }
  if (act === 'ai-save') {
    const endpoint = document.getElementById('ai-endpoint').value.trim();
    const key = document.getElementById('ai-key').value.trim();
    const model = document.getElementById('ai-model').value.trim();
    await store.saveSettings({ ai: { endpoint, key, model, enabled: !!(endpoint && key) } });
    toast(endpoint && key ? 'AI 已启用（导入时尝试 AI 挖空）' : '已保存，但未启用');
    return;
  }
  if (act === 'ai-test') {
    const s = await store.getSettings();
    if (!s.ai.key) return toast('先填 Key 并保存');
    try {
      toast('请求中…', 8000);
      const r = await store.aiBlanks('决策是管理者识别并解决问题以及利用机会的过程。', s.ai);
      toast(r.length ? '成功，返回 ' + r.length + ' 个挖空：' + r.map((x) => x.answer).join('、') : '连上了，但没返回可用挖空', 4000);
    } catch (e) { toast('失败：' + e.message, 5000); }
    return;
  }
});

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id === 'ans' && S.review) S.review.typed = t.value;
  if (t.id === 'doc-raw') S.draft.raw = t.value;
  if (t.id === 'doc-title') S.draft.title = t.value;
  if (t.id === 'density') {
    const lab = t.closest('.set-row')?.querySelector('.lab small');
    if (lab) lab.textContent = `越高挖得越多，${t.value}%`;
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.target.id === 'ans' && ev.key === 'Enter') { ev.preventDefault(); submit(); }
});

document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.id === 'file') return handleFile(t.files?.[0]);
  if (t.id === 'import-file') return doImport(t.files?.[0]);
  if (t.id === 'density') { await store.saveSettings({ density: +t.value / 100 }); return toast('已保存，对之后导入/重挖空生效'); }
  if (t.id === 'maxBlanks') { await store.saveSettings({ maxBlanks: +t.value }); return toast('已保存'); }
  if (t.id === 'retain') { await store.saveSettings({ retain: +t.value }); return toast('已保存'); }
  if (t.id === 'terms') { await store.saveSettings({ terms: t.value }); return toast('术语表已保存'); }
});

/* ---------- 启动 ---------- */
(async function boot() {
  try { await db.open(); } catch (e) { console.warn(e); }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  await go('today');
})();
