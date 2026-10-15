/**
 * dsh-phone-access —— 界面集成层。
 *
 * 把开关直接长在已有的鲸鱼娘插件上，不另造一只鲸鱼：
 *   1. 开启时鲸鱼身后有**圆形光晕**（呼吸绿光）——用独立圆形元素，而不是
 *      drop-shadow，因为 drop-shadow 会跟着鲸鱼轮廓走，光晕不圆；
 *   2. 加载中鲸鱼**转圈**——用 CSS `rotate` 属性而非 `transform:rotate()`，
 *      这样能和鲸鱼自身的 transform（缩放/翻转）叠加，不会把它顶掉；
 *   3. 点按键**立刻**切换外观（乐观更新），失败再回滚；
 *   4. 往鲸鱼的设置菜单（☰）里加一行「手机访问」开关；
 *   5. 没装鲸鱼插件时回退成自带的小鲸鱼。
 *
 * 鲸鱼在普通 DOM 里渲染（无 Shadow DOM），类名前缀 `dshwv-`，可直接查询与加样式。
 *
 * 后端接口：
 *   GET  /remote-access/state    当前状态（需会话 cookie）
 *   POST /remote-access/toggle   { on: boolean }
 */
(() => {
  if (window.__DSH_PHONE_ACCESS__) return
  window.__DSH_PHONE_ACCESS__ = true

  const API = '/remote-access'
  const KEY_POS = 'dsh-phone-access.pos'

  let cur = null
  let busy = false
  let timer = null
  // 非 null 表示正在朝这个目标切换：加载期间开关就按它显示，不被轮询拨回
  let pendingOn = null

  // ── 样式 ────────────────────────────────────────────────────────────────
  const style = document.createElement('style')
  style.id = 'dsh-phone-access-style'
  style.textContent = `
    /* 圆形光晕：独立元素 + 径向渐变，保证是正圆，不受鲸鱼轮廓影响 */
    .pa-halo {
      position:absolute; pointer-events:none; border-radius:50%;
      opacity:0; transition:opacity .3s ease; z-index:0;
      background: radial-gradient(circle,
        rgba(34,197,94,.95) 0%,
        rgba(34,197,94,.55) 42%,
        rgba(34,197,94,0) 72%);
      filter: blur(3px);
    }
    .dshwv-root.pa-on .pa-halo { opacity:1; animation: paPulse 1.9s ease-in-out infinite; }
    @keyframes paPulse {
      0%,100% { transform: scale(.86); opacity:.72; }
      50%     { transform: scale(1.12); opacity:1; }
    }
    /* 加载中：鲸鱼转圈。用 rotate 属性，与鲸鱼自己的 transform 叠加而非覆盖 */
    .dshwv-root.pa-busy .dshwv-img { animation: paSpin 1s linear infinite; }
    @keyframes paSpin { to { rotate: 360deg; } }

    .pa-row { display:flex; align-items:center; gap:8px; margin:5px 0;
              color:#203170; font-size:12px; white-space:nowrap;
              font-family: system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
    .pa-row .pa-lbl { flex:1; }
    .pa-sw { position:relative; width:38px; height:20px; flex:0 0 auto; border-radius:99px;
             background:#9ca3af; cursor:pointer; border:0; padding:0; transition:background .15s; }
    .pa-sw.pa-on { background:#22c55e; }
    .pa-sw::after { content:''; position:absolute; top:3px; left:3px; width:14px; height:14px;
                    border-radius:50%; background:#fff; transition:transform .15s; }
    .pa-sw.pa-on::after { transform:translateX(18px); }
    .pa-sw[disabled] { opacity:.5; cursor:default; }

    #dsh-phone-access-host { position:fixed; z-index:2147482000; }
    #dsh-phone-access-host .pa-fab { width:56px; height:56px; cursor:pointer; user-select:none;
        display:flex; align-items:center; justify-content:center; position:relative;
        filter:grayscale(.35) opacity(.72); transition:transform .12s ease, filter .25s ease; }
    #dsh-phone-access-host .pa-fab:active { transform:scale(.86); }
    #dsh-phone-access-host .pa-fab.pa-on { filter:grayscale(0) opacity(1); }
    #dsh-phone-access-host .pa-fab.pa-busy img { animation: paSpin 1s linear infinite; }
    #dsh-phone-access-host .pa-fab img { width:100%; height:100%; object-fit:contain;
        pointer-events:none; position:relative; z-index:1; }
    #dsh-phone-access-host .pa-halo { left:-14%; top:-14%; width:128%; height:128%; }
    #dsh-phone-access-host .pa-toast { position:absolute; left:50%; transform:translateX(-50%);
        bottom:100%; margin-bottom:6px; white-space:nowrap; background:#fff; color:#1f2328;
        border:1px solid #e5e7eb; border-radius:8px; padding:4px 9px; font-size:12px;
        font-family: system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
        box-shadow:0 4px 14px rgba(0,0,0,.14); opacity:0; pointer-events:none; transition:opacity .18s; }
    #dsh-phone-access-host .pa-toast.show { opacity:1; }
    #dsh-phone-access-host .pa-toast.pa-err { color:#dc2626; }

    /* 菜单行里的小齿轮 */
    .pa-gear { flex:0 0 auto; width:20px; height:20px; border:0; background:transparent; cursor:pointer;
               color:#203170; opacity:.55; font-size:13px; line-height:1; padding:0; border-radius:5px; }
    .pa-gear:hover { opacity:1; background:rgba(32,49,112,.1); }

    /* 微信连接那一行的状态点 */
    .pa-wx-dot { flex:0 0 auto; width:8px; height:8px; border-radius:50%;
                 background:#c4c9d4; transition:background .2s; }
    .pa-wx-dot.on { background:#22c55e; box-shadow:0 0 0 3px rgba(34,197,94,.18); }
    .pa-wx-dot.wait { background:#f59e0b; box-shadow:0 0 0 3px rgba(245,158,11,.18); }

    /* 注意：推送设置面板的样式**不在这里**。
       它挂在 Shadow DOM 里，而 Shadow DOM 会隔离外部样式 —— 写在这儿一条都进不去。
       那些规则放在 buildConfigPanel() 内部的 <style> 里。 */
  `
  ;(document.head || document.documentElement).appendChild(style)

  function say(text, isErr) {
    const t = document.querySelector('#dsh-phone-access-host .pa-toast')
    if (!t) { try { console.log('[phone-access]', text) } catch { } return }
    t.textContent = text
    t.classList.toggle('pa-err', !!isErr)
    t.classList.add('show')
    clearTimeout(say._t)
    say._t = setTimeout(() => t.classList.remove('show'), 2600)
  }

  // ── 给鲸鱼挂一个正圆光晕 ─────────────────────────────────────────────────
  // 关键：光晕必须和图片处在**同一个定位上下文**里，并且用**布局坐标**定位。
  //
  // 鲸鱼移到左边时，根元素会加上 `.dshwv-left { transform: scaleX(-1) }` 做水平镜像。
  // 若用 getBoundingClientRect()（屏幕坐标，已被镜像）去设局部的 left/top，
  // 两个坐标系左右相反，光晕就会歪 —— 实测踩过。
  // 改用 offsetLeft/offsetTop（不受 transform 影响），并把光晕插进图片的父元素，
  // 这样镜像、缩放、呼吸动画都会和图片完全同步。
  let haloEl = null
  let haloAnchor = null

  function offsetWithin(el, ancestor) {
    let x = 0, y = 0, n = el
    while (n && n !== ancestor) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent }
    return n === ancestor ? { x, y } : null
  }

  function ensureHalo() {
    const root = document.querySelector('.dshwv-root')
    if (!root) return null
    const img = root.querySelector('.dshwv-img')
    if (!img || !img.offsetWidth) return null

    const parent = img.parentElement || root
    const anchor = getComputedStyle(parent).position === 'static' ? root : parent
    const off = offsetWithin(img, anchor)
    if (!off) return null

    if (haloEl && (!haloEl.isConnected || haloAnchor !== anchor)) {
      try { haloEl.remove() } catch { }
      haloEl = null
    }
    if (!haloEl) {
      haloEl = document.createElement('div')
      haloEl.className = 'pa-halo'
      haloAnchor = anchor
    }
    if (haloEl.parentNode !== anchor || anchor.firstChild !== haloEl) {
      anchor.insertBefore(haloEl, anchor.firstChild)
    }

    const w = img.offsetWidth, h = img.offsetHeight
    const pad = Math.max(6, Math.round(w * 0.10))
    haloEl.style.width = (w + pad * 2) + 'px'
    haloEl.style.height = (h + pad * 2) + 'px'
    haloEl.style.left = (off.x - pad) + 'px'
    haloEl.style.top = (off.y - pad) + 'px'
    return root
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────
  // 三种外观要分开，别混在一个状态上：
  //   开关的拨动位置 —— 点击后**立刻**到位并一直保持（加载中也不回退）；
  //   转圈           —— 只在加载中；
  //   绿光光晕       —— 只在**彻底完成**（服务端确认 enabled）之后。
  function render(s) {
    cur = s
    const loading = busy || !!s.starting
    // 加载中沿用点击时的目标态，避免轮询拿到的 enabled:false 把开关拨回去
    const showOn = (loading && pendingOn !== null) ? pendingOn : !!s.enabled
    const glow = !!s.enabled && !loading      // 绿光只在真正开好之后

    document.querySelectorAll('.dshwv-root').forEach((el) => {
      el.classList.toggle('pa-on', glow)
      el.classList.toggle('pa-busy', loading)
    })
    const fab = document.querySelector('#dsh-phone-access-host .pa-fab')
    if (fab) {
      fab.classList.toggle('pa-on', glow)
      fab.classList.toggle('pa-busy', loading)
    }
    document.querySelectorAll('.pa-sw').forEach((sw) => {
      sw.classList.toggle('pa-on', showOn)
      sw.disabled = loading
    })
    document.querySelectorAll('.pa-lbl').forEach((el) => {
      el.textContent = loading ? '手机访问（开启中…）' : (showOn ? '手机访问：已开启' : '手机访问：已关闭')
    })
    if (s.error) say(s.error, true)
  }

  // 只更新外观（乐观更新用）
  function paint(on, loading, target) {
    if (target !== undefined) pendingOn = target
    render({ enabled: on, starting: loading })
  }

  async function refresh() {
    try {
      const r = await fetch(API + '/state', { cache: 'no-store' })
      if (r.ok) render(await r.json())
    } catch { }
  }
  function schedule() {
    if (timer) clearInterval(timer)
    timer = setInterval(refresh, busy ? 2500 : 20000)
  }

  // ── 开关（乐观更新：先变外观，再请求，失败回滚）───────────────────────────
  async function toggle(target) {
    if (busy) return
    const before = !!(cur && cur.enabled)
    busy = true
    paint(target, true, target)         // 开关立刻到位 + 鲸鱼转圈（先不发光）
    say(target ? '正在开启…' : '正在关闭…')
    schedule()
    try {
      const r = await fetch(API + '/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: target }),
      })
      const j = await r.json().catch(() => ({}))
      busy = false
      pendingOn = null                  // 交给服务端真实状态决定
      render(j)                         // 真正开好 → 光晕亮起；关闭 → 熄灭
      if (j.error) { say(j.error, true); paint(before, false, null) }
      else if (target) say(j.push && j.push.ok ? '已开启，地址已发微信' : '已开启')
      else say('已关闭')
    } catch (e) {
      busy = false
      pendingOn = null
      paint(before, false, null)        // 失败回滚
      say('操作失败：' + e.message, true)
    } finally {
      busy = false
      schedule()
      setTimeout(() => refresh(), 600)
    }
  }

  // ── 往鲸鱼菜单里插一行 ───────────────────────────────────────────────────
  function injectRow(menu) {
    if (menu.querySelector('.pa-row')) return
    const row = document.createElement('div')
    row.className = 'dshwv-menu-row pa-row'
    const lbl = document.createElement('span')
    lbl.className = 'pa-lbl'
    lbl.textContent = '手机访问'
    const sw = document.createElement('button')
    sw.className = 'pa-sw'
    sw.title = '手机访问开关'
    if (cur && cur.enabled) sw.classList.add('pa-on')
    sw.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation()
      toggle(!(cur && cur.enabled))
    })
    const gear = document.createElement('button')
    gear.className = 'pa-gear'
    gear.textContent = '⚙'
    gear.title = '推送设置（填微信推送的密钥，免手改配置文件）'
    gear.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation()
      openConfig()
    })
    row.appendChild(lbl)
    row.appendChild(sw)
    row.appendChild(gear)
    menu.appendChild(row)

    // ── 微信连接那一行（由 @zmainer/dsh-wx-bridge 提供能力）────────────────
    // 我们只显示状态 + 提供启停/测试入口：桥自己管扫码配对（那需要它的前端面板）。
    const wrow = document.createElement('div')
    wrow.className = 'dshwv-menu-row pa-row'
    const wlbl = document.createElement('span')
    wlbl.className = 'pa-lbl'
    wlbl.textContent = '微信连接'
    const wdot = document.createElement('span')
    wdot.className = 'pa-wx-dot'
    wdot.title = '微信桥状态'
    const wgear = document.createElement('button')
    wgear.className = 'pa-gear'
    wgear.textContent = '⚙'
    wgear.title = '微信连接设置（启停 / 测试推送 / 扫码入口）'
    wgear.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation()
      openWxPanel()
    })
    wrow.appendChild(wlbl)
    wrow.appendChild(wdot)
    wrow.appendChild(wgear)
    menu.appendChild(wrow)

    if (cur) render(cur)
    refreshWx()
  }

  // ── 微信桥状态 ───────────────────────────────────────────────────────────
  let wxState = null

  async function refreshWx() {
    try {
      const r = await fetch('/wxbridge/status', { cache: 'no-store' })
      if (!r.ok) { wxState = null } else { wxState = await r.json() }
    } catch { wxState = null }
    paintWx()
  }

  function paintWx() {
    const dot = document.querySelector('.pa-wx-dot')
    if (!dot) return
    const b = wxState && wxState.bridge
    dot.classList.remove('on', 'wait')
    if (!b) { dot.title = '微信桥未运行（或未安装）' }
    else if (b.phase === 'poll') { dot.classList.add('on'); dot.title = '微信桥已连接（轮询中）' }
    else if (b.phase === 'wait-credentials') { dot.classList.add('wait'); dot.title = '等待扫码配对' }
    else { dot.title = '微信桥状态：' + b.phase }
  }
  function scan() {
    const menu = document.querySelector('.dshwv-menu')
    if (menu) injectRow(menu)
    ensureHalo()
  }

  // ── 推送设置面板 ─────────────────────────────────────────────────────────
  // 密钥只存在本机（服务端落在 ~/.dsh/remote-access/config.json，权限 0600）。
  // 界面**永远不显示密钥原文**：已配置时只显示一串掩码，输入框留空即代表「不改动」。
  let cfgHost = null
  let cfgRoot = null

  const KIND_LABEL = {
    serverchan: 'Server酱',
    wxpusher: 'WxPusher',
    pushplus: 'PushPlus',
    webhook: '企业微信机器人',
  }
  const KIND_HINT = {
    serverchan: 'sct.ftqq.com 扫码取 SendKey',
    wxpusher: 'wxpusher.zjiecode.com 扫码取 SPT',
    pushplus: 'pushplus.plus 取 token（需实名）',
    webhook: '企业微信群机器人地址',
  }

  // 面板样式：两个面板（推送设置 / 微信连接）共用同一份。
  // ⚠️ 必须注入到各自的 Shadow DOM 内部 —— 写在 document.head 里会被 Shadow DOM 隔离，
  //    之前面板渲染成裸 HTML、字号巨大、文字重叠就是这么来的。
  const PANEL_CSS = `
    :host { position:fixed; z-index:2147482040; }
    .box {
      width:268px; box-sizing:border-box; padding:10px 12px 11px;
      background:rgba(255,255,255,.96); color:#203170;
      border:1px solid rgba(32,49,112,.35); border-radius:10px;
      box-shadow:0 6px 18px rgba(0,0,0,.18); color-scheme:light;
      font:12px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
    .box * { box-sizing:border-box; font-family:inherit; }
    .hd { display:flex; align-items:center; font-weight:600;
      padding-bottom:7px; margin-bottom:8px; border-bottom:1px solid rgba(32,49,112,.18); }
    .hd .sp { flex:1; }
    .hd .ver { font-weight:400; font-size:10px; color:rgba(32,49,112,.4); margin-right:4px; }
    .x { cursor:pointer; color:#203170; opacity:.5; font-weight:400; padding:0 2px; }
    .x:hover { opacity:1; }
    .row { display:flex; align-items:center; gap:8px; margin:7px 0; }
    .row > .k { flex:0 0 56px; color:#203170; opacity:.72; }
    .kv { display:flex; align-items:center; gap:8px; margin:5px 0; }
    .kv > .k { flex:0 0 56px; color:rgba(32,49,112,.72); }
    .kv > .v { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#c4c9d4; margin-right:5px; }
    .dot.on { background:#22c55e; } .dot.wait { background:#f59e0b; }
    select, input {
      flex:1; min-width:0; height:26px; padding:0 7px;
      font:12px/1.4 inherit; color:#203170; background:#fff;
      border:1px solid rgba(32,49,112,.4); border-radius:6px; }
    select { cursor:pointer; }
    input:focus, select:focus { outline:none; border-color:#203170; box-shadow:0 0 0 2px rgba(32,49,112,.12); }
    input::placeholder { color:rgba(32,49,112,.42); }
    .tip { color:rgba(32,49,112,.55); font-size:11px; margin:-3px 0 8px 64px; line-height:1.4; }
    .tip.plain { margin-left:0; }
    .acts { display:flex; gap:6px; margin-top:9px; }
    button.b {
      flex:1; height:26px; padding:0 8px; cursor:pointer; font:12px inherit;
      color:#203170; background:rgba(32,49,112,.08);
      border:1px solid rgba(32,49,112,.35); border-radius:6px; }
    button.b:hover { background:rgba(32,49,112,.16); }
    button.b.pri { background:rgba(32,49,112,.88); border-color:rgba(32,49,112,.88); color:#fff; }
    button.b.pri:hover { background:#203170; }
    button.b:disabled { opacity:.5; cursor:default; }
    button.lnk { padding:3px 0; border:0; background:none; color:rgba(32,49,112,.55);
      text-decoration:underline; cursor:pointer; font:11px inherit; }
    button.lnk:hover { color:#203170; }
    .msg { margin-top:7px; font-size:11px; min-height:15px; color:rgba(32,49,112,.6); }
    .msg.ok { color:#16a34a; }
    .msg.err { color:#d92d20; }
  `

  function buildConfigPanel() {
    if (cfgHost) return
    cfgHost = document.createElement('div')
    cfgHost.id = 'dsh-phone-access-cfg'
    cfgRoot = cfgHost.attachShadow({ mode: 'open' })
    cfgRoot.innerHTML = `
      <style>${PANEL_CSS}</style>
      <div class="box">
        <div class="hd"><span>推送设置</span><span class="sp"></span><span class="ver" id="cver"></span><span class="x" id="cx">✕</span></div>
        <div class="row"><span class="k">方式</span><select id="ck"></select></div>
        <div class="tip" id="chint"></div>
        <div class="row"><span class="k">密钥</span><input id="ckey" type="password" autocomplete="off" spellcheck="false" placeholder="留空则不修改" /></div>
        <div class="row"><span class="k">每日上限</span><input id="ccap" type="number" min="1" max="50" value="8" /></div>
        <div class="acts">
          <button class="b" id="ctest">测试</button>
          <button class="b pri" id="csave">保存</button>
        </div>
        <div class="acts"><button class="lnk" id="cclear">清除已存密钥</button></div>
        <div class="msg" id="cmsg"></div>
      </div>`

    const $ = (id) => cfgRoot.getElementById(id)
    const sel = $('ck')
    for (const k of Object.keys(KIND_LABEL)) {
      const o = document.createElement('option')
      o.value = k
      o.textContent = KIND_LABEL[k]
      sel.appendChild(o)
    }
    const setMsg = (t, cls) => { const m = $('cmsg'); m.textContent = t; m.className = 'msg' + (cls ? ' ' + cls : '') }
    const hint = () => { $('chint').textContent = KIND_HINT[sel.value] || '' }
    sel.addEventListener('change', hint)

    $('cx').addEventListener('click', closeConfig)
    $('ctest').addEventListener('click', async () => {
      const b = $('ctest'); b.disabled = true
      setMsg('正在发送测试消息…')
      try {
        const r = await fetch(API + '/push-test', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: sel.value, key: $('ckey').value }),
        })
        const j = await r.json().catch(() => ({}))
        setMsg(j.ok ? (j.message || '已发送') : ('失败：' + (j.error || r.status)), j.ok ? 'ok' : 'err')
      } catch (e) { setMsg('请求失败：' + e.message, 'err') }
      finally { b.disabled = false }
    })

    $('csave').addEventListener('click', async () => {
      const b = $('csave'); b.disabled = true
      setMsg('正在保存…')
      try {
        const r = await fetch(API + '/push-config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: sel.value, key: $('ckey').value, cap: Number($('ccap').value) || 8 }),
        })
        const j = await r.json().catch(() => ({}))
        if (j.ok) { $('ckey').value = ''; applyStatus(j); setMsg('已保存', 'ok') }
        else setMsg('保存失败：' + (j.error || r.status), 'err')
      } catch (e) { setMsg('请求失败：' + e.message, 'err') }
      finally { b.disabled = false }
    })

    // 不用 window.confirm：桌面端有可能被宿主禁用，改成两步点击确认
    let clearArmed = false
    $('cclear').addEventListener('click', async () => {
      const b = $('cclear')
      if (!clearArmed) {
        clearArmed = true
        b.textContent = '再点一次确认清除'
        setMsg('清除后需要重新填写密钥。', 'err')
        setTimeout(() => {
          if (clearArmed) { clearArmed = false; b.textContent = '清除已存密钥'; setMsg('') }
        }, 5000)
        return
      }
      clearArmed = false
      b.textContent = '清除已存密钥'
      b.disabled = true
      try {
        const r = await fetch(API + '/push-config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clear: true }),
        })
        const j = await r.json().catch(() => ({}))
        if (j.ok) { applyStatus(j); setMsg('已清除本机保存的密钥', 'ok') }
        else setMsg('清除失败：' + (j.error || r.status), 'err')
      } catch (e) { setMsg('请求失败：' + e.message, 'err') }
      finally { b.disabled = false }
    })

    for (const ev of ['pointerdown', 'mousedown', 'click', 'dblclick', 'pointerup', 'contextmenu']) {
      cfgHost.addEventListener(ev, (e) => e.stopPropagation())
    }
    ;(document.body || document.documentElement).appendChild(cfgHost)
  }

  function applyStatus(s) {
    if (!cfgRoot) return
    const sel = cfgRoot.getElementById('ck')
    const key = cfgRoot.getElementById('ckey')
    const cap = cfgRoot.getElementById('ccap')
    if (s.kind) sel.value = s.kind
    if (s.cap) cap.value = s.cap
    cfgRoot.getElementById('chint').textContent = KIND_HINT[sel.value] || ''
    key.placeholder = s.keySet ? s.keyMasked + '（留空不改）' : '留空则不修改'
    key.value = ''
    cfgRoot.getElementById('cver').textContent = s.version ? 'v' + s.version : ''
    const m = cfgRoot.getElementById('cmsg')
    m.className = 'msg'
    m.textContent = s.source === 'config' ? '当前来自配置文件，其值优先' : ''
  }

  async function openConfig() {
    buildConfigPanel()
    // 鲸鱼菜单贴在右下角，面板放在它**左边**，避免把菜单挤到屏幕外或盖住它
    const W = 268, H = 210
    const menu = document.querySelector('.dshwv-menu')
    const r = menu ? menu.getBoundingClientRect() : null
    const left = r ? (r.left - W - 8) : (window.innerWidth - W - 20)
    const top = r ? (r.bottom - H) : 200
    cfgHost.style.left = Math.max(8, Math.min(left, window.innerWidth - W - 8)) + 'px'
    cfgHost.style.top = Math.max(8, Math.min(top, window.innerHeight - H - 8)) + 'px'
    try {
      const res = await fetch(API + '/push-config', { cache: 'no-store' })
      if (res.ok) applyStatus(await res.json())
    } catch { }
  }
  function closeConfig() {
    if (cfgHost) cfgHost.remove()
    cfgHost = null; cfgRoot = null
  }

  // ── 微信连接面板 ─────────────────────────────────────────────────────────
  // 只做"看状态 + 启停 + 测试推送 + 指引扫码"。扫码配对本身在桥自己的前端面板里
  // （设置 → 微信连接），我们不重复实现它，避免和上游打架。
  let wxHost = null
  let wxRoot = null

  function buildWxPanel() {
    if (wxHost) return
    wxHost = document.createElement('div')
    wxHost.id = 'dsh-phone-access-wx'
    wxRoot = wxHost.attachShadow({ mode: 'open' })
    wxRoot.innerHTML = `
      <style>${PANEL_CSS}</style>
      <div class="box">
        <div class="hd"><span>微信连接</span><span class="sp"></span><span class="x" id="wx">✕</span></div>
        <div class="kv"><span class="k">状态</span><span class="v" id="wxphase"><span class="dot" id="wxdot"></span>读取中…</span></div>
        <div class="kv"><span class="k">会话</span><span class="v" id="wxpeers">—</span></div>
        <div class="tip plain">扫码配对在 <b>设置 → 微信连接</b> 里；配对后这里会显示"已连接"。</div>
        <div class="acts">
          <button class="b" id="wxrestart">重启桥</button>
          <button class="b pri" id="wxpush">测试推送</button>
        </div>
        <div class="msg" id="wxmsg"></div>
      </div>`

    const $ = (id) => wxRoot.getElementById(id)
    const say = (t, cls) => { const m = $('wxmsg'); m.textContent = t; m.className = 'msg' + (cls ? ' ' + cls : '') }

    const paint = (j) => {
      const b = j && j.bridge
      const dot = $('wxdot')
      dot.className = 'dot'
      if (!b) { $('wxphase').innerHTML = '<span class="dot"></span>未运行'; $('wxpeers').textContent = '—'; return }
      if (b.phase === 'poll') dot.classList.add('on')
      else if (b.phase === 'wait-credentials') dot.classList.add('wait')
      const label = b.phase === 'poll' ? '已连接（轮询中）'
        : b.phase === 'wait-credentials' ? '等待扫码配对'
          : b.phase
      $('wxphase').innerHTML = ''
      $('wxphase').appendChild(dot)
      $('wxphase').appendChild(document.createTextNode(label + '　pid=' + (b.pid || 0)))
      $('wxpeers').textContent = '已登记 ' + (b.allowedUsers || 0) + ' 人｜运行中任务 ' + (b.running || 0)
    }

    const load = async () => {
      try {
        const r = await fetch('/wxbridge/status', { cache: 'no-store' })
        if (!r.ok) { $('wxphase').textContent = '未安装微信桥插件'; return }
        const j = await r.json()
        wxState = j
        paintWx()
        paint(j)
      } catch (e) { $('wxphase').textContent = '读取失败：' + e.message }
    }

    $('wx').addEventListener('click', () => { if (wxHost) wxHost.remove(); wxHost = null; wxRoot = null })
    $('wxrestart').addEventListener('click', async () => {
      const b = $('wxrestart'); b.disabled = true
      say('正在重启桥…')
      try {
        const r = await fetch('/wxbridge/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        const j = await r.json().catch(() => ({}))
        if (j.ok) { say('已重启（pid=' + (j.pid || '?') + '）', 'ok'); setTimeout(load, 3000) }
        else say('重启失败：' + (j.error || r.status), 'err')
      } catch (e) { say('请求失败：' + e.message, 'err') }
      finally { b.disabled = false }
    })
    $('wxpush').addEventListener('click', async () => {
      const b = $('wxpush'); b.disabled = true
      say('正在发送…')
      try {
        const r = await fetch('/wxbridge/push', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: '【测试】来自 DSH 手机访问插件的主动推送' }),
        })
        const j = await r.json().catch(() => ({}))
        if (j.ok) say('已排队发送，几秒内到微信（若没收到，先在微信里给机器人发一条消息再试）', 'ok')
        else say('发送失败：' + (j.error || r.status), 'err')
      } catch (e) { say('请求失败：' + e.message, 'err') }
      finally { b.disabled = false }
    })

    for (const ev of ['pointerdown', 'mousedown', 'click', 'dblclick', 'pointerup', 'contextmenu']) {
      wxHost.addEventListener(ev, (e) => e.stopPropagation())
    }
    ;(document.body || document.documentElement).appendChild(wxHost)
    load()
    // 面板开着时每 5 秒刷新一次
    const t = setInterval(() => { if (!wxHost) { clearInterval(t); return } load() }, 5000)
  }

  async function openWxPanel() {
    buildWxPanel()
    const menu = document.querySelector('.dshwv-menu')
    const r = menu ? menu.getBoundingClientRect() : null
    const W = 268, H = 210
    const left = r ? (r.left - W - 8) : (window.innerWidth - W - 20)
    const top = r ? (r.bottom - H) : 200
    wxHost.style.left = Math.max(8, Math.min(left, window.innerWidth - W - 8)) + 'px'
    wxHost.style.top = Math.max(8, Math.min(top, window.innerHeight - H - 8)) + 'px'
  }

  // ── 回退图标（没装鲸鱼插件时）─────────────────────────────────────────────
  function makeFallback() {
    if (document.getElementById('dsh-phone-access-host')) return
    const host = document.createElement('div')
    host.id = 'dsh-phone-access-host'
    host.innerHTML =
      '<div class="pa-fab" title="手机访问（点击开关 · 可拖动）">' +
      '<div class="pa-halo"></div>' +
      '<img src="/dsh-whale/image.png" alt="whale"></div>' +
      '<div class="pa-toast"></div>'
    const im = host.querySelector('img')
    im.addEventListener('error', () => {
      im.style.display = 'none'
      const f = host.querySelector('.pa-fab')
      f.textContent = '🐋'
      f.style.fontSize = '40px'
    })

    let pos = { x: 14, y: Math.max(60, (window.innerHeight || 800) - 220) }
    try {
      const s = JSON.parse(localStorage.getItem(KEY_POS) || 'null')
      if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) pos = s
    } catch { }
    const apply = () => { host.style.left = pos.x + 'px'; host.style.top = pos.y + 'px' }
    apply()

    const fab = host.querySelector('.pa-fab')
    let drag = null, suppress = false
    const onMove = (e) => {
      if (!drag) return
      drag.moved = true
      pos = {
        x: Math.min(Math.max(0, e.clientX - drag.dx), Math.max(0, window.innerWidth - 60)),
        y: Math.min(Math.max(0, e.clientY - drag.dy), Math.max(0, window.innerHeight - 60)),
      }
      apply(); e.preventDefault()
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      if (drag && drag.moved) {
        try { localStorage.setItem(KEY_POS, JSON.stringify(pos)) } catch { }
        suppress = true; setTimeout(() => { suppress = false }, 0)
      }
      drag = null
    }
    fab.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      const r = host.getBoundingClientRect()
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false }
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
    })
    fab.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!suppress) toggle(!(cur && cur.enabled))
    })
    // 没装鲸鱼插件时，右键图标打开推送设置
    fab.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation()
      openConfig()
    })
    for (const ev of ['pointerdown', 'mousedown', 'click', 'dblclick', 'pointerup', 'contextmenu']) {
      host.addEventListener(ev, (e) => e.stopPropagation())
    }
    ;(document.body || document.documentElement).appendChild(host)
    if (cur) render(cur)
  }

  // ── 启动 ────────────────────────────────────────────────────────────────
  let sawWhale = false
  const dropFallback = () => {
    const f = document.getElementById('dsh-phone-access-host')
    if (f) f.remove()
  }
  const mo = new MutationObserver(() => {
    scan()
    if (!sawWhale && document.querySelector('.dshwv-root')) {
      sawWhale = true
      dropFallback()
      if (cur) render(cur)
    }
  })

  function boot() {
    sawWhale = !!document.querySelector('.dshwv-root')
    mo.observe(document.documentElement, { childList: true, subtree: true })
    scan()
    if (!sawWhale) makeFallback()
    refresh()
    schedule()
    // 鲸鱼可能稍后才挂载；它自身的布局也可能变化，定期重新对齐光晕
    setInterval(() => { if (document.querySelector('.dshwv-root')) { ensureHalo(); scan() } }, 3000)
    window.addEventListener('resize', ensureHalo)
    setTimeout(() => {
      if (document.querySelector('.dshwv-root')) {
        sawWhale = true
        dropFallback()
        ensureHalo()
        if (cur) render(cur)
      } else if (!document.getElementById('dsh-phone-access-host')) {
        makeFallback()
      }
    }, 4000)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
