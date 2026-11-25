/* 文件 → 纯文本。支持 pdf / docx / pptx / epub / txt / md / html */

let _pdf = null;
async function pdfjs() {
  if (_pdf) return _pdf;
  _pdf = await import('../vendor/pdf.min.mjs');
  _pdf.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  return _pdf;
}

/** PDF：按坐标把文本行重排，能处理大部分双栏与表格错序 */
export async function pdfToText(buf, onPage) {
  const pdfjsLib = await pdfjs();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
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
    if (onPage) onPage(p, doc.numPages);
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

const decodeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');

const stripTags = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '');

export function htmlToText(html) {
  return decodeXml(stripTags(html)).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** docx / pptx / epub：都是 zip + xml，解出文字 */
export async function ooxmlToText(buf, name) {
  const { unzipSync, strFromU8 } = await import('fflate');
  let zip;
  try { zip = unzipSync(buf); } catch (e) { throw new Error('文件解压失败，可能已损坏'); }
  const names = Object.keys(zip);

  if (name.endsWith('.docx')) {
    const entry = names.find((n) => n === 'word/document.xml');
    if (!entry) throw new Error('这不是有效的 docx');
    const xml = strFromU8(zip[entry]);
    const paras = xml.split('</w:p>').map((p) => {
      const t = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('');
      return decodeXml(t).trim();
    });
    return paras.filter(Boolean).join('\n');
  }

  if (name.endsWith('.pptx')) {
    const slides = names
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => +a.match(/slide(\d+)/)[1] - +b.match(/slide(\d+)/)[1]);
    if (!slides.length) throw new Error('这不是有效的 pptx');
    return slides.map((n, i) => {
      const xml = strFromU8(zip[n]);
      const lines = xml.split('</a:p>').map((p) => {
        const t = [...p.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join('');
        return decodeXml(t).trim();
      }).filter(Boolean);
      return `【第 ${i + 1} 页】\n${lines.join('\n')}`;
    }).join('\n\n');
  }

  if (name.endsWith('.epub')) {
    const pages = names.filter((n) => /\.(x?html?)$/i.test(n)).sort();
    if (!pages.length) throw new Error('这不是有效的 epub');
    return pages.map((n) => htmlToText(strFromU8(zip[n]))).filter((t) => t.length > 20).join('\n\n');
  }

  throw new Error('不支持的压缩格式');
}

/** 统一入口：{name, buffer:ArrayBuffer} → {text, kind} */
export async function extractText(file, onPage) {
  const name = (file.name || '').toLowerCase();
  const buf = file.buffer instanceof Uint8Array ? file.buffer : new Uint8Array(file.buffer);
  if (name.endsWith('.pdf')) return { text: await pdfToText(buf, onPage), kind: 'pdf' };
  if (/\.(docx|pptx|epub)$/.test(name)) return { text: await ooxmlToText(buf, name), kind: name.split('.').pop() };
  if (/\.(doc|ppt)$/.test(name)) throw new Error('旧版 Office 格式不支持，请另存为 .docx / .pptx');
  if (/\.(png|jpe?g|webp|gif|bmp)$/.test(name)) throw new Error('图片需要 OCR，暂不支持');
  const text = new TextDecoder('utf-8').decode(buf);
  if (/\.(html?|xhtml)$/.test(name)) return { text: htmlToText(text), kind: 'html' };
  return { text, kind: 'text' };
}
