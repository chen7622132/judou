/* 应用外壳：状态、路由、事件、文件解析 */

import * as store from './store.js';
import * as ui from './ui.js';
import * as db from './db.js';
import { extractText } from './extract.js';

const el = document.getElementById('app');

const S = {
  view: 'today',
  docId: null,
  busy: false,
  draft: { title: '', raw: '' },
  review: null,
  ima: null,
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
    else if (v === 'ima') {
      if (!S.ima) {
        const s = await store.getSettings();
        S.ima = { mode: 'kb', kbs: [], items: [], path: [], loading: false, error: '', noServer: !s.server?.url };
      }
      render(ui.viewIma(S.ima));
    }
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
  store.previewNext(c).then((d) => { r.nextDue = d; if (S.view === 'review' && S.review.phase === 'judged') render(ui.viewReview(S.review)); }).catch(() => {});
  render(ui.viewReview(r));
}

async function grade(g) {
  const r = S.review;
  if (!r) return;
  try {
    await store.review(r.card, g);
    r.i++;
    if (r.i >= r.queue.length) {
      const done = r.queue.length;
      S.review = null;
      await go('today');
      toast(`复习 ${done} 句 · 记得导出备份`);
      return;
    }
    resetCard();
    render(ui.viewReview(r));
  } catch (e) {
    console.error(e);
    toast('保存失败：' + e.message, 4000);
  }
}

/* ---------- 文件导入 ---------- */
async function importBuffer({ buffer, name, title }) {
  const { text } = await extractText({ name, buffer }, (p) => { if (p === 1) toast('解析中…', 20000); });
  if (!text || !text.trim()) throw new Error('没有提取到文字（可能是扫描件或图片）');
  return store.importDoc({ title: (title || name || '未命名').replace(/\.[^.]+$/, ''), raw: text, source: name || 'file' });
}

async function handleFile(file) {
  if (!file) return;
  try {
    toast('正在解析 ' + file.name + '…', 20000);
    const buffer = new Uint8Array(await file.arrayBuffer());
    const r = await importBuffer({ buffer, name: file.name });
    S.draft = { title: '', raw: '' };
    await go('today');
    toast(`已导入《${r.doc.title}》· ${r.cards} 句`, 3000);
  } catch (e) {
    console.error(e);
    await refresh();
    toast('导入失败：' + e.message, 4500);
  }
}

/* ---------- ima ---------- */
async function imaKbList(query = '') {
  S.ima = { ...(S.ima || {}), mode: 'kb', query, loading: true, error: '', noServer: false };
  render(ui.viewIma(S.ima));
  try {
    const { list } = await store.imaListKb(query);
    S.ima = { ...S.ima, kbs: list, loading: false };
  } catch (e) {
    S.ima = { ...S.ima, loading: false, error: e.message, kbs: [] };
  }
  render(ui.viewIma(S.ima));
}

async function imaOpenKb(id, name) {
  S.ima = { mode: 'dir', kbId: id, kbName: name, folder: '', path: [], items: [], loading: true, error: '' };
  await imaFolder('');
}

async function imaFolder(folder) {
  S.ima = { ...S.ima, folder, loading: true, error: '' };
  render(ui.viewIma(S.ima));
  try {
    const d = await store.imaFolder(S.ima.kbId, folder);
    S.ima = { ...S.ima, items: d.items, path: d.path, loading: false };
  } catch (e) {
    S.ima = { ...S.ima, loading: false, error: e.message, items: [] };
  }
  render(ui.viewIma(S.ima));
}

async function imaSearchIn(query) {
  if (!query.trim()) return toast('输入关键词');
  S.ima = { ...S.ima, loading: true, error: '' };
  render(ui.viewIma(S.ima));
  try {
    const list = await store.imaSearch(S.ima.kbId, query);
    S.ima = { ...S.ima, loading: false, items: list.map((x) => ({ id: x.mediaId, mediaId: x.mediaId, name: x.name, isFolder: false, hint: x.hint })) };
  } catch (e) {
    S.ima = { ...S.ima, loading: false, error: e.message };
  }
  render(ui.viewIma(S.ima));
}

async function imaImport(mediaId, title) {
  try {
    toast('正在从 ima 取文件…', 30000);
    const { buffer, name } = await store.imaFetchFile(mediaId, title);
    const r = await importBuffer({ buffer, name, title });
    await go('today');
    toast(`已导入《${r.doc.title}》· ${r.cards} 句`, 3000);
  } catch (e) {
    console.error(e);
    toast('导入失败：' + e.message, 5000);
  }
}

/* ---------- 备份 ---------- */
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
    const j = JSON.parse(await file.text());
    if (j.type === 'judou-material' || (j.title && j.text && !j.app)) {
      const r = await store.importDoc({ title: j.title || '材料包', raw: j.text, source: 'material' });
      await refresh();
      toast(`已导入《${r.doc.title}》· ${r.cards} 句`);
      return;
    }
    const r = await store.importAll(j);
    await refresh();
    toast(`已导入 ${r.cards} 句 / ${r.docs} 篇`);
  } catch (e) {
    toast('导入失败：' + e.message, 3500);
  }
}

/* ---------- 事件 ---------- */
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-go],[data-act],[data-grade],[data-doc],[data-blank],[data-card],[data-ima-kb],[data-ima-folder],[data-ima-file]');
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

  if (t.dataset.doc) return go('doc', { docId: t.dataset.doc });
  if (t.dataset.card) return startReview([t.dataset.card]);
  if (t.dataset.imaKb) return imaOpenKb(t.dataset.imaKb, t.dataset.imaName || '');
  if (t.hasAttribute('data-ima-folder')) return imaFolder(t.dataset.imaFolder || '');
  if (t.dataset.imaFile) return imaImport(t.dataset.imaFile, t.dataset.imaTitle || '');

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
  if (act === 'go-ima') {
    const s = await store.getSettings();
    S.ima = { mode: 'kb', kbs: [], items: [], path: [], loading: false, error: '', noServer: !s.server?.url };
    await go('ima');
    if (s.server?.url) return imaKbList('');
    return;
  }
  if (act === 'ima-back') {
    if (S.ima?.mode === 'dir') { S.ima = { ...S.ima, mode: 'kb' }; return imaKbList(S.ima.query || ''); }
    return go('docs');
  }
  if (act === 'ima-search') return imaKbList(document.getElementById('ima-q')?.value || '');
  if (act === 'ima-search-in') return imaSearchIn(document.getElementById('ima-q2')?.value || '');
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
  if (act === 'quit') { S.review = null; return go('today'); }
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
  if (act === 'srv-save') {
    const url = document.getElementById('srv-url').value.trim();
    const token = document.getElementById('srv-token').value.trim();
    await store.saveSettings({ server: { url, token } });
    toast(url ? '中转服务已保存' : '已清空');
    await refresh();
    return;
  }
  if (act === 'srv-test') {
    try {
      toast('连接中…', 15000);
      const r = await store.pingServer();
      toast(`连上了 · AI ${r.ai ? '可用' : '未配置'} · ima ${r.ima ? '可用' : '未配置'}${r.model ? ' · ' + r.model : ''}`, 4500);
    } catch (e) { toast('失败：' + e.message, 5000); }
    return;
  }
  if (act === 'ai-save') {
    const model = document.getElementById('ai-model').value.trim();
    const endpoint = document.getElementById('ai-endpoint')?.value.trim() || '';
    const key = document.getElementById('ai-key')?.value.trim() || '';
    await store.saveSettings({ ai: { endpoint, key, model, enabled: true } });
    toast('已保存');
    await refresh();
    return;
  }
  if (act === 'ai-test') {
    try {
      toast('请求中…', 20000);
      const s = await store.getSettings();
      const r = await store.aiBlanks('决策是管理者识别并解决问题以及利用机会的过程。满意原则是决策的基本原则。', s.ai);
      toast(r.length ? `成功：${r.map((x) => x.answer).join('、')}` : '连上了，但没返回可用挖空', 4000);
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
  if (ev.target.id === 'ima-q2' && ev.key === 'Enter') { ev.preventDefault(); imaSearchIn(ev.target.value); }
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  await go('today');
})();
