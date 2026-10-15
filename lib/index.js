/**
 * dsh-remote-access —— 在 DSH 界面里一键开关的手机远程访问。
 *
 * 做什么：
 *   翻开关 → 在本地起一个微型反向代理 → 用 cloudflared 开一条临时隧道 →
 *   手机扫码/点链接即可打开【同一个】DSH 会话（与你桌面上看到的是同一个进程）。
 *
 * 为什么需要那个代理（而不是直接把 DSH 端口交给隧道）：
 *   1. DSH 的 /api 有 Host 信任栅栏，只接受 loopback 或配置里声明过的域名；
 *      隧道域名每次都是随机的，不可能预先声明。代理把转发给 DSH 的 Host
 *      改写成 127.0.0.1:<port>（loopback 天然被接受），并剥掉
 *      Origin / Referer / Sec-Fetch-*，避免被判成跨站请求。
 *   2. 浏览器还需要会话 cookie。DSH 的启动令牌只存在于进程内存里，取不到；
 *      但 cookie 的签名密钥是 .credentials.yaml 里的持久密钥，据此可以为
 *      loopback authority 现场签发一个，由 /__auth 下发后重定向到首页。
 *   3. DSH 的主连接是 WebSocket（/api/remote.mux），代理必须原样透传升级。
 *
 * 安全：开关默认关闭；只有显式打开后才会对外开洞。链接本身即凭证，
 * 请勿转发给他人。详见 README 的安全说明。
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'remote-access'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'remote-access')

const COOKIE_PREFIX = 'dsh-auth-'   // 必须与 dsh-client-connection 一致
const VERSION = '0.1.4'             // 与 package.json 保持一致；界面用它做缓存击穿

// ── 本机令牌：给"同机的其它程序"用的免 cookie 通道 ─────────────────────────
// 用途：微信桥（独立进程）要能把手机访问打开并拿到链接。它没有浏览器会话 cookie，
// 所以用一个落在本机文件里的随机令牌（0600，只有本机用户可读）来授权。
// 路由只监听 loopback，令牌泄露面 = 本机已被攻破，与 DSH 自身风险同级。
const LOCAL_TOKEN_FILE = path.join(DATA_DIR, 'local-token')
function localToken() {
  try {
    const t = fs.readFileSync(LOCAL_TOKEN_FILE, 'utf8').trim()
    if (t.length >= 16) return t
  } catch { }
  const t = crypto.randomBytes(24).toString('hex')
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(LOCAL_TOKEN_FILE, t, { mode: 0o600 })
    try { fs.chmodSync(LOCAL_TOKEN_FILE, 0o600) } catch { }
  } catch { }
  return t
}
const MAX_AGE = 30 * 86400

function log(...a) { try { console.log('[remote-access]', ...a) } catch { } }

const b64u = (b) => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// ── 运行时状态 ────────────────────────────────────────────────────────────
const state = {
  enabled: false,
  starting: false,
  url: null,
  host: null,
  startedAt: null,
  error: null,
  push: null,          // { ok, at, error }
  logs: [],
}
function note(msg) {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`
  state.logs.push(line)
  if (state.logs.length > 60) state.logs.shift()
  log(msg)
}

let proxyServer = null
let proxyPortActual = null
let cf = null
let rebuildTimer = null
let pushCount = { date: '', count: 0 }

// ── 工具：找或下载 cloudflared ────────────────────────────────────────────
function cloudflaredAsset() {
  const p = process.platform
  const a = process.arch
  if (p === 'win32') return { file: 'cloudflared.exe', url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' }
  if (p === 'darwin') return { file: 'cloudflared', url: a === 'arm64' ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz' : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz' }
  return { file: 'cloudflared', url: a === 'arm64' ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64' : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64' }
}

async function ensureCloudflared(config) {
  const { file, url } = cloudflaredAsset()

  // 依次尝试：显式配置 → 本插件数据目录 → PATH → 常见安装位置。
  // 用户机器上往往已经装过 cloudflared，没必要时重复下载 50MB+。
  const candidates = []
  if (config.cloudflaredPath) candidates.push(config.cloudflaredPath)
  candidates.push(path.join(DATA_DIR, file))
  try {
    const { execFileSync } = await import('node:child_process')
    const which = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(which, ['cloudflared'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of out.split(/\r?\n/)) if (line.trim()) candidates.push(line.trim())
  } catch { }
  if (process.platform === 'win32') {
    candidates.push(path.join(process.env.LOCALAPPDATA || '', 'cloudflared', 'cloudflared.exe'))
    candidates.push(path.join(process.env.ProgramFiles || '', 'cloudflared', 'cloudflared.exe'))
  } else {
    candidates.push('/usr/local/bin/cloudflared', '/usr/bin/cloudflared', '/opt/homebrew/bin/cloudflared')
  }
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c } catch { }
  }

  // 都没有才下载
  const dest = path.join(DATA_DIR, file)
  fs.mkdirSync(DATA_DIR, { recursive: true })
  note('未找到 cloudflared，正在下载（约 50MB，仅首次）…')
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载 cloudflared 失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (url.endsWith('.tgz')) {
    const tmp = path.join(DATA_DIR, 'cf.tgz')
    fs.writeFileSync(tmp, buf)
    const { execFileSync } = await import('node:child_process')
    execFileSync('tar', ['-xzf', tmp, '-C', DATA_DIR], { stdio: 'ignore' })
    fs.rmSync(tmp, { force: true })
    const extracted = path.join(DATA_DIR, 'cloudflared')
    if (!fs.existsSync(extracted)) throw new Error('解包 cloudflared 失败')
    fs.chmodSync(extracted, 0o755)
    return extracted
  }
  fs.writeFileSync(dest, buf)
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755)
  note(`cloudflared 已下载：${dest}`)
  return dest
}

// ── 内嵌反向代理 ──────────────────────────────────────────────────────────
// 密钥缓存：界面每隔几秒轮询一次 /state，若每次都同步读盘，就会在请求路径上
// 引入阻塞 I/O。该密钥是持久凭据，进程生命周期内不变，缓存是安全的。
let secretCache = null

function readSecret() {
  if (secretCache) return secretCache
  const file = path.join(DSH_HOME, '.credentials.yaml')
  const text = fs.readFileSync(file, 'utf8')
  const m = text.match(/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/)
  if (!m) throw new Error('读不到 browser-session 密钥（.credentials.yaml）')
  const raw = m[1]
  const key = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - raw.length % 4) % 4), 'base64')
  if (key.length !== 32) throw new Error(`密钥长度 ${key.length}，应为 32`)
  secretCache = key
  return key
}

function mintCookie(authority) {
  const key = readSecret()
  const now = Date.now()
  const body = b64u(Buffer.from(JSON.stringify({
    version: 1, authority, issuedAt: now, expiresAt: now + MAX_AGE * 1000,
  }), 'utf8'))
  const sig = b64u(crypto.createHmac('sha256', key).update(body).digest())
  const cname = COOKIE_PREFIX + b64u(crypto.createHash('sha256').update(authority).digest())
  return { name: cname, value: `v1.${body}.${sig}` }
}

/**
 * 校验请求是否携带 DSH 的有效会话 cookie。
 *
 * 为什么需要：插件自己的路由挂在 webServer 上，而 DSH 的信任栅栏只覆盖 /api，
 * 这些路由默认是"裸"的 —— 一旦开了隧道，任何人拿到链接就能调用（例如把开关关掉，
 * 或者读走当前地址）。这里按 DSH 同样的规则验签一遍，只放行已登录的浏览器。
 */
function requestAuthority(headers) {
  const host = headers && headers.host
  if (!host) return undefined
  try { return new URL(`http://${host}`).host } catch { return undefined }
}

function verifyCookie(req) {
  try {
    const authority = requestAuthority(req.headers)
    if (!authority) return false
    const raw = req.headers.cookie
    if (!raw) return false
    const cname = COOKIE_PREFIX + b64u(crypto.createHash('sha256').update(authority).digest())
    let value
    for (const seg of raw.split(';')) {
      const at = seg.indexOf('=')
      if (at === -1) continue
      if (seg.slice(0, at).trim() === cname) { value = seg.slice(at + 1).trim(); break }
    }
    if (!value) return false
    const parts = value.split('.')
    if (parts.length !== 3 || parts[0] !== 'v1') return false
    const b64d = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4), 'base64')
    const body = parts[1]
    const expected = crypto.createHmac('sha256', readSecret()).update(body).digest()
    const actual = b64d(parts[2])
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false
    const payload = JSON.parse(b64d(body).toString('utf8'))
    if (payload.authority !== authority) return false
    const now = Date.now()
    return payload.issuedAt <= now && payload.expiresAt > now
  } catch { return false }
}

function startProxy(listenPort, targetPort) {
  return new Promise((resolve, reject) => {
    const authority = `127.0.0.1:${targetPort}`
    let cookie
    try { cookie = mintCookie(authority) } catch (e) { return reject(e) }

    function rewriteHeaders(h) {
      const o = Object.assign({}, h)
      o.host = authority
      delete o.origin
      delete o.referer
      for (const k of Object.keys(o)) {
        const lk = k.toLowerCase()
        if (/^sec-fetch/i.test(lk) || lk === 'forwarded') delete o[k]
      }
      return o
    }

    const server = http.createServer((req, res) => {
      if (req.url === '/__auth' || req.url.startsWith('/__auth?')) {
        res.writeHead(302, {
          'Set-Cookie': `${cookie.name}=${cookie.value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}`,
          'Location': '/',
          'Cache-Control': 'no-store',
        })
        return res.end()
      }
      const up = http.request({
        host: '127.0.0.1', port: targetPort, method: req.method, path: req.url,
        headers: rewriteHeaders(req.headers),
      }, (ur) => {
        const headers = Object.assign({}, ur.headers)
        // DSH 的静态资源不带任何缓存头（无 Cache-Control / ETag / Last-Modified），
        // 而隧道带宽有限、首屏资源合计约 1.4MB。不缓存的话手机每次打开都要重下一遍。
        // 这里只对经隧道的成功响应补缓存头：
        //   /assets/  —— 文件名含构建哈希，内容不可变，可长期强缓存；
        //   其它图片/字体 —— 给一天的缓存，避免过肥。
        if (ur.statusCode === 200 && !/no-store/i.test(String(headers['cache-control'] || ''))) {
          const url = req.url || ''
          const ct = String(headers['content-type'] || '')
          if (/^\/assets\//.test(url)) {
            headers['cache-control'] = 'public, max-age=31536000, immutable'
          } else if (/^(image|font)\//.test(ct) || /\.(png|gif|jpe?g|svg|webp|ico|woff2?|ttf)$/i.test(url)) {
            headers['cache-control'] = 'public, max-age=86400'
          }
        }
        res.writeHead(ur.statusCode, headers)
        ur.pipe(res)
      })
      up.on('error', (e) => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' })
        res.end('proxy error: ' + e.message)
      })
      req.pipe(up)
    })

    // 主连接是 WebSocket，必须原样透传升级并双向管道
    server.on('upgrade', (req, socket, head) => {
      const up = http.request({
        host: '127.0.0.1', port: targetPort, method: req.method, path: req.url,
        headers: rewriteHeaders(req.headers),
      })
      up.on('upgrade', (ures, usocket, uhead) => {
        let raw = `HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}\r\n`
        for (let i = 0; i < ures.rawHeaders.length; i += 2) raw += `${ures.rawHeaders[i]}: ${ures.rawHeaders[i + 1]}\r\n`
        socket.write(raw + '\r\n')
        if (uhead && uhead.length) socket.write(uhead)
        usocket.pipe(socket)
        socket.pipe(usocket)
        usocket.on('error', () => { try { socket.destroy() } catch { } })
        socket.on('error', () => { try { usocket.destroy() } catch { } })
        usocket.on('close', () => { try { socket.destroy() } catch { } })
        socket.on('close', () => { try { usocket.destroy() } catch { } })
      })
      up.on('response', (ur) => {
        let raw = `HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}\r\n`
        for (let i = 0; i < ur.rawHeaders.length; i += 2) raw += `${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}\r\n`
        socket.write(raw + '\r\n')
        ur.pipe(socket)
      })
      up.on('error', () => { try { socket.destroy() } catch { } })
      if (head && head.length) up.write(head)
      up.end()
    })

    server.on('clientError', (e, s) => { try { s.destroy() } catch { } })

    // 端口被占用时顺延（用户机器上可能已有别的隧道/代理占着默认端口）
    let attempt = 0
    const tryListen = (port) => {
      server.listen(port, '127.0.0.1')
    }
    server.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE' && attempt < 15) {
        attempt += 1
        setTimeout(() => tryListen(listenPort + attempt), 60)
      } else {
        reject(e)
      }
    })
    server.on('listening', () => {
      const actual = server.address().port
      if (actual !== listenPort) note(`端口 ${listenPort} 被占用，改用 ${actual}`)
      note(`代理已就绪 127.0.0.1:${actual} -> ${authority}`)
      resolve({ server, port: actual })
    })
    tryListen(listenPort)
  })
}

// ── 隧道 ──────────────────────────────────────────────────────────────────
// 被代理软件拦住时的提示语。实测：Clash 开 TUN 模式会把去 Cloudflare 边缘的
// IP 劫持成 fake-IP（198.18.0.0/15），cloudflared 报
// "TLS handshake with edge error: EOF"，永远注册不上，也无从自愈。
const PROXY_HINT = '连不上 Cloudflare 边缘（TLS 握手失败）。若你开着 Clash / v2ray 等代理软件的 '
  + 'TUN 模式（虚拟网卡），它会劫持去 Cloudflare 的流量导致握手失败 —— 请关闭 TUN 模式后重试。'

function startTunnel(bin, proxyPort) {
  return new Promise((resolve, reject) => {
    const args = ['tunnel', '--url', `http://127.0.0.1:${proxyPort}`, '--no-autoupdate', '--protocol', 'http2']
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let buf = ''
    let settled = false

    // 代理软件（Clash 的 TUN 模式等）会把 Cloudflare 边缘的 IP 劫持成 fake-IP
    // （198.18.0.0/15），TLS 握手直接 EOF。这种情况 90 秒也等不来结果，
    // 与其让用户对着转圈发呆，不如尽早失败并说清原因。
    let edgeFails = 0
    const failFastMs = 30000
    const fastTimer = setTimeout(() => {
      if (!settled && edgeFails >= 3) {
        settled = true
        clearTimeout(timer); clearTimeout(fastTimer)
        try { child.kill() } catch { }
        reject(new Error(PROXY_HINT))
      }
    }, failFastMs)

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        clearTimeout(fastTimer)
        try { child.kill() } catch { }
        reject(new Error(edgeFails >= 1 ? PROXY_HINT : '隧道 90 秒内未建立'))
      }
    }, 90000)

    const onData = (d) => {
      buf += d.toString()
      if (/TLS handshake with edge error/.test(buf)) edgeFails = (buf.match(/TLS handshake with edge error/g) || []).length
      const m = buf.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/)
      const reg = /Registered tunnel connection/.test(buf)
      if (m && reg && !settled) {
        settled = true
        clearTimeout(timer); clearTimeout(fastTimer)
        resolve({ child, host: m[1] })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(fastTimer); reject(e) } })
    child.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(fastTimer); reject(new Error(`cloudflared 退出，code=${code}`)) } })
  })
}

// ── 微信推送 ──────────────────────────────────────────────────────────────
// 推送配置有两个来源，**cordis 配置优先**（已经写在 profile 里的不受影响），
// 其次是界面里填的，落在 DATA_DIR/config.json，权限收紧到 0600。
//
// 无论来自哪个来源，密钥**都不会出现在任何接口的响应里** —— 只回掩码。
// 掩码是单向展示用的，接口不提供任何取回原文的途径。
let uiConfigCache = null
function uiConfigFile() { return path.join(DATA_DIR, 'config.json') }

function readUiConfig() {
  if (uiConfigCache) return uiConfigCache
  let out = { pushKind: '', pushKey: '', pushCapPerDay: 8 }
  try {
    const j = JSON.parse(fs.readFileSync(uiConfigFile(), 'utf8'))
    out = {
      pushKind: typeof j.pushKind === 'string' ? j.pushKind : '',
      pushKey: typeof j.pushKey === 'string' ? j.pushKey : '',
      pushCapPerDay: Number.isFinite(Number(j.pushCapPerDay)) ? Number(j.pushCapPerDay) : 8,
    }
  } catch { }
  uiConfigCache = out
  return out
}

function writeUiConfig(patch) {
  const cur = readUiConfig()
  const next = {
    pushKind: patch.pushKind !== undefined ? String(patch.pushKind || '').trim() : cur.pushKind,
    pushKey: patch.pushKey !== undefined ? String(patch.pushKey || '').trim() : cur.pushKey,
    pushCapPerDay: patch.pushCapPerDay !== undefined ? (Number(patch.pushCapPerDay) || 8) : cur.pushCapPerDay,
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(uiConfigFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  try { fs.chmodSync(uiConfigFile(), 0o600) } catch { }
  uiConfigCache = next
  return next
}

/** 合并两个来源：cordis 配置 > 界面配置 */
function mergedConfig(config) {
  const ui = readUiConfig()
  return {
    pushKind: String((config || {}).pushKind || '').trim() || ui.pushKind || '',
    pushKey: String((config || {}).pushKey || '').trim() || ui.pushKey || '',
    pushCapPerDay: Number((config || {}).pushCapPerDay || 0) || ui.pushCapPerDay || 8,
  }
}

function pushConfigOf(config) {
  const m = mergedConfig(config)
  const kind = String(m.pushKind || '').trim()
  const key = String(m.pushKey || '').trim()
  if (!kind || !key) return null
  return { kind, key, cap: Number(m.pushCapPerDay || 8) }
}

/** 掩码：只露头 4 尾 3。单向展示，无法据此还原原文。 */
function maskKey(k) {
  const s = String(k || '')
  if (!s) return ''
  if (s.length <= 8) return '*'.repeat(s.length)
  return s.slice(0, 4) + '*'.repeat(Math.min(8, s.length - 7)) + s.slice(-3)
}

/** 给界面用的状态：只有掩码，没有原文 */
function pushStatus(config) {
  const m = mergedConfig(config)
  const fromCordis = !!String((config || {}).pushKey || '').trim()
  const ui = readUiConfig()
  return {
    kind: m.pushKind || '',
    cap: Number(m.pushCapPerDay) || 8,
    keySet: !!String(m.pushKey || '').trim(),
    keyMasked: maskKey(m.pushKey),
    source: fromCordis ? 'config' : (ui.pushKey ? 'ui' : 'none'),
    kinds: ['serverchan', 'wxpusher', 'pushplus', 'webhook'],
  }
}

function pushCountFile() { return path.join(DATA_DIR, 'push-count.json') }
function loadPushCount() {
  try {
    const j = JSON.parse(fs.readFileSync(pushCountFile(), 'utf8'))
    pushCount = { date: String(j.date || ''), count: Number(j.count || 0) }
  } catch { pushCount = { date: '', count: 0 } }
}
function savePushCount() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(pushCountFile(), JSON.stringify(pushCount))
  } catch { }
}

/** 只负责把一条消息发出去，不碰每日计数。测试推送也走它。 */
async function sendPush(cfg, title, body) {
  if (cfg.kind === 'serverchan') {
    const r = await fetch(`https://sctapi.ftqq.com/${cfg.key}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title, desp: body }).toString(),
    })
    const j = await r.json().catch(() => ({}))
    if (j.code !== 0) throw new Error(`Server酱返回 ${JSON.stringify(j).slice(0, 120)}`)
  } else if (cfg.kind === 'wxpusher') {
    const r = await fetch(`https://wxpusher.zjiecode.com/api/send/message/${cfg.key}/${encodeURIComponent(body)}`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  } else if (cfg.kind === 'pushplus') {
    const r = await fetch('https://www.pushplus.plus/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cfg.key, title, content: body }),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  } else if (cfg.kind === 'webhook') {
    const r = await fetch(cfg.key, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: `${title}\n${body}` } }),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  } else {
    throw new Error(`未知的推送类型 ${cfg.kind}`)
  }
  return { ok: true }
}

async function pushUrl(config, url) {
  const cfg = pushConfigOf(config)
  if (!cfg) return { skipped: '未配置推送' }
  const today = new Date().toISOString().slice(0, 10)
  if (pushCount.date !== today) pushCount = { date: today, count: 0 }
  if (pushCount.count >= cfg.cap) return { skipped: `今日已达上限 ${cfg.cap} 条` }

  const title = 'DSH 手机访问地址'
  const body = `手机打开这个链接即可继续对话：\n${url}`
  try {
    const r = await sendPush(cfg, title, body)
    if (r.ok) { pushCount.count += 1; savePushCount() }
    return r
  } catch (e) {
    return { error: String(e && e.message || e) }
  }
}

// ── 启停 ──────────────────────────────────────────────────────────────────
async function stopAll() {
  if (rebuildTimer) { clearInterval(rebuildTimer); rebuildTimer = null }
  if (cf) { try { cf.kill() } catch { } cf = null }
  if (proxyServer) {
    await new Promise((r) => proxyServer.close(() => r()))
    proxyServer = null
  }
  proxyPortActual = null
  state.enabled = false
  state.url = null
  state.host = null
  state.startedAt = null
  note('已停止远程访问')
}

async function startAll(config, dshPort) {
  if (state.enabled || state.starting) return
  state.starting = true
  state.error = null
  try {
    const bin = await ensureCloudflared(config)
    const proxyPort = Number(config.proxyPort || 19389)
    if (proxyServer) { await new Promise((r) => proxyServer.close(() => r())); proxyServer = null }
    const ps = await startProxy(proxyPort, dshPort)
    proxyServer = ps.server
    proxyPortActual = ps.port
    const { child, host } = await startTunnel(bin, proxyPortActual)
    cf = child
    child.on('exit', () => {
      if (state.enabled) note('隧道进程退出，等待自动重建')
    })

    state.enabled = true
    state.host = host
    state.url = `https://${host}/__auth`
    state.startedAt = Date.now()

    const pr = await pushUrl(config, state.url)
    state.push = { at: Date.now(), ...pr }

    const rebuildMs = Math.max(10, Number(config.rebuildMinutes || 130)) * 60000
    rebuildTimer = setInterval(async () => {
      if (!state.enabled) return
      note('主动更换隧道（避免被回收）')
      await restartTunnel(config, dshPort)
    }, rebuildMs)
  } catch (e) {
    state.error = String(e && e.message || e)
    note('启动失败：' + state.error)
    await stopAll()
  } finally {
    state.starting = false
  }
}

async function restartTunnel(config, dshPort) {
  if (cf) { try { cf.kill() } catch { } cf = null }
  try {
    const bin = await ensureCloudflared(config)
    const proxyPort = Number(config.proxyPort || 19389)
    if (!proxyServer) {
      const ps = await startProxy(proxyPort, dshPort)
      proxyServer = ps.server
      proxyPortActual = ps.port
    }
    const { child, host } = await startTunnel(bin, proxyPortActual)
    cf = child
    state.host = host
    state.url = `https://${host}/__auth`
    state.startedAt = Date.now()
    const pr = await pushUrl(config, state.url)
    state.push = { at: Date.now(), ...pr }
    note('新地址：' + state.url)
  } catch (e) {
    state.error = String(e && e.message || e)
    note('重建失败：' + state.error)
  }
}

// ── 插件主体 ──────────────────────────────────────────────────────────────
export function apply(ctx, config = {}) {
  loadPushCount()
  // 令牌文件必须**加载时就存在**：微信桥是先读文件再发请求，晚一步它第一次就会失败
  localToken()

  // ① 尽早订阅：桌面端在宿主就绪时收集一次注入表。
  //
  // ⚠️ `kind: 'script'` 的 `text` 会被当作**内联 JS 代码**渲染成 `<script>text</script>`，
  //    而不是原始 HTML。所以这里不能直接写 `<script src=...>` —— 那会变成嵌套的
  //    `<script><script src=...></script></script>`，浏览器按内联脚本解析会直接语法错误，
  //    结果什么都不执行（实测踩过）。正确做法是用一段内联 JS 动态创建 script 元素，
  //    并兼容 body 尚未就绪的情况。
  //
  //    URL 带版本号做缓存击穿：ui.js 是页面加载时才拉的，改了它必须让浏览器重新取，
  //    否则看到的永远是旧界面（实测踩过）。
  const UI_LOADER = '(function(){try{var d=document.body||document.head||document.documentElement;'
    + 'if(!d)return;var s=document.createElement("script");s.src="/remote-access/ui.js?v=' + VERSION + '";'
    + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'
  ctx.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      const has = table.some((r) => r && typeof r.text === 'string' && r.text.includes('/remote-access/ui.js'))
      if (!has) table.push({ kind: 'script', placement: 'body', text: UI_LOADER })
    } catch (e) { log('index-inject 失败', e) }
  })

  // ② 其余逻辑等服务就绪
  ctx.inject(['webServer'], (wctx) => {
    const dshPort = wctx.webServer.port
    note(`已挂载，DSH 端口 ${dshPort}`)

    const route = (p, handler) => wctx.effect(() => wctx.webServer.register({ kind: 'exact', path: p, handler }))

    route('/remote-access/state', (req, res) => {
      if (!verifyCookie(req)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('unauthorized') }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({
        ok: true,
        enabled: state.enabled,
        starting: state.starting,
        url: state.url,
        host: state.host,
        startedAt: state.startedAt,
        error: state.error,
        push: state.push,
        pushConfigured: !!pushConfigOf(config),
        logs: state.logs.slice(-20),
        version: VERSION,
      }))
    })

    route('/remote-access/toggle', async (req, res) => {
      if (!verifyCookie(req)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('unauthorized') }
      let body = ''
      for await (const c of req) body += c
      let on = false
      try { on = !!JSON.parse(body || '{}').on } catch { }
      if (on) await startAll(config, dshPort)
      else await stopAll()
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, enabled: state.enabled, url: state.url, error: state.error }))
    })

    route('/remote-access/ui.js', (req, res) => {
      try {
        const js = fs.readFileSync(path.join(PKG_ROOT, 'ui', 'ui.js'), 'utf8')
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(js)
      } catch (e) {
        res.writeHead(500); res.end('// ui.js 读取失败: ' + e.message)
      }
    })

    // ── 推送配置（界面里填，免去手改 YAML）────────────────────────────────
    // 注意：GET 只回**掩码**，任何情况下都不把密钥原文交出去。
    const json = (res, obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(obj))
    }
    const readBody = async (req) => {
      let b = ''
      for await (const c of req) b += c
      try { return JSON.parse(b || '{}') } catch { return {} }
    }

    route('/remote-access/push-config', async (req, res) => {
      if (!verifyCookie(req)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('unauthorized') }

      if (req.method === 'GET') return json(res, { ...pushStatus(config), version: VERSION })
      if (req.method !== 'POST') { res.writeHead(405); return res.end() }

      const p = await readBody(req)
      const patch = {}
      if (p.kind !== undefined) patch.pushKind = String(p.kind || '').trim()
      if (p.cap !== undefined) patch.pushCapPerDay = Number(p.cap) || 8
      if (p.clear === true) patch.pushKey = ''                        // 显式清除
      else if (String(p.key || '').trim() !== '') patch.pushKey = String(p.key).trim()

      if (patch.pushKind !== undefined && patch.pushKind &&
          pushStatus(config).kinds.indexOf(patch.pushKind) < 0) {
        return json(res, { ok: false, error: `不支持的推送类型 ${patch.pushKind}` }, 400)
      }
      writeUiConfig(patch)
      note('推送配置已更新')
      return json(res, { ok: true, ...pushStatus(config) })
    })

    // 用表单里**尚未保存**的值测试，方便用户先验证 key 对不对
    route('/remote-access/push-test', async (req, res) => {
      if (!verifyCookie(req)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('unauthorized') }
      if (req.method !== 'POST') { res.writeHead(405); return res.end() }

      const p = await readBody(req)
      const saved = mergedConfig(config)
      const cfg = {
        kind: String(p.kind || '').trim() || saved.pushKind,
        key: String(p.key || '').trim() || saved.pushKey,
      }
      if (!cfg.kind || !cfg.key) return json(res, { ok: false, error: '请先选择推送方式并填写密钥' }, 400)

      try {
        await sendPush(cfg, 'DSH 手机访问 · 推送测试',
          '收到这条说明推送配置正确。手机访问开启时，新地址会自动发到这里。')
        return json(res, { ok: true, message: '测试消息已发出，请查看微信' })
      } catch (e) {
        return json(res, { ok: false, error: String(e && e.message || e) })
      }
    })

    // ── 本机令牌路由 ────────────────────────────────────────────────────────
    //
    // 给**同机的其它程序**用（目前是微信桥）：它没有浏览器会话 cookie，
    // 所以改用 ~/.dsh/remote-access/local-token（0600）来授权。
    // 只监听 loopback；能读到该文件 = 已经能读你本机，风险与 DSH 自身同级。
    //
    //   GET  /remote-access/local?action=status|open|close
    //   POST /remote-access/local   { "action": "open" }
    route('/remote-access/local', async (req, res) => {
      const token = String(req.headers['x-dsh-local-token'] || '')
      if (!token || token !== localToken()) {
        res.writeHead(401, { 'Content-Type': 'text/plain' })
        return res.end('unauthorized')
      }
      let action = 'status'
      if (req.method === 'POST') {
        const p = await readBody(req)
        action = String(p.action || 'status')
      } else {
        const m = String(req.url || '').match(/[?&]action=([^&]+)/)
        if (m) action = decodeURIComponent(m[1])
      }
      try {
        return json(res, await runPhoneAccess(action))
      } catch (e) {
        return json(res, { ok: false, enabled: state.enabled, message: String(e && e.message || e) }, 500)
      }
    })

    // 打开时若配置要求自动启动
    if (config.autoStart) {
      startAll(config, dshPort).catch(() => { })
    }
  })

  // ③ 给 agent 一个工具
  //
  // 这一步是为了**微信桥**这类场景：你在微信里说一句「给我手机访问的链接」，
  // 桥把话转给 agent，agent 调这个工具拿到地址再回给你 ——
  // 两个插件各干各的，谁也不用改对方的代码。
  //
  // defineTool 用动态 import 取（apply 不是 async，所以走 Promise 链），
  // 拿不到就用恒等函数兜底：宿主没提供 @deepseek-ai/dsh-tools 时本插件也不会加载失败。
  // 动作实现**只写一份**：agent 工具和本机令牌路由共用，避免两处逻辑漂移。
  async function runPhoneAccess(action) {
    const act = String(action || 'status').toLowerCase()

    if (act === 'close') {
      await stopAll()
      return { ok: true, enabled: false, message: '已关闭手机远程访问。' }
    }

    if (act === 'status') {
      if (state.enabled && state.url) {
        return { ok: true, enabled: true, url: state.url, message: '手机访问已开启，链接：' }
      }
      if (state.starting) return { ok: true, enabled: false, message: '手机访问正在开启中，稍等再问一次。' }
      return { ok: true, enabled: false, message: '手机访问当前是关闭的。需要的话我可以帮你打开。' }
    }

    if (act !== 'open') {
      return { ok: false, enabled: state.enabled, message: `不认识的 action「${act}」，可用：status / open / close。` }
    }

    if (state.enabled && state.url) {
      return { ok: true, enabled: true, url: state.url, message: '手机访问已经开着，链接：' }
    }
    if (state.starting) {
      return { ok: false, enabled: false, message: '上一次开启还在进行中，请稍等十几秒再试。' }
    }

    const w = ctx.get('webServer')
    const dshPort = w && w.port
    if (!dshPort) return { ok: false, enabled: false, message: '拿不到 DSH 端口，无法开启。' }

    await startAll(config, dshPort)
    if (state.enabled && state.url) {
      const extra = state.push && state.push.ok ? '（已同时推到微信）' : ''
      return { ok: true, enabled: true, url: state.url, message: `手机访问已开启${extra}，链接：` }
    }
    return { ok: false, enabled: false, message: `开启失败：${state.error || '未知原因'}` }
  }

  const PHONE_ACCESS_TOOL = {
    name: 'phone_access',
    description: '管理 DSH 的手机远程访问隧道。开启后会得到一个可在手机浏览器打开的链接，'
      + '它指向**同一个会话**（电脑和手机看到的对话是同一份）。'
      + '当用户说「给我手机访问的链接」「我要在外面用手机继续」时，用 action="open" 拿到链接回复给他；'
      + '只想查当前状态用 action="status"；用完想关掉用 action="close"。'
      + '开启通常需要 10-30 秒（要建立隧道）。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'status = 只查询当前状态和链接；open = 开启（已开着就直接返回链接）；close = 关闭。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          enabled: { type: 'boolean', required: true },
          url: { type: 'string' },
          message: { type: 'string', required: true },
        },
      },
      render: (args, v) => [{ type: 'text', text: v.message + (v.url ? '\n' + v.url : '') }],
    },
    isConcurrencySafe: () => false,   // 会起隧道/改状态，同一任务内串行
    timeoutMs: 120000,
    async execute(args) {
      return runPhoneAccess(args.action)
    },
  }

  ctx.inject(['tools'], (tctx) => {
    if (!tctx.tools || typeof tctx.tools.register !== 'function') return
    const register = (defineTool) => {
      try {
        tctx.tools.register(defineTool(PHONE_ACCESS_TOOL))
        note('已注册 phone_access 工具')
      } catch (e) {
        note('注册 phone_access 工具失败：' + (e && e.message || e))
      }
    }
    import('@deepseek-ai/dsh-tools')
      .then((m) => register(m && typeof m.defineTool === 'function' ? m.defineTool : (o) => o))
      .catch(() => register((o) => o))
  })

  ctx.effect(() => () => { stopAll().catch(() => { }) })
}
