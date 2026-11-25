# 句读 · 挖空背诵

把课文变成挖空默写，用 FSRS 排期，数据只存在你自己的设备上。
手机浏览器打开 → 添加到主屏幕 → 就是一个 App。不用注册、没有账号、没有后端存你的资料。

## 功能

**导入**
- 粘贴文本；上传 `pdf` / `docx` / `pptx` / `epub` / `txt` / `md` / `html`
- 从 **ima 知识库**直接挑文件导入（浏览目录、库内搜索）

**背诵**
- 自动分块：按标题切节、按句号切句、超长句再按逗号切
- 挖空：`Intl.Segmenter` 分词 + 词性/词频打分，**术语表整词优先命中**；密度可调
- 点空位显隐，或打字默写（判分容忍全角半角、标点、1–2 字笔误）
- AI 挖空（可选）：模型只返回"原文哪一段该挖"，本地 `indexOf` 定位，定位失败直接丢弃——模型改不了你的原文

**复习**
- FSRS-6（`ts-fsrs`，与 Anki 同源），三档评分
- 今日到期、连续天数、正确率、未来 7 天分布、遗忘最多的句子
- 一键导出 JSON 备份

## 用了哪些开源件

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) | FSRS-6 间隔重复调度 | MIT |
| [pdf.js](https://github.com/mozilla/pdf.js) | 浏览器内 PDF 文字提取 | Apache-2.0 |
| [fflate](https://github.com/101arrowz/fflate) | 解 docx / pptx / epub（zip + xml） | MIT |
| `Intl.Segmenter` | 中文分词（浏览器内置） | 标准 API |

分块、挖空打分、判分、界面是自己写的，在 `src/`。

## 中转服务（AI 与 ima 都需要）

浏览器**不能**直连这两家：

- ima 的 OpenAPI 预检响应头里没有 `ima-openapi-clientid`，也没有 `Access-Control-Allow-Origin`
- OpenAI 兼容接口不开放浏览器直连，且 Key 不能写进公开前端

所以需要一个中转。`server/worker.mjs` 是单文件 Cloudflare Worker，一次部署同时提供 AI 转发和 ima 读取：

```
dash.cloudflare.com → Workers → 粘贴 server/worker.mjs → 配置变量
```

必需的变量（详见 `server/README.md`）：`AI_BASE`、`AI_KEY`、`IMA_CID`、`IMA_KEY`、`ACCESS_TOKEN`。

部署后打开 `https://xxx.workers.dev/ping` 应返回 `{"ok":true,"ai":true,"ima":true}`，然后回句读「设置 → 中转服务」填地址与口令。

ima 的 Client ID / API Key 在 https://ima.qq.com/agent-interface 获取（仅用来读你自己账号下的知识库）。

## 数据在哪

全部在浏览器 IndexedDB 里，没有云端。清缓存、换手机、换域名 = 数据没了，所以「设置 → 导出备份」要定期点。

## 已知限制

- 扫描版 PDF、图片提不出文字（没做 OCR）
- 语音督背（记录卡顿/错读）没做：网页端语音识别在国内不可用，要做只能上原生 App + 第三方 ASR
- 多设备不同步（自用单机定位）
- 旧版 `.doc` / `.ppt` 不支持，请另存为新格式
- ima 的视频类条目拿不到正文

## 自己跑起来

```bash
python3 -m http.server 8787          # 前端，打开 http://localhost:8787
MOCK=1 node server/dev.mjs           # 中转服务（假数据，不需要 Key）
```

改 `src/` 后要重新打包：

```bash
./node_modules/.bin/esbuild src/app.js --bundle --minify --format=esm --outfile=dist/app.js --external:../vendor/pdf.min.mjs
```

自检：

```bash
node test/core.test.mjs   # 23 项：判分、分块、挖空、FSRS 单调性
node test/e2e.mjs         # 31 项：真浏览器全流程
node test/office.mjs      # 16 项：pdf / docx / pptx 导入
node test/ima.mjs         # 16 项：中转 + ima 浏览导入 + AI 幻觉丢弃（需 MOCK 服务）
node test/live.mjs        # 7 项：线上验证
```
