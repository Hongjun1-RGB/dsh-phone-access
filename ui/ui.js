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
  let haloRoot = null
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
  function ensureHalo() {
    const root = document.querySelector('.dshwv-root')
    if (!root) return null
    const img = root.querySelector('.dshwv-img')
    if (!img) return null
    let halo = root.querySelector('.pa-halo')
    if (!halo) {
      halo = document.createElement('div')
      halo.className = 'pa-halo'
      root.insertBefore(halo, root.firstChild)
    }
    if (haloRoot !== root) haloRoot = root
    // 尺寸/位置对齐鲸鱼图片（比它略大一圈），绝对定位在 root 内
    const rr = root.getBoundingClientRect()
    const ir = img.getBoundingClientRect()
    if (ir.width > 0 && ir.height > 0) {
      const pad = Math.max(6, Math.round(ir.width * 0.10))
      const size = Math.round(ir.width + pad * 2)
      halo.style.width = size + 'px'
      halo.style.height = size + 'px'
      halo.style.left = Math.round(ir.left - rr.left - pad) + 'px'
      halo.style.top = Math.round(ir.top - rr.top - pad) + 'px'
    }
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
    row.appendChild(lbl)
    row.appendChild(sw)
    menu.appendChild(row)
    if (cur) render(cur)
  }
  function scan() {
    const menu = document.querySelector('.dshwv-menu')
    if (menu) injectRow(menu)
    ensureHalo()
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
