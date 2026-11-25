/**
 * 本地运行 / 调试用（Node 18+）
 *   node server/dev.mjs                 # 真实转发
 *   MOCK=1 node server/dev.mjs          # 用假数据跑通前端（不需要任何 Key）
 * 环境变量同 worker.mjs
 */
import http from 'node:http';
import worker from './worker.mjs';

const PORT = process.env.PORT || 8790;
const MOCK = process.env.MOCK === '1';

const env = {
  AI_BASE: process.env.AI_BASE || 'https://api.deepseek.com/v1',
  AI_KEY: process.env.AI_KEY || '',
  AI_MODEL: process.env.AI_MODEL || 'deepseek-chat',
  IMA_CID: process.env.IMA_CID || '',
  IMA_KEY: process.env.IMA_KEY || '',
  ACCESS_TOKEN: process.env.ACCESS_TOKEN || '',
  ALLOW_ORIGIN: process.env.ALLOW_ORIGIN || '*',
};

/* ---------- mock ---------- */
const MD = `# 第三章 决策

## 一、决策的定义
决策是管理者识别并解决问题以及利用机会的过程。决策的主体是管理者。
决策的本质是一个过程，而不是一次性的活动。

## 二、决策的原则
满意原则是决策的基本原则。决策者不可能掌握全部信息，因此只能追求满意解。
计划部门与职能工长制是泰罗提出的生产组织方法。
`;
const realFetch = globalThis.fetch;
if (MOCK) {
  env.IMA_CID = env.IMA_CID || 'mock-cid';
  env.IMA_KEY = env.IMA_KEY || 'mock-key';
  env.AI_KEY = env.AI_KEY || 'mock-ai';
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    const ok = (obj) => new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });

    if (u.includes('/openapi/wiki/v1/search_knowledge_base')) {
      return ok({ code: 0, msg: 'ok', data: { info_list: [{ id: 'kb_demo', name: '无知的知识库', description: '个人知识库' }, { id: 'kb_demo2', name: '榨干经典优秀书籍', description: '订阅' }], is_end: true, next_cursor: '' } });
    }
    if (u.includes('/openapi/wiki/v1/get_knowledge_list')) {
      const b = JSON.parse(init.body || '{}');
      if (!b.folder_id) {
        return ok({ code: 0, data: { knowledge_list: [
          { folder_id: 'f_exam', name: '03-考试复习' },
          { folder_id: 'f_ai', name: '05-AI与工具' },
          { media_id: 'm_manage', title: '管理学第三章.md' },
          { media_id: 'm_eco', title: '西方经济学笔记.md' },
        ], current_path: [{ folder_id: '', name: '根目录' }], is_end: true, next_cursor: '' } });
      }
      return ok({ code: 0, data: { knowledge_list: [{ media_id: 'm_manage2', title: '管理学课件整理.md' }], current_path: [{ folder_id: '', name: '根目录' }, { folder_id: b.folder_id, name: b.folder_id === 'f_exam' ? '03-考试复习' : '05-AI与工具' }], is_end: true, next_cursor: '' } });
    }
    if (u.includes('/openapi/wiki/v1/search_knowledge')) {
      return ok({ code: 0, data: { info_list: [{ media_id: 'm_manage', title: '管理学第三章.md', parent_folder_id: '', highlight_content: '…满意原则是决策的基本原则…' }], is_end: true, next_cursor: '' } });
    }
    if (u.includes('/openapi/wiki/v1/get_media_info')) {
      const b = JSON.parse(init.body || '{}');
      return ok({ code: 0, data: { media_type: 1, url_info: { url: 'https://mock-cos.example.com/' + b.media_id + '/%E7%AC%94%E8%AE%B0.md', headers: {} } } });
    }
    if (u.startsWith('https://mock-cos.example.com')) {
      return new Response(MD, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
    }
    if (u.includes('/chat/completions')) {
      const content = JSON.stringify([
        { quote: '满意原则', reason: '核心概念' },
        { quote: '管理者', reason: '主体' },
        { quote: '不存在于原文的词', reason: '故意放错，应被丢弃' },
      ]);
      return ok({ choices: [{ message: { content } }] });
    }
    return realFetch(input, init);
  };
}

/* ---------- http 适配 ---------- */
const srv = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (['content-length', 'host', 'connection'].includes(k)) continue;
      headers.set(k, Array.isArray(v) ? v.join(',') : v);
    }
    const request = new Request('http://localhost' + req.url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const out = await worker.fetch(request, env);
    const h = {};
    out.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(out.status, h);
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e) }));
  }
});
srv.listen(PORT, () => console.log(`句读中转服务 http://127.0.0.1:${PORT}  mock=${MOCK}`));
