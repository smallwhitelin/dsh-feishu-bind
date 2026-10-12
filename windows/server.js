/**
 * old-home 飞书扫码页（独立进程，不依赖 dsh）
 *
 * 复用 dsh-feishu-bind 的 register-app.js（零依赖的设备码流程）：
 *   GET  /              → 页面（需 ?k=<token>）
 *   POST /api/qr        → 开一轮新码，body 可带 {"name":"<实例名>"}
 *   GET  /api/state     → JSON 状态（phase / 实例名 / 二维码 / 凭据 / 工作目录 / 实例家目录）
 *   GET  /healthz       → {ok:true}
 *
 * 命名与隔离都沿用 dsh-feishu-bind 的现成规矩（多实例 provisioning）：
 *   - 实例名：sanitizeInstanceName（小写、只留 [a-z0-9-]、≤20 字符、空则 feishu2）
 *   - 默认名：nextInstanceName（扫已用实例，取第一个空闲的 feishu<N>，从 2 起）
 *   - 实例家目录：D:\dsh\home-<名字>（对应 Linux 的 ~/.dsh-<名字>）
 *   - **工作目录（本次新增）：D:\<名字>** —— 跟实例同名，扫码后实例与 workspace 一一对应
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import QRCode from "qrcode";
import { registerApp } from "./register-app.js";
import { create as provisionCreate, start as provisionStart, instancePaths } from "./provision.js";

const CFG = {
  host: process.env.BIND_HOST || "127.0.0.1",
  port: Number(process.env.BIND_PORT || 3001),
  token: process.env.BIND_TOKEN || "linfeishu888",
  appName: process.env.BIND_APP_NAME || "feishu2",     // 应用名/实例名的默认值（页面会算 nextInstanceName）
  workspaceRoot: process.env.BIND_WORKSPACE_ROOT || "D:\\",
  dshHomeRoot: process.env.BIND_DSH_HOME_ROOT || "D:\\dsh",
  store: process.env.BIND_STORE || path.join(process.cwd(), "last-app.json"),
  log: process.env.BIND_LOG || path.join(process.cwd(), "bind.log"),
};

// 桥实际要的权限/事件（见 dsh-feishu 的 manifest）：扫完即用，不用手动勾
const ADDONS = {
  preset: true,
  scopes: { tenant: ["im:message", "im:message:send_as_bot", "im:resource"] },
  events: { items: { tenant: ["im.message.receive_v1"] } },
  callbacks: { items: ["card.action.trigger"] },
};

let state = freshState();
let current = null; // AbortController

function freshState(name) {
  return {
    phase: "idle", // idle | waiting | authorized | error
    name: name || CFG.appName,
    instanceHome: "",
    qrUrl: "",
    qrPng: "",
    expireIn: 0,
    startedAt: 0,
    appId: "",
    appSecret: "",
    tenant: "",
    workspace: "",
    error: "",
    note: "",
  };
}

/** 与 dsh-feishu-bind 的 sanitizeInstanceName 完全一致 */
export function sanitizeInstanceName(raw, fallback = "feishu2") {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  return v || fallback;
}

/** 已用的实例名：扫 D:\dsh\home-<名字> 目录 + WinSW/计划任务里 dsh-<名字> 的痕迹 */
export function usedInstanceNames(dshHomeRoot = CFG.dshHomeRoot) {
  const used = new Set();
  try {
    for (const f of fs.readdirSync(dshHomeRoot)) {
      const m = /^home-(.+)$/.exec(f);
      if (m) used.add(m[1]);
    }
  } catch { /* ignore */ }
  try {
    const out = execSync('schtasks /query /fo LIST', { encoding: "utf8", timeout: 15000 });
    for (const m of out.matchAll(/dsh-([a-z0-9-]+)/gi)) used.add(m[1].toLowerCase());
  } catch { /* ignore */ }
  used.add("feishu"); // 主实例
  return used;
}

/** 下一个空闲实例名（与插件同规则：从 feishu2 起） */
export function nextInstanceName(dshHomeRoot = CFG.dshHomeRoot) {
  const used = usedInstanceNames(dshHomeRoot);
  for (let i = 2; i < 100; i += 1) if (!used.has(`feishu${i}`)) return `feishu${i}`;
  return "feishu2";
}

/** 实例家目录（对应 Linux 的 ~/.dsh-<名字>） */
export function instanceHome(name, root = CFG.dshHomeRoot) {
  return path.join(root, `home-${sanitizeInstanceName(name)}`);
}

/** 工作目录：D:\<实例名>（跟实例同名） */
export function ensureWorkspace(name, root = CFG.workspaceRoot) {
  const dir = path.join(root, sanitizeInstanceName(name));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 名字是否已被占用：已有的实例 / 工作目录 / 计划任务 任一命中即算重 */
export function nameTaken(name, dshHomeRoot = CFG.dshHomeRoot, workspaceRoot = CFG.workspaceRoot) {
  const n = sanitizeInstanceName(name);
  const reasons = [];
  if (usedInstanceNames(dshHomeRoot).has(n)) reasons.push(`已有同名实例（计划任务 dsh-${n}）`);
  const home = path.join(dshHomeRoot, `home-${n}`);
  if (fs.existsSync(home)) reasons.push(`目录已存在：${home}`);
  const ws = path.join(workspaceRoot, n);
  if (fs.existsSync(ws)) reasons.push(`工作目录已存在：${ws}`);
  return { name: n, taken: reasons.length > 0, reasons };
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(CFG.log, line); } catch {}
  process.stdout.write(line);
}

/** 扫码成功后的收尾：建隔离实例（插件树副本 + 凭据 + 工作目录 + 服务）并启动。单独导出便于离线测试。 */
export function onAuthorized(res, name, root = CFG.workspaceRoot) {
  const inst = sanitizeInstanceName(name);
  const out = {
    appId: res?.client_id || "",
    appSecret: res?.client_secret || "",
    tenant: res?.user_info?.tenant_brand || "feishu",
    instance: inst,
    instanceHome: instancePaths(inst).home,
    workspace: "",
    provisioned: false,
    started: "",
    error: "",
    at: new Date().toISOString(),
  };
  // 1) 建一套完全隔离的实例（与 dsh-feishu-bind v0.4.x 同语义：整树复制 + 链接改指副本）
  try {
    const r = provisionCreate(inst, out.appId, out.appSecret);
    out.instanceHome = r.home;
    out.workspace = r.workspace;
    out.provisioned = true;
    out.steps = r.steps;
    log(`实例 ${inst}：已建隔离环境 ${r.home}（${r.steps.length} 步）`);
    // 2) 拉起来
    out.started = provisionStart(inst);
    log(`实例 ${inst}：${out.started}`);
  } catch (e) {
    out.error = String(e?.message || e);
    log(`实例 ${inst} 创建失败: ${out.error}`);
    // 兜底：至少把工作目录建出来
    try { out.workspace = ensureWorkspace(inst, root); } catch {}
  }
  try { fs.writeFileSync(CFG.store, JSON.stringify(out, null, 2)); } catch (e) { log(`写凭据失败: ${e.message}`); }
  return out;
}

async function startRound(name) {
  if (current) { try { current.abort(); } catch {} }
  current = new AbortController();
  state = freshState(sanitizeInstanceName(name));
  state.instanceHome = instanceHome(state.name);
  state.phase = "waiting";
  state.startedAt = Date.now();
  const signal = current.signal;
  log(`开新一轮扫码（新建应用 → 独立环境 ${state.name}）`);
  try {
    const res = await registerApp({
      addons: ADDONS,
      createOnly: true,                       // 每次都是新建应用（不覆盖现有机器人）
      appPreset: { name: state.name, desc: `dsh (old-home) · ${state.name}` },
      signal,
      onQRCodeReady: async (info) => {
        state.qrUrl = info.url;
        state.expireIn = info.expireIn;
        try { state.qrPng = await QRCode.toDataURL(info.url, { width: 460, margin: 2 }); }
        catch (e) { state.error = "二维码渲染失败: " + e.message; }
        log(`二维码就绪，有效期 ${info.expireIn}s`);
      },
      onStatusChange: (s) => { state.note = s.status; },
    });
    if (signal.aborted) return;
    const out = onAuthorized(res, state.name);
    state.phase = "authorized";
    state.appId = out.appId;
    state.appSecret = out.appSecret;
    state.tenant = out.tenant;
    state.instance = out.instance;
    state.instanceHome = out.instanceHome;
    state.workspace = out.workspace;
    log(`授权成功: ${out.appId}｜实例 ${out.instance}｜工作目录 ${out.workspace}`);
  } catch (e) {
    if (signal.aborted) return;
    state.phase = "error";
    state.error = String(e?.message || e);
    log(`出错: ${state.error}`);
  }
}

const PAGE = (token) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>飞书扫码绑定 · old-home</title>
<style>
 body{margin:0;font:16px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1f2329}
 .wrap{max-width:520px;margin:0 auto;padding:20px}
 h1{font-size:19px;margin:8px 0 2px}
 .sub{color:#8a9099;font-size:13px;margin-bottom:14px}
 .card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);text-align:center}
 .namebox{background:#fff;border-radius:12px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
 .namebox label{display:block;color:#8a9099;font-size:13px;margin-bottom:6px}
 input{width:100%;box-sizing:border-box;font-size:16px;padding:9px 10px;border:1px solid #dee0e3;border-radius:8px}
 .hint{color:#8a9099;font-size:12px;margin-top:8px;line-height:1.8}
 .hint code{background:#f2f3f5;padding:1px 5px;border-radius:4px}
 .alert{display:none;margin-top:10px;padding:10px 12px;border-radius:8px;font-size:13px;line-height:1.7;
        background:#ffece8;color:#cb2634;border:1px solid #fdcdc5}
 .alert b{display:block;margin-bottom:2px}
 .alert code{background:#fff;padding:1px 5px;border-radius:4px;word-break:break-all}
 input.bad{border-color:#f53f3f;background:#fff7f6}
 @keyframes shake{0%,100%{transform:translateX(0)}15%{transform:translateX(-8px)}30%{transform:translateX(7px)}
   45%{transform:translateX(-5px)}60%{transform:translateX(4px)}75%{transform:translateX(-2px)}}
 .shake{animation:shake .5s cubic-bezier(.36,.07,.19,.97)}
 img{width:240px;height:240px;image-rendering:pixelated}
 .big{font-size:46px;line-height:1.1}
 .ok{color:#00b42a}.warn{color:#ff7d00}.err{color:#f53f3f}
 code{background:#f2f3f5;padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}
 table{width:100%;border-collapse:collapse;text-align:left;font-size:14px}
 td{padding:6px 4px;border-bottom:1px solid #f2f3f5;vertical-align:top}
 td:first-child{color:#8a9099;width:88px}
 button{margin-top:14px;background:#165dff;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px}
 .foot{color:#8a9099;font-size:12px;margin-top:14px}
</style></head><body><div class="wrap">
<h1>飞书扫码绑定</h1><div class="sub">old-home · 用飞书扫码新建一个机器人（独立环境）</div>
<div class="namebox">
  <label>实例名（应用名 · 独立环境 · 工作目录名）</label>
  <input id="name" value="${CFG.appName}" autocomplete="off">
  <div class="alert" id="alert"></div>
  <div class="hint" id="hint">改名字后点「重新出码」；扫完会自动建同名工作目录。</div>
</div>
<div class="card" id="card"><div class="big warn">…</div><div id="msg">正在生成二维码</div></div>
<div class="foot">刷新页面 = 重新出码；剩余时间到会自动过期。</div>
</div>
<script>
const K = ${JSON.stringify(token)};
const card = document.getElementById('card');
const nameEl = document.getElementById('name');
const hintEl = document.getElementById('hint');
const alertEl = document.getElementById('alert');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(p, opt) { const sep = p.includes('?') ? '&' : '?'; const r = await fetch(p + sep + 'k=' + encodeURIComponent(K), opt); return await r.json(); }
function showAlert(reasons, shake) {
  alertEl.innerHTML = '<b>⚠ 这个实例名已被占用，换一个再试</b>' + (reasons || []).map(r => '· ' + esc(r)).join('<br>');
  alertEl.style.display = 'block';
  nameEl.classList.add('bad');
  if (shake) { nameEl.classList.remove('shake'); void nameEl.offsetWidth; nameEl.classList.add('shake'); }
}
function clearAlert() { alertEl.style.display = 'none'; alertEl.innerHTML = ''; nameEl.classList.remove('bad'); }
async function checkName(shake) {
  try {
    const r = await api('/api/check?name=' + encodeURIComponent(nameEl.value));
    if (r.taken) { showAlert(r.reasons, shake); return false; }
    clearAlert(); return true;
  } catch (e) { return true; }
}
function render(s) {
  if (s.phase === 'waiting' && s.qrPng) {
    if (document.activeElement !== nameEl) nameEl.value = s.name;
    hintEl.innerHTML = '将新建应用 → 独立环境 <code>' + esc(s.name) + '</code>（服务 dsh-' + esc(s.name) + '）<br>工作目录 <code>' + esc(s.workspaceRoot || 'D:\\\\') + esc(s.name) + '</code> · 实例家目录 <code>' + esc(s.instanceHome || '') + '</code>';
    const left = Math.max(0, Math.round((s.startedAt + s.expireIn * 1000 - Date.now()) / 1000));
    card.innerHTML = '<img src="' + s.qrPng + '" alt="QR"><div id="msg">用飞书扫一扫 · 剩余 ' +
      Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + '</div>' +
      '<button onclick="again()">重新出码</button>';
  } else if (s.phase === 'authorized') {
    card.innerHTML = '<div class="big ok">✓</div><div id="msg"><b>' + (s.provisioned ? '实例已创建并启动' : '已拿到应用凭据') + '</b></div>' +
      '<table><tr><td>实例</td><td><code>' + esc(s.name) + '</code></td></tr>' +
      '<tr><td>工作目录</td><td><code>' + esc(s.workspace || '（见日志）') + '</code></td></tr>' +
      '<tr><td>实例家目录</td><td><code>' + esc(s.instanceHome || '') + '</code></td></tr>' +
      '<tr><td>服务</td><td><code>dsh-' + esc(s.name) + '</code> ' + esc(s.started || '') + '</td></tr>' +
      '<tr><td>app_id</td><td><code>' + esc(s.appId) + '</code></td></tr>' +
      '<tr><td>app_secret</td><td><code>' + esc(s.appSecret) + '</code></td></tr>' +
      (s.error ? '<tr><td>错误</td><td><span class="err">' + esc(s.error) + '</span></td></tr>' : '') +
      '</table>' +
      '<div class="hint">新机器人第一次用：在它的聊天里发 <code>/cd ' + esc(s.workspace) + '</code></div>' +
      '<button onclick="again()">再扫一个</button>';
  } else if (s.phase === 'error') {
    card.innerHTML = '<div class="big err">!</div><div id="msg">' + esc(s.error) + '</div>' +
      '<button onclick="again()">重试</button>';
  } else {
    card.innerHTML = '<div class="big warn">…</div><div id="msg">正在生成二维码</div>';
  }
}
async function again() {
  if (!(await checkName(true))) return;          // 重名：摇框提醒，不出码
  render({phase:'idle'});
  const res = await api('/api/qr', {method:'POST', headers:{'content-type':'application/json'},
                        body: JSON.stringify({name: nameEl.value})});
  if (res.duplicate) showAlert(res.reasons, true);   // 服务端兜底拦截
  else tick();
}
async function tick() { try { render(await api('/api/state')); } catch (e) {} }
let debounce = null;
nameEl.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => checkName(false), 400); });
(async () => {
  if (await checkName(false)) {
    await api('/api/qr', {method:'POST', headers:{'content-type':'application/json'},
                          body: JSON.stringify({name: nameEl.value})});
  }
  tick();
})();
setInterval(tick, 1500);
</script></body></html>`;

const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
};

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/healthz") return json(res, 200, { ok: true, phase: state.phase });
    if (CFG.token && url.searchParams.get("k") !== CFG.token)
      return json(res, 403, { error: "bad or missing token: 用 ?k=<口令> 访问" });

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = PAGE(CFG.token).replace('value="' + CFG.appName + '"', 'value="' + nextInstanceName() + '"');
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    }
    if (req.method === "POST" && url.pathname === "/api/qr") {
      const body = await readBody(req);
      const nm = sanitizeInstanceName(body.name || nextInstanceName());
      const chk = nameTaken(nm);
      if (chk.taken) {
        log(`拒绝：实例名 ${nm} 已被占用（${chk.reasons.join("；")}）`);
        return json(res, 409, { ok: false, duplicate: true, name: nm, reasons: chk.reasons });
      }
      startRound(nm);
      return json(res, 200, { ok: true, name: nm });
    }
    if (url.pathname === "/api/check") {
      const nm = sanitizeInstanceName(url.searchParams.get("name") || "");
      return json(res, 200, { ...nameTaken(nm), suggested: nextInstanceName() });
    }
    if (url.pathname === "/api/state") return json(res, 200, { ...state, workspaceRoot: CFG.workspaceRoot });
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
});

server.on("error", (e) => log(`HTTP 错误：${e.message}（端口可能被占）`));
// 只有「直接运行」才监听端口；被 import 时（离线测试）不启服务
const runDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (runDirectly || process.env.BIND_FORCE_LISTEN === "1") {
  server.listen(CFG.port, CFG.host, () =>
    log(`已就绪 http://${CFG.host}:${CFG.port}/?k=${CFG.token}（工作目录根 ${CFG.workspaceRoot}，下一个实例名 ${nextInstanceName()}）`));
}
process.on("SIGTERM", () => { try { server.close(); } catch {} process.exit(0); });
export { server, CFG };
