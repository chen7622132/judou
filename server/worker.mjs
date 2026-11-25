/**
 * 句读中转服务（Cloudflare Worker 单文件）
 * 一次部署，同时提供：AI 挖空代理 + ima 知识库读取
 *
 * 环境变量（Settings → Variables and Secrets）：
 *   AI_BASE       上游 OpenAI 兼容地址，例：https://api.deepseek.com/v1
 *   AI_KEY        上游 Key（用 Secret 存）
 *   AI_MODEL      默认模型，例：deepseek-chat
 *   IMA_CID       ima OpenAPI Client ID（ima.qq.com/agent-interface 获取）
 *   IMA_KEY       ima OpenAPI API Key（用 Secret 存）
 *   ACCESS_TOKEN  前端要填的口令，防止别人白用你的 Key（用 Secret 存）
 *   ALLOW_ORIGIN  允许的站点，默认 *（可填 https://chen7622132.github.io）
 */

const IMA_BASE = 'https://ima.qq.com';
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } });

const cors = (env) => ({
  'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'content-type,x-judou-token',
  'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Expose-Headers': 'x-filename,x-content-type',
});

async function ima(env, path, body) {
  if (!env.IMA_CID || !env.IMA_KEY) throw new Error('服务端未配置 IMA_CID / IMA_KEY');
  const r = await fetch(`${IMA_BASE}/openapi/wiki/v1/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'ima-openapi-clientid': env.IMA_CID,
      'ima-openapi-apikey': env.IMA_KEY,
    },
    body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('ima 返回非 JSON：' + text.slice(0, 120)); }
  if (j.code !== 0) throw new Error(`ima(${path}) ${j.code}: ${j.msg || '未知错误'}`);
  return j.data || {};
}

async function imaNote(env, path, body) {
  if (!env.IMA_CID || !env.IMA_KEY) throw new Error('服务端未配置 IMA_CID / IMA_KEY');
  const r = await fetch(`${IMA_BASE}/openapi/note/v1/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'ima-openapi-clientid': env.IMA_CID,
      'ima-openapi-apikey': env.IMA_KEY,
    },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({ code: -1, msg: 'note 接口返回非 JSON' }));
  if (j.code !== 0) throw new Error(`imaNote(${path}) ${j.code}: ${j.msg || ''}`);
  return j.data || {};
}

const EXT = (ct = '', url = '', title = '') => {
  const fromUrl = (url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  const fromTitle = (title.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  const guess =
    /pdf/.test(ct) ? 'pdf'
    : /presentation|powerpoint|pptx/.test(ct) ? 'pptx'
    : /word|document|docx/.test(ct) ? 'docx'
    : /epub/.test(ct) ? 'epub'
    : /html/.test(ct) ? 'html'
    : /text\/plain/.test(ct) ? 'txt'
    : '';
  return (fromUrl || fromTitle || guess || 'bin').toLowerCase();
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const ch = cors(env);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });

    // 鉴权（/ping 也校验，便于前端确认口令对不对）
    if (env.ACCESS_TOKEN) {
      const got = req.headers.get('x-judou-token') || '';
      if (got !== env.ACCESS_TOKEN) return json({ error: '口令不对', msg: '口令不对：检查设置里的访问口令与服务端 ACCESS_TOKEN 是否一致' }, 401, ch);
    }

    if (path === '/ping' || path === '/') {
      return json({ ok: true, ai: !!env.AI_KEY, ima: !!(env.IMA_CID && env.IMA_KEY), model: env.AI_MODEL || '' }, 200, ch);
    }

    let body = {};
    if (req.method === 'POST') {
      try { body = await req.json(); } catch { body = {}; }
    }

    try {
      // ---------- AI ----------
      if (path === '/ai') {
        if (!env.AI_KEY) return json({ error: '未配置 AI_KEY' }, 400, ch);
        const base = (env.AI_BASE || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
        const upstream = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_KEY}` },
          body: JSON.stringify({ temperature: 0.2, ...body, model: body.model || env.AI_MODEL || 'deepseek-chat' }),
        });
        const text = await upstream.text();
        return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...ch } });
      }

      // ---------- ima ----------
      if (path === '/ima/kb') {
        const d = await ima(env, 'search_knowledge_base', { query: body.query || '', cursor: '', limit: Math.min(20, body.limit || 20) });
        return json(d, 200, ch);
      }
      if (path === '/ima/list') {
        const d = await ima(env, 'get_knowledge_list', {
          knowledge_base_id: body.kb,
          cursor: body.cursor || '',
          limit: Math.min(50, body.limit || 50),
          ...(body.folder ? { folder_id: body.folder } : {}),
        });
        return json(d, 200, ch);
      }
      if (path === '/ima/search') {
        const d = await ima(env, 'search_knowledge', { query: body.query || '', knowledge_base_id: body.kb, cursor: body.cursor || '' });
        return json(d, 200, ch);
      }
      if (path === '/ima/file') {
        const info = await ima(env, 'get_media_info', { media_id: body.media_id });
        const type = Number(info.media_type || 0);

        // 笔记：走 note 模块取正文
        if (type === 11 || info.notebook_ext_info?.notebook_id) {
          const nb = info.notebook_ext_info?.notebook_id || body.media_id;
          const d = await imaNote(env, 'get_doc_content', { notebook_id: nb });
          const text = d.content || d.doc_content || d.text || JSON.stringify(d);
          return new Response(text, {
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'x-filename': encodeURIComponent((body.title || 'ima-笔记') + '.txt'),
              'x-content-type': 'text/plain',
              ...ch,
            },
          });
        }

        const u = info.url_info || {};
        if (!u.url) return json({ error: 'ima 没有返回文件链接', msg: '拿不到文件链接（可能是视频或图片类型）' }, 400, ch);
        const f = await fetch(u.url, { headers: u.headers || {} });
        if (!f.ok) return json({ error: '文件下载失败 ' + f.status }, 502, ch);
        const ct = f.headers.get('content-type') || '';
        let name = '';
        const dispo = f.headers.get('content-disposition') || '';
        const m = dispo.match(/filename\*?=(?:UTF-8'')?([^;]+)/i);
        if (m) { try { name = decodeURIComponent(m[1].replace(/["']/g, '')); } catch { name = m[1]; } }
        if (!name) name = decodeURIComponent((u.url.split('?')[0].split('/').pop() || '')) || body.title || 'ima-file';
        name = name.replace(/[\\/:*?"<>|]+/g, '_');
        if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += '.' + EXT(ct, u.url, body.title || '');

        return new Response(f.body, {
          headers: {
            'Content-Type': ct || 'application/octet-stream',
            'x-filename': encodeURIComponent(name),
            'x-content-type': ct,
            ...ch,
          },
        });
      }

      return json({ error: '未知路径 ' + path }, 404, ch);
    } catch (e) {
      return json({ error: e.message, msg: e.message }, 500, ch);
    }
  },
};
