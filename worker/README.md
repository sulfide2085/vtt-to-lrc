# RJ 元数据中转 Worker

把 DLsite 的作品信息（标题 / 社团 / 声优 / 封面地址）转成网页能用的 JSON。

## 为什么需要它

| 事实（已实测） | 结果 |
| --- | --- |
| `https://www.dlsite.com/maniax/api/=/product.json?workno=RJ344794` | HTTP 200，返回作品 JSON，**不需要任何 key** |
| 该接口的响应头 | **没有任何 `access-control-*`**，带 `Origin` 请求也一样 → 浏览器直连必被 CORS 拦 |
| `img.dlsite.jp`（封面 CDN） | 返回 `Access-Control-Allow-Origin: *` → 封面图网页可以**直接抓**，不用中转 |
| 连发十几次请求 | 开始被丢连接（代理本身正常）→ 必须加缓存 |

所以这个 Worker 只做一件事：代取那个 JSON 并加上 CORS 头，附带 24 小时缓存。
封面图片不经过它（网页直接从 `img.dlsite.jp` 取），省流量也不增加延迟。

## 部署（约 2 分钟）

需要一个 Cloudflare 账号（免费注册：https://dash.cloudflare.com/sign-up ）。

```bash
cd worker
npx wrangler login      # 会打开浏览器授权，只需一次
npx wrangler deploy
```

部署成功后会打印形如下面的地址：

```
https://vtt-lrc-rj.<你的子域>.workers.dev
```

## 自测

```bash
curl "https://vtt-lrc-rj.<你的子域>.workers.dev/?rj=RJ344794"
```

正常应返回：

```json
{
  "ok": true,
  "rj": "RJ344794",
  "title": "絶対におま〇こさせてくれない口淫担当メイドさんのドスケベ淫語囁きフェラチオ",
  "circle": "...",
  "voiceBy": ["分倍河原シホ"],
  "genres": ["..."],
  "releaseDate": "2022-05-13",
  "coverUrl": "https://img.dlsite.jp/modpub/images2/work/doujin/RJ345000/RJ344794_img_main.jpg",
  "pageUrl": "https://www.dlsite.com/maniax/work/=/product_id/RJ344794.html"
}
```

第二次请求响应头里会出现 `X-RJ-Cache: HIT`，说明缓存生效。

## 把这个地址接到网页上

部署完成后，把地址填到 `app.js` 顶部的这一行，然后重新部署 GitHub Pages：

```js
let RJ_METADATA_ENDPOINT = 'https://vtt-lrc-rj.<你的子域>.workers.dev';
```

没填也不影响使用：页面会提示"识别到 RJ 号但未配置元数据服务"，封面仍然可以照常手动选择。

## 注意

- 接口是 DLsite 站内自用的 AJAX 接口，**不是官方公开文档化的 API**（官方对外的是需要注册审核的联盟 API）。请保持低频使用，缓存已经帮你挡掉大部分回源。
- 封面图的版权属于社团 / DLsite，写进 MP3 仅供个人整理使用，别再分发。
- Worker 的出口是 Cloudflare 的机房 IP。如果 DLsite 对机房 IP 有额外风控，可能会出现查不到的情况——真遇到了再换方案（比如改成带 KV 缓存 + 备用出口）。
