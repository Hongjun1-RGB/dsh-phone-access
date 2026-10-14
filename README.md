# dsh-phone-access

在 **DSH 界面里拨一个开关**，手机浏览器就能接着当前会话用 —— **同一个进程、同一个会话**，两端消息实时同步。

```
┌─────────┐   临时隧道      ┌──────────────┐         ┌─────────────┐
│  手机   │ ─────────────▶ │  本地代理    │ ──────▶ │  DSH 本体   │
│ 浏览器  │  trycloudflare  │ （插件内起） │ loopback│ （你正在用）│
└─────────┘                 └──────────────┘         └─────────────┘
```

## 它解决什么问题

想从外面访问家里的 DSH，通常卡在三件事上：

1. **绑不了 `0.0.0.0`** —— DSH 出于安全只允许 `127.0.0.1` / `0.0.0.0`，而后者会把「能执行任意命令的界面」暴露给整个局域网。
2. **`/api` 的 Host 信任栅栏** —— 只放行 loopback 或配置里声明过的域名，而隧道域名每次都是随机的，无法预先声明。
3. **主连接是 WebSocket** —— 普通反向代理不处理升级握手，界面会一直停在「重新连接中」。

本插件的做法：在本地起一个**只监听 `127.0.0.1`** 的微型反向代理，把转发给 DSH 的 `Host` 改写成 loopback（栅栏于是放行），剥掉 `Origin` / `Sec-Fetch-*`（避免被判为跨站），并**原样透传 WebSocket 升级**。DSH 始终只监听本机，不开任何入站端口。

## 界面

开关长在鲸鱼娘插件上（如果装了 [`dsh-whale-widget`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)）：

- 点鲸鱼娘的 ☰ 设置菜单 → 多一行 **「手机访问」**，带拨动开关；
- **点击后开关立刻到位并保持**，鲸鱼开始**转圈**表示加载；
- **彻底开好之后**鲸鱼身后亮起**圆形绿色呼吸光晕**；
- 没装鲸鱼插件时，回退成自带的小鲸鱼图标（可拖动）。

## 安装

```sh
dsh plugin add dsh-phone-access
```

装好后重启 DSH，开关即出现。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: phone-access
  config:
    # 已安装的 cloudflared 路径。留空则依次查找 PATH / 常见安装位置，都没有才下载
    cloudflaredPath: ''
    # 本地代理端口；被占用会自动顺延
    proxyPort: 19389
    # 主动更换隧道的间隔（分钟）。Cloudflare 免费快速隧道会被回收，默认 130
    rebuildMinutes: 130
    # 载入即开启。出于安全默认为 false
    autoStart: false
    # 新地址推送到微信；不填则只在界面里可用
    pushKind: ''        # serverchan | wxpusher | pushplus | webhook
    pushKey: ''
    pushCapPerDay: 8    # 每日推送上限，避免触发推送服务的风控
```

### 推送渠道

微信没有个人消息接口，只能经推送服务中转：

| pushKind | 说明 | 是否需实名 |
|---|---|---|
| `serverchan` | [Server酱](https://sct.ftqq.com/)，消息进微信服务号 | 否 |
| `wxpusher` | [WxPusher](https://wxpusher.zjiecode.com/)，扫码取 SPT | 否 |
| `pushplus` | pushplus，消息进微信 | **是** |
| `webhook` | 企业微信群机器人 Webhook 地址 | 否 |

## 顺带做的两件优化

- **静态资源缓存**：DSH 的 `/assets/*` 不带任何缓存头（无 `Cache-Control` / `ETag` / `Last-Modified`），而文件名里已含构建哈希。经隧道访问时，代理为它们补上一年强缓存 —— 否则手机每次打开都要重下约 **1.4MB**。图片/字体给一天缓存。
- **端口自动顺延**：默认端口被占用时自动换一个，不和机器上其它隧道/代理打架。

## 安全说明

请务必理解这个插件做了什么：

- **默认关闭**。只有你手动拨开，才会对外开洞。
- **DSH 仍只监听 `127.0.0.1`**。插件不改 DSH 的绑定，也不动防火墙；对外只有那一条隧道。
- **访问要过认证**。隧道后面是 DSH 自己的会话 cookie 校验；插件自己的路由同样校验 cookie（按 DSH 的规则验签），未登录一律 `401`。
- **cookie 由本机密钥签发**。签名密钥取自 `$DSH_HOME/.credentials.yaml`，**永不打包、永不上传**；隧道域名变了会重新签发。派生出来的会话 cookie 通过 `/__auth` 下发并跳回首页。
- **链接即权限**。拿到完整链接的人就能进入你的会话。别发群里、别贴截图、别提交进仓库。
- **隧道是临时的**。Cloudflare 免费快速隧道会被回收（实测几十分钟到数小时），插件会主动重建并推送新地址。

**如果你不接受「机器上存在一条通往你 DSH 的公网链路」，请不要启用它。**

## 兼容性

- DSH 核心 `0.2.0-rc.x`（用到 `webserver/index-inject` 与 `webServer.register`）。
- Node 20+（用到全局 `fetch`）。
- Windows / macOS / Linux；`cloudflared` 按平台自动选择资源。

## 工作原理（给想改的人）

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 插件主体：隧道管理、内嵌反向代理、微信推送、HTTP 路由 |
| `ui/ui.js` | 界面集成：鲸鱼娘光晕/转圈/菜单行，回退图标 |

HTTP 接口（均需会话 cookie）：

```
GET  /remote-access/state    当前状态
POST /remote-access/toggle   { on: boolean }
GET  /remote-access/ui.js    界面脚本
```

几点实现上的坑，写下来省得别人再踩：

1. **`webserver/index-inject` 的行里，`kind: 'script'` 的 `text` 会被当作内联 JS 代码**包进 `<script>…</script>`。直接传 `<script src=…>` 会变成嵌套 script，浏览器按内联脚本解析直接语法错误、什么都不会执行。正确做法是传一段内联 JS，由它去 `document.createElement('script')`（并兼顾 `document.body` 尚未就绪）。
2. **DSH 的主连接是 WebSocket**（`/api/remote.mux`）。代理必须处理 `upgrade` 并双向管道，否则界面永远停在「重新连接中」。
3. **`COOKIE_PREFIX` 是 `dsh-auth-`**，不是 `dsh-`。名字错了签名再对也验不过。
4. **加载中不要用 `transform: rotate()` 让元素转圈**，那会覆盖它自身的 `transform`。用 CSS 的 **`rotate` 属性**，两者可叠加。

## License

MIT

## 致谢

- 界面挂在 [dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT）上协同工作，但**不包含也不复制它的任何代码**。
- 隧道由 [cloudflared](https://github.com/cloudflare/cloudflared) 提供。
