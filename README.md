# 句读 · 挖空背诵

把课文变成挖空默写，用 FSRS 排期，数据只存在你自己的设备上。

手机浏览器打开 → 菜单里「添加到主屏幕」→ 就是一个 App。不需要注册、不需要账号、没有服务器。

## 功能

- **导入**：粘贴文本 / 上传 txt、md、pdf（PDF 走 pdf.js 提取文字）
- **自动分块**：按标题切节、按句号切句、超长句再按逗号切
- **挖空**：浏览器内置 `Intl.Segmenter` 分词 + 词性/词频打分，术语表优先命中；密度可调
- **背诵**：点空位显示/隐藏；也可以打字默写，自动判分（标点、全半角、容错距离）
- **排期**：FSRS-6（`ts-fsrs`，与 Anki 同源算法），按「忘了/模糊/会了」三档更新
- **统计**：连续天数、正确率、未来 7 天到期分布、遗忘最多的句子
- **备份**：一键导出 JSON，换设备导入还原

## 用的开源件

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) | FSRS-6 间隔重复调度 | MIT |
| [pdf.js](https://github.com/mozilla/pdf.js) | 浏览器内 PDF 文字提取 | Apache-2.0 |
| `Intl.Segmenter` | 中文分词（浏览器内置，零依赖） | 标准 API |

分块、挖空打分、判分容错、UI 是自己写的，代码在 `src/`。

## AI 挖空（可选，默认关闭）

默认走本地算法，不联网也能用。

想用大模型挖空时，需要在「设置」里填接口地址。**不能直接填 `https://api.deepseek.com/v1/chat/completions`**：浏览器跨域（CORS）会被拦。

建一个 Cloudflare Worker 当前转（免费额度够个人用）：

```js
export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization,content-type',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const body = await req.text();
    const upstream = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DS_KEY}` },
      body,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
```

把 Key 存在 Worker 的环境变量 `DS_KEY` 里（不要写进代码），然后在设置页填 Worker 地址。

AI 只会返回「原文中的哪一段该挖」，本地再用 `indexOf` 定位；定位失败的条目直接丢弃——模型改不了你的原文。

## 数据在哪

全部在浏览器的 IndexedDB 里，没有云端。清缓存、换手机、换域名 = 数据没了，所以「设置 → 导出备份」要定期点。

## 已知限制

- 扫描版 PDF 提不出文字（没有做 OCR）
- iOS 上 PWA 的后台与存储可能被系统回收，务必导出备份
- 语音督背（记录卡顿/错读）没做：网页端语音识别在国内不可用，要做只能上原生 App + 第三方 ASR
- 多设备不同步（自用单机定位）

## 自己跑起来

```bash
python3 -m http.server 8787
# 打开 http://localhost:8787
```

不需要构建，改 `src/` 里的文件刷新即生效。

自检：

```bash
node test/core.test.mjs   # 23 项：判分、分块、挖空、FSRS 单调性
node test/e2e.mjs         # 31 项：真浏览器全流程（需 playwright-core）
node test/pdf.mjs         # 7 项：中文 PDF 提取与布局
```
