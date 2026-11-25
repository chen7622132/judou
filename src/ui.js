/* 纯渲染函数：输入状态，输出 HTML 字符串 */

import { tokenize } from './core.js';

export const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtWhen(iso) {
  if (!iso) return '未学';
  const d = new Date(iso);
  const diff = d.getTime() - Date.now();
  const day = Math.round(diff / 86400000);
  if (diff <= 0) return '现在';
  if (day === 0) return '今天';
  if (day === 1) return '明天';
  if (day < 30) return day + ' 天后';
  return Math.round(day / 30) + ' 个月后';
}

export const tabbar = (view) => `
<nav class="tabbar">
  ${[
    ['today', '◉', '今日'],
    ['docs', '▤', '资料'],
    ['stats', '◔', '统计'],
    ['settings', '⚙', '设置'],
  ].map(([k, ic, label]) => `<button data-go="${k}" class="${view === k ? 'on' : ''}"><span class="ic">${ic}</span>${label}</button>`).join('')}
</nav>`;

const header = (title, sub = '', right = '') => `
<header class="hd">
  <h1>${esc(title)}</h1>
  ${sub ? `<span class="sub">${sub}</span>` : ''}
  ${right}
</header>`;

/* ---------- 今日 ---------- */
export function viewToday(s) {
  const done = s.due === 0 && s.total > 0;
  return `
${header('句读', s.due ? `${s.due} 句待复习` : '')}
<main>
  <div class="hero">
    <div class="num">${s.due}<small>句</small></div>
    <div class="cap">${s.total === 0 ? '还没有材料，去「资料」导入一段课文' : done ? '今天的都背完了' : '今日到期'}</div>
  </div>

  ${s.total > 0 ? `<button class="btn primary block" data-act="start" style="margin-bottom:14px;min-height:52px;font-size:17px">
    ${done ? '再练一遍' : `开始复习${s.due ? '（' + s.due + '）' : ''}`}
  </button>` : `<button class="btn primary block" data-go="docs" style="margin-bottom:14px;min-height:52px">去导入材料</button>`}

  <div class="grid3">
    <div class="stat"><b>${s.total}</b><span>总句数</span></div>
    <div class="stat"><b>${s.streak}</b><span>连续天数</span></div>
    <div class="stat"><b>${s.reviews ? Math.round(s.acc * 100) + '%' : '—'}</b><span>近期正确率</span></div>
  </div>

  <div class="card tight">
    <div class="row between">
      <span class="muted">今天已复习</span>
      <b>${s.todayReviews} 句 · 对 ${s.todayCorrect}</b>
    </div>
    ${s.newCards ? `<div class="row between" style="margin-top:8px"><span class="muted">新句待首背</span><b>${s.newCards}</b></div>` : ''}
  </div>

  ${s.weak.length ? `
  <div class="card">
    <div class="row between" style="margin-bottom:10px">
      <b style="font-size:14px">最需要加强</b>
      <span class="tiny">遗忘次数最多</span>
    </div>
    ${s.weak.map((c) => `
      <div class="doc-item" data-card="${c.id}">
        <div class="t"><b>${esc(c.text.slice(0, 28))}${c.text.length > 28 ? '…' : ''}</b>
        <span>忘过 ${c.srs?.lapses || 0} 次 · ${fmtWhen(c.srs?.due)}</span></div>
      </div>`).join('')}
  </div>` : ''}

  <p class="tiny" style="text-align:center;margin-top:18px">数据只存在这台设备上 · 记得在「设置」里导出备份</p>
</main>
${tabbar('today')}`;
}

/* ---------- 复习 ---------- */
export function viewReview(st) {
  const c = st.card;
  if (!c) return '';
  const parts = tokenize(c.text, c.blanks);
  const judged = st.phase === 'judged';
  const showAll = judged || st.revealAll;
  let n = -1;

  const body = parts.map((p) => {
    if (p.type === 'text') return esc(p.text);
    n++;
    const idx = n;
    const shown = st.revealed.has(idx) || showAll;
    const res = judged ? st.result[idx] : null;
    const cls = ['blank'];
    if (res) cls.push(res.ok ? 'j-ok' : 'j-bad');
    else if (shown) cls.push('on');
    const len = Math.min(6, Math.max(2, [...p.text].length));
    return `<span class="${cls.join(' ')}" data-blank="${idx}" style="min-width:${len}em">${esc(p.text)}</span>`;
  }).join('');

  const answers = c.blanks.map((b) => b.answer);

  return `
${header(`${st.i + 1} / ${st.queue.length}`, `剩下 ${st.queue.length - st.i - 1} 句`,
    `<button class="icon-btn" data-act="quit">✕</button>`)}
<div class="review-wrap">
  <div class="progress"><i style="width:${((st.i) / Math.max(1, st.queue.length)) * 100}%"></i></div>

  <div class="q">${body}</div>

  ${st.phase === 'ask' ? `
  <div class="answer-row">
    <input id="ans" type="text" autocomplete="off" autocorrect="off" autocapitalize="off"
      placeholder="${c.blanks.length > 1 ? `按顺序填 ${c.blanks.length} 个，空格或逗号隔开` : '默写被挖掉的部分'}" value="${esc(st.typed || '')}">
    <div class="tiny">想不起来就点空位看提示；也可以直接「看答案」自评</div>
  </div>` : st.phase === 'self' ? `
  <div class="answer-row">
    <div class="judge">答案：${answers.map((a) => `<span class="ok">${esc(a)}</span>`).join('　')}</div>
    <div class="tiny">按实际回忆情况自评，系统据此排下次复习</div>
  </div>` : `
  <div class="answer-row">
    ${st.result.map((r, i) => `
      <div class="judge">
        <span class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '✗'}</span>
        第 ${i + 1} 空：正确「${esc(answers[i])}」${r.input ? ` · 你写「${esc(r.input)}」` : ' · 未作答'}
      </div>`).join('')}
    <div class="tiny" style="margin-top:6px">下次复习：${fmtWhen(st.nextDue)}</div>
  </div>`}
</div>

${st.phase === 'ask' ? `
<div class="grade-bar" style="grid-template-columns:1fr 1.4fr">
  <button class="btn ghost" data-act="reveal">看答案</button>
  <button class="btn primary" data-act="submit">提交</button>
</div>` : `
<div class="grade-bar">
  <button class="btn again ${st.suggest === 1 ? 'recommend' : ''}" data-grade="1">忘了<small>1 天内</small></button>
  <button class="btn hard ${st.suggest === 2 ? 'recommend' : ''}" data-grade="2">模糊<small>有点绕</small></button>
  <button class="btn good ${st.suggest === 3 ? 'recommend' : ''}" data-grade="3">会了<small>顺畅</small></button>
</div>`}`;
}

/* ---------- 资料 ---------- */
export function viewDocs(docs, busy = false) {
  return `
${header('资料', docs.length ? `${docs.length} 篇` : '')}
<main>
  <div class="card">
    <label class="field">
      <span>标题（可留空，自动取首行）</span>
      <input id="doc-title" type="text" placeholder="例：第三章 决策">
    </label>
    <label class="field">
      <span>粘贴课文 / 讲义</span>
      <textarea id="doc-raw" placeholder="把要背的内容贴进来。支持 Markdown 标题、分级；自动按句子切开。"></textarea>
    </label>
    <div class="row" style="gap:8px">
      <button class="btn primary" data-act="import-text" style="flex:1;height:50px" ${busy ? 'disabled' : ''}>${busy ? '处理中…' : '导入并挖空'}</button>
      <label class="btn ghost" style="flex:0 0 96px;height:50px;border-color:#39425a;color:var(--fg)">
        选文件<input id="file" type="file" accept=".pdf,.docx,.pptx,.epub,.txt,.md,.markdown,.html,.htm" hidden>
      </label>
    </div>
    <div class="tiny" style="margin-top:8px">支持 pdf / docx / pptx / epub / txt / md。扫描件提不出文字。</div>
  </div>

  <button class="btn block" data-act="go-ima" style="margin-bottom:12px">⤓ 从 ima 知识库导入</button>

  ${docs.length ? `
  <div class="card">
    ${docs.map((d) => `
      <div class="doc-item">
        <div class="t" data-doc="${d.id}">
          <b>${esc(d.title)}</b>
          <span>${d.total} 句 · ${d.due ? `<span style="color:var(--accent)">${d.due} 句待复习</span>` : '已同步'}</span>
        </div>
        <button class="btn sm ghost" data-doc="${d.id}">打开</button>
      </div>`).join('')}
  </div>` : `<div class="empty"><span class="big">▤</span>还没有材料<br>上面贴一段课文试试</div>`}
</main>
${tabbar('docs')}`;
}

export function viewDoc(doc, cards) {
  return `
${header(doc.title, `${cards.length} 句`, `<button class="icon-btn" data-act="back">←</button>`)}
<main>
  <div class="row" style="gap:8px;margin-bottom:12px">
    <button class="btn sm" data-act="reblank" style="flex:1">按当前设置重新挖空</button>
    <button class="btn sm" data-act="del-doc" style="color:var(--bad);border-color:rgba(229,83,75,.35)">删除</button>
  </div>
  ${cards.map((c, i) => `
    <div class="card tight" style="margin-bottom:8px">
      <div class="tiny" style="margin-bottom:4px">${i + 1} · ${c.blanks.length} 空 · ${fmtWhen(c.srs?.due)}</div>
      <div style="font-size:15px;line-height:1.8">${esc(c.text)}</div>
      <div class="tiny" style="margin-top:6px;color:var(--accent)">挖空：${c.blanks.map((b) => esc(b.answer)).join(' / ') || '（无）'}</div>
    </div>`).join('')}
</main>`;
}

/* ---------- 统计 ---------- */
export function viewStats(s) {
  const max = Math.max(1, ...s.forecast.map((f) => f.n));
  return `
${header('统计')}
<main>
  <div class="grid3">
    <div class="stat"><b>${s.reviews}</b><span>累计复习</span></div>
    <div class="stat"><b>${s.reviews ? Math.round(s.acc * 100) + '%' : '—'}</b><span>正确率</span></div>
    <div class="stat"><b>${s.streak}</b><span>连续天数</span></div>
  </div>

  <div class="card">
    <div class="row between" style="margin-bottom:14px"><b style="font-size:14px">未来 7 天到期</b><span class="tiny">句</span></div>
    <div style="display:flex;align-items:flex-end;gap:8px;height:96px">
      ${s.forecast.map((f) => `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;justify-content:flex-end">
          <span class="tiny" style="font-size:11px">${f.n || ''}</span>
          <div style="width:100%;height:${Math.max(3, (f.n / max) * 64)}px;background:${f.n ? 'var(--accent)' : 'var(--line)'};border-radius:4px 4px 0 0"></div>
          <span class="tiny" style="font-size:11px">${f.day === 0 ? '今' : '+' + f.day}</span>
        </div>`).join('')}
    </div>
  </div>

  <div class="card">
    <div class="row between" style="margin-bottom:6px"><b style="font-size:14px">学习分布</b></div>
    <div class="row between" style="padding:6px 0"><span class="muted">未学</span><b>${s.newCards}</b></div>
    <div class="row between" style="padding:6px 0"><span class="muted">今日到期</span><b style="color:var(--accent)">${s.due}</b></div>
    <div class="row between" style="padding:6px 0"><span class="muted">总句数</span><b>${s.total}</b></div>
  </div>

  ${s.weak.length ? `
  <div class="card">
    <b style="font-size:14px">薄弱句</b>
    ${s.weak.map((c) => `
      <div class="doc-item">
        <div class="t"><b style="white-space:normal">${esc(c.text.slice(0, 40))}${c.text.length > 40 ? '…' : ''}</b>
        <span>忘过 ${c.srs?.lapses} 次</span></div>
      </div>`).join('')}
  </div>` : ''}
</main>
${tabbar('stats')}`;
}

/* ---------- 设置 ---------- */
export function viewSettings(s) {
  const hasServer = !!(s.server && s.server.url);
  return `
${header('设置')}
<main>
  <div class="card">
    <div class="set-row">
      <div class="lab">挖空密度<small>越高挖得越多，${Math.round(s.density * 100)}%</small></div>
      <input type="range" id="density" min="12" max="45" step="1" value="${Math.round(s.density * 100)}">
    </div>
    <div class="set-row">
      <div class="lab">单句最多挖空<small>${s.maxBlanks} 个</small></div>
      <input type="range" id="maxBlanks" min="1" max="8" step="1" value="${s.maxBlanks}">
    </div>
    <div class="set-row">
      <div class="lab">目标留存率<small>越高复习越频繁 · ${s.retain}</small></div>
      <select id="retain">
        ${[0.8, 0.85, 0.9, 0.95].map((v) => `<option value="${v}" ${String(v) === String(s.retain) ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>
  </div>

  <div class="card">
    <label class="field" style="margin:0">
      <span>术语表（一行一个，命中优先挖）</span>
      <textarea id="terms" style="min-height:92px" placeholder="满意原则&#10;计划部门&#10;例外管理&#10;需求价格弹性">${esc(s.terms)}</textarea>
    </label>
    <div class="tiny" style="margin-top:6px">最有效的优化：把学科概念名放进来，挖空就不会挖到形容词上。</div>
  </div>

  <div class="card">
    <div class="row between" style="margin-bottom:4px">
      <b style="font-size:14px">中转服务</b>
      <span class="tiny">${hasServer ? '已配置' : '未配置'}</span>
    </div>
    <div class="tiny" style="margin-bottom:12px;line-height:1.6">
      AI 和 ima 知识库都需要它：浏览器不能直连这两家（跨域 + Key 不能放前端）。
      部署一个 Worker 填在这里，两项功能一起通。
    </div>
    <label class="field"><span>服务地址</span>
      <input id="srv-url" type="url" placeholder="https://xxx.workers.dev" value="${esc(s.server?.url || '')}"></label>
    <label class="field"><span>访问口令（与服务端 ACCESS_TOKEN 一致）</span>
      <input id="srv-token" type="password" placeholder="可留空" value="${esc(s.server?.token || '')}"></label>
    <div class="row" style="gap:8px">
      <button class="btn sm" data-act="srv-save" style="flex:1">保存</button>
      <button class="btn sm ghost" data-act="srv-test" style="flex:1">测试连接</button>
    </div>
  </div>

  <div class="card">
    <div class="row between" style="margin-bottom:10px">
      <b style="font-size:14px">AI 挖空</b>
      <span class="tiny">${hasServer ? '走中转服务' : s.ai.key ? '走直连' : '未配置'}</span>
    </div>
    <label class="field"><span>模型名</span>
      <input id="ai-model" type="text" placeholder="deepseek-chat" value="${esc(s.ai.model || '')}"></label>
    ${hasServer ? `<div class="tiny">Key 存在中转服务里，前端不接触。</div>` : `
      <label class="field"><span>接口地址（会跨域失败，仅备用）</span>
        <input id="ai-endpoint" type="url" value="${esc(s.ai.endpoint || '')}"></label>
      <label class="field"><span>API Key</span>
        <input id="ai-key" type="password" value="${esc(s.ai.key || '')}" placeholder="sk-..."></label>`}
    <div class="row" style="gap:8px;margin-top:4px">
      <button class="btn sm" data-act="ai-save" style="flex:1">保存</button>
      <button class="btn sm ghost" data-act="ai-test" style="flex:1">测试一句</button>
    </div>
  </div>

  <div class="card">
    <div class="row" style="gap:8px">
      <button class="btn sm" data-act="export" style="flex:1">导出备份</button>
      <label class="btn sm ghost" style="flex:1">导入备份<input id="import-file" type="file" accept=".json,application/json" hidden></label>
    </div>
    <button class="btn sm ghost block" data-act="wipe" style="margin-top:10px;color:var(--bad)">清空所有数据</button>
  </div>

  <p class="tiny" style="text-align:center;line-height:1.9">
    句读 v1.1 · 数据全在本机 IndexedDB<br>
    FSRS-6（ts-fsrs）· PDF（pdf.js）· 分词（Intl.Segmenter）· 文档解析（fflate）
  </p>
</main>
${tabbar('settings')}`;
}

/* ---------- 从 ima 导入 ---------- */
export function viewIma(st) {
  const head = `
${header('从 ima 导入', st.kbName || (st.mode === 'dir' ? '' : ''), `<button class="icon-btn" data-act="ima-back">←</button>`)}`;

  if (st.noServer) {
    return `${head}
<main>
  <div class="empty"><span class="big">⇄</span>
    需要先配置中转服务<br>
    <span class="tiny">浏览器不能直连 ima 的接口（跨域限制），<br>必须用一个中转地址转发</span>
  </div>
  <button class="btn primary block" data-go="settings">去设置</button>
</main>`;
  }

  if (st.mode === 'kb') {
    return `${head}
<main>
  <div class="card">
    <div class="row" style="gap:8px">
      <input id="ima-q" type="text" placeholder="搜索知识库，留空列出全部" value="${esc(st.query || '')}">
      <button class="btn sm" data-act="ima-search">搜索</button>
    </div>
  </div>
  ${st.loading ? `<div class="empty">读取中…</div>` : st.error ? `<div class="card" style="color:var(--bad);font-size:14px">${esc(st.error)}</div>` : ''}
  ${st.kbs.length ? `<div class="card">
    ${st.kbs.map((k) => `
      <div class="doc-item">
        <div class="t"><b>${esc(k.name)}</b><span>${esc(k.desc || k.id)}</span></div>
        <button class="btn sm ghost" data-ima-kb="${esc(k.id)}" data-ima-name="${esc(k.name)}">打开</button>
      </div>`).join('')}
  </div>` : (!st.loading && !st.error ? `<div class="empty"><span class="big">▤</span>没有找到知识库</div>` : '')}
</main>`;
  }

  const chain = (st.path || []).filter((p) => p.folder_id);
  const up = chain.length >= 2 ? chain[chain.length - 2].folder_id : '';
  const crumbs = [
    chain.length ? `<button class="btn sm ghost" data-ima-folder="${esc(up)}">↑ 上一级</button>` : '',
    `<button class="btn sm ghost" data-ima-folder="">根目录</button>`,
  ].concat(chain.map((p) => `<span class="tiny">/</span><button class="btn sm ghost" data-ima-folder="${esc(p.folder_id)}">${esc(p.name || p.folder_id)}</button>`))
    .filter(Boolean).join('');

  return `${head}
<main>
  <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:10px">${crumbs}</div>
  <div class="card">
    <div class="row" style="gap:8px;margin-bottom:10px">
      <input id="ima-q2" type="text" placeholder="在这个库里搜内容" value="">
      <button class="btn sm" data-act="ima-search-in">搜索</button>
    </div>
    <div class="tiny" style="margin-bottom:8px">搜到结果后，点条目直接导入</div>
  </div>
  ${st.loading ? `<div class="empty">读取中…</div>` : ''}
  ${st.error ? `<div class="card" style="color:var(--bad);font-size:14px">${esc(st.error)}</div>` : ''}
  ${st.items.length ? `<div class="card">
    ${st.items.map((it) => `
      <div class="doc-item">
        <div class="t"><b>${it.isFolder ? '▸ ' : ''}${esc(it.name)}</b><span>${it.isFolder ? '文件夹' : '文档'}</span></div>
        ${it.isFolder
          ? `<button class="btn sm ghost" data-ima-folder="${esc(it.id)}">进入</button>`
          : `<button class="btn sm" data-ima-file="${esc(it.mediaId || it.id)}" data-ima-title="${esc(it.name)}">导入</button>`}
      </div>`).join('')}
  </div>` : (!st.loading ? `<div class="empty"><span class="big">▤</span>这个目录是空的</div>` : '')}
</main>`;
}
