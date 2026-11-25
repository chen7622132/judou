# 句读中转服务

浏览器不能直连 **ima OpenAPI**（预检头里没有 `ima-openapi-clientid`，也没有 `Access-Control-Allow-Origin`），也不能直连 OpenAI 兼容的 AI 接口（跨域 + Key 不能放前端）。

这个 Worker 一次解决两件事：**AI 挖空的转发** + **ima 知识库的读取**。

## 部署（Cloudflare Workers，免费额度足够）

1. 登录 https://dash.cloudflare.com → Workers & Pages → Create → Worker
2. 把 `worker.mjs` 全文粘进编辑器 → Deploy
3. 进 Settings → Variables and Secrets，添加：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AI_BASE` | AI 功能需要 | `https://api.deepseek.com/v1`（也支持智谱、通义、OpenAI） |
| `AI_KEY` | AI 功能需要 | 上游 Key，**选 Secret** |
| `AI_MODEL` | 可选 | `deepseek-chat` |
| `IMA_CID` | ima 功能需要 | 在 https://ima.qq.com/agent-interface 获取 |
| `IMA_KEY` | ima 功能需要 | 同上，**选 Secret** |
| `ACCESS_TOKEN` | 强烈建议 | 自定口令，防止别人白用你的额度，**选 Secret** |
| `ALLOW_ORIGIN` | 可选 | `https://chen7622132.github.io`；不填为 `*` |

4. 浏览器打开 `https://你的域名.workers.dev/ping`，应看到：
   ```json
   {"ok":true,"ai":true,"ima":true,"model":"deepseek-chat"}
   ```

5. 回到句读：设置 → 中转服务 → 填地址与口令 → 保存 → 测试连接。

## 本地调试

```bash
# 不消耗任何额度，用假数据把前端跑通
MOCK=1 node server/dev.mjs

# 真实转发
AI_KEY=sk-xxx IMA_CID=ima_xxx IMA_KEY=sk-xxx ACCESS_TOKEN=your-pass node server/dev.mjs
```

默认监听 `127.0.0.1:8790`，前端设置里填这个地址即可。

## 接口

| 路径 | 作用 |
| --- | --- |
| `GET /ping` | 返回 AI / ima 是否已配置（也用于校验口令） |
| `POST /ai` | 转发到 `${AI_BASE}/chat/completions`，注入 Key |
| `POST /ima/kb` | `search_knowledge_base`：列知识库 |
| `POST /ima/list` | `get_knowledge_list`：浏览目录（支持 folder） |
| `POST /ima/search` | `search_knowledge`：库里搜内容 |
| `POST /ima/file` | `get_media_info` → 下载文件 → 以二进制返回（笔记类型走 `note/get_doc_content` 取正文） |

所有 POST 都校验 `x-judou-token` 头（若配置了 `ACCESS_TOKEN`）。

## 安全

- Key 只在 Worker 的环境变量里，前端与页面源码都看不到。
- 前端只存「地址 + 口令」，即使页面公开，别人没有口令也用不了你的额度。
- 建议 `ALLOW_ORIGIN` 收窄到你自己的域名。
