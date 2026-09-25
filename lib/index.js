/**
 * feishu-bind —— 浏览器扫码绑定飞书机器人（dsh 插件）
 *
 * 一句话：在本机起一个极小的 HTTP 服务，浏览器打开就是一张二维码；
 * 用飞书 App 扫码 → 授权（新建应用或更新既有应用）→ 插件把凭据写进既定的
 * env 文件并重启你的桥 → 页面变成绿勾（已绑定并接线）。
 *
 * 行为（与设计目标一一对应）：
 *   1. 刷新页面 = 生成新二维码；扫码即替换原绑定（授权结果覆盖写入）；
 *   2. 点绿勾 = 同样生成新二维码，扫码即可改绑定；
 *   3. 不依赖 dsh 的 web 表面：自带 node:http，任何 profile 都能跑（inject: []）；
 *   4. 绝不因插件异常拖垮 profile：apply 全程 try/catch，缺依赖只记日志、页面报错；
 *   5. "已接线"必须可验证：读日志里比绑定更新的 ready 行，而不是"我以为接上了"；
 *   6. 零重依赖：飞书设备码流程自带（lib/register-app.js），只有 qrcode 一个纯 JS 依赖。
 *
 * 安全：这个页面能创建飞书应用并把凭据写进本机，等价于一个开通入口。
 *   - token 非空 → 所有路由要求 `?k=<token>`；
 *   - token 为空 → 页面顶部显示醒目警告（默认零配置即可用）。
 *
 * 路由：
 *   GET  /            绑定页（手机/电脑都能开）
 *   GET  /api/state   状态 JSON（二维码 dataURL、阶段、绑定信息、接线判断）
 *   POST /api/qr      开一轮新的扫码（作废当前二维码）
 *   POST /api/apply   手动重写凭据 + 重启桥（授权后也会自动触发）
 *   GET  /healthz     存活探针
 *
 * 可测试性：纯逻辑（env 读写 / 接线判断）与外部副作用（registerApp、二维码渲染、
 * 重启服务）都以导出函数 + 可注入依赖的形式提供，test/ 里不需要网络和真实 SDK。
 */

import z from "@deepseek-ai/schemastery";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";

export const name = "feishu-bind";
export const inject = [];

export const Config = z.object({
  /** 监听地址：默认只监听本机。要从别的设备访问，请自行做端口转发/反向代理。 */
  host: z.string().default("127.0.0.1"),
  /** 本机端口（不占用 dsh / web 常用端口即可） */
  port: z.number().default(3001),
  /**
   * 访问口令。默认 `feishu888`（开箱即有一道门），**请改成你自己的**；
   * 设成空串则不需要口令。校验方式：页面输入口令（登录后 Cookie 记 30 天）
   * 或访问时带 `?k=<token>`。
   */
  token: z.string().default("feishu888"),
  /** 凭据写入的 env 文件（你的桥读的那个 EnvironmentFile）；留空 = 不写文件，只在页面展示 */
  envFile: z.string().default(join(homedir(), ".config", "dsh-feishu.env")),
  /** 绑定记录（重启后绿勾仍在） */
  stateFile: z.string().default(join(homedir(), ".dsh", "feishu-bind-state.json")),
  /** 绑定成功后要重启的 systemd user 单元；留空 = 不自动重启 */
  serviceUnit: z.string().default("dsh-feishu.service"),
  /** 桥日志路径（用于判断"已接线"）；留空 = 退化为按服务状态判断 */
  logFile: z.string().default(""),
  /** 指定既有应用 cli_xxx → 走"更新 + 重新授权"；留空 = 用 env 里的；都没有 = 新建 */
  appId: z.string().default(""),
  appName: z.string().default("DSH Agent"),
  appDesc: z.string().default("DeepSeek Harness 飞书机器人"),
  autoRestart: z.boolean().default(true),
  /** true = 每次扫码都新建应用，忽略 env/配置里已有的 appId */
  forceCreate: z.boolean().default(false),
});

const SYSTEMCTL = existsSync("/usr/bin/systemctl") ? "/usr/bin/systemctl" : "systemctl";
const MAX_LOG = 60;
const ENV_KEYS = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_TENANT"];

// ---------------- 纯逻辑（可单测） ----------------

/** 把 `KEY=value` 文本解析成对象（忽略注释与空行，去掉包裹引号） */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    out[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** 按行更新/追加 KEY=value，保留其它行（含注释与手写配置）不动 */
export function mergeEnvText(text, values) {
  const want = values || {};
  const seen = new Set();
  const kept = String(text ?? "")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l);
      if (!m || !(m[1] in want)) return l;
      seen.add(m[1]);
      return `${m[1]}=${want[m[1]]}`;
    });
  for (const [k, v] of Object.entries(want)) {
    if (!seen.has(k) && v !== undefined && v !== null && v !== "") kept.push(`${k}=${v}`);
  }
  return kept.join("\n") + "\n";
}

/** 从桥日志里找出最后一次 ready 时间；比 boundAt 新才算"已接线" */
export function isWiredText(logText, boundAt) {
  let last = "";
  for (const l of String(logText ?? "").split("\n").slice(-800)) {
    if (!/long connection ready|bridge ready/i.test(l)) continue;
    const m = /\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/.exec(l);
    if (!m) continue;
    if (!last || Date.parse(m[1]) > Date.parse(last)) last = m[1];
  }
  const at = last ? Date.parse(last) : NaN;
  return { lastReadyAt: last, wired: Boolean(at) && (!boundAt || at >= boundAt - 10_000) };
}

/** cli_ 开头的应用 ID：只露头尾 */
export function maskSecret(s) {
  const v = String(s ?? "");
  return v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-3)}` : v;
}

/** 解析 Cookie 头（只用到我们自己那个键，写全一点便于测试） */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

const COOKIE_NAME = "feishu_bind_key";

// ---------------- 服务工厂 ----------------

/**
 * @param {object} o
 * @param {object} o.config  已解析的插件配置
 * @param {(msg:string)=>void} [o.log]
 * @param {object} [o.deps]  可注入副作用（测试用）：registerApp / qrToDataUrl / restart / serviceActive
 */
export function createBindService({ config, log = () => {}, deps = {} }) {
  const S = {
    phase: "idle", // idle | waiting | authorized | applying | bound | error
    qrUrl: "",
    qrPng: "",
    expiresAt: 0,
    appId: "",
    appSecret: "",
    tenant: "",
    error: "",
    boundAt: 0,
    startedAt: 0,
    lastEvent: "",
    abort: null,
    log: [],
  };
  const rt = { serviceState: null, forceCreateNow: null }; // 运行时快照（不进状态文件）

  const note = (m) => {
    const line = `${new Date().toISOString()} ${m}`;
    S.log.push(line);
    if (S.log.length > MAX_LOG) S.log.shift();
    S.lastEvent = m;
    try { log(`[feishu-bind] ${m}`); } catch { /* 日志失败不影响主流程 */ }
  };

  const readEnvText = () => {
    try { return existsSync(config.envFile) ? readFileSync(config.envFile, "utf8") : ""; } catch { return ""; }
  };
  const writeEnvText = (text) => {
    mkdirSync(dirname(config.envFile), { recursive: true });
    const tmp = `${config.envFile}.tmp-${process.pid}`;
    writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, config.envFile);
  };

  // ---- 状态持久化（重启后绿勾仍在）----
  function loadState() {
    try {
      if (!existsSync(config.stateFile)) return;
      const s = JSON.parse(readFileSync(config.stateFile, "utf8"));
      if (s?.appId) {
        S.appId = s.appId; S.tenant = s.tenant || ""; S.boundAt = s.boundAt || 0;
        S.phase = "bound";
        note(`已载入绑定记录 appId=${maskSecret(S.appId)}`);
      }
    } catch (e) { note(`载入状态失败: ${e?.message || e}`); }
  }
  function saveState() {
    try {
      mkdirSync(dirname(config.stateFile), { recursive: true });
      writeFileSync(config.stateFile, JSON.stringify({ appId: S.appId, tenant: S.tenant, boundAt: S.boundAt }, null, 2), "utf8");
    } catch (e) { note(`保存状态失败: ${e?.message || e}`); }
  }

  // ---- 接线判断 ----
  function wiredInfo() {
    let text = "";
    try { if (config.logFile && existsSync(config.logFile)) text = readFileSync(config.logFile, "utf8"); } catch { text = ""; }
    if (text) {
      const r = isWiredText(text, S.boundAt);
      return r;
    }
    // 没有日志可读：退化为"凭据已写入 + 服务在跑"
    return { lastReadyAt: "", wired: S.phase === "bound" && S.boundAt > 0 && rt.serviceState === "active" };
  }

  /** 服务状态（可注入：测试里直接返回固定值） */
  function serviceActive(cb) {
    if (deps.serviceActive) { deps.serviceActive(cb); return; }
    if (!config.serviceUnit) { cb(""); return; }
    execFile(SYSTEMCTL, ["--user", "is-active", config.serviceUnit], { timeout: 5000 }, (err, stdout) => {
      cb(err ? String(stdout || "unknown").trim() : String(stdout).trim());
    });
  }

  function restartService() {
    if (!config.autoRestart) { note("autoRestart=false，跳过重启"); return; }
    if (deps.restart) { deps.restart(note); return; }
    if (!config.serviceUnit) { note("未配置 serviceUnit，跳过自动重启（请手动重启你的桥）"); return; }
    note(`重启 ${config.serviceUnit} 以接线…`);
    execFile(SYSTEMCTL, ["--user", "restart", config.serviceUnit], { timeout: 15000 }, (err, _o, stderr) => {
      if (err) note(`重启失败：${stderr || err.message}（请手动重启 ${config.serviceUnit}）`);
      else note("重启命令已下发");
    });
  }

  // ---- 扫码流程 ----
  function abortFlow() {
    try { S.abort?.abort(); } catch { /* ignore */ }
    S.abort = null;
  }

  async function startFlow(opts = {}) {
    abortFlow();
    const forceCreate = opts.create === true || (opts.create === undefined && config.forceCreate);
    S.phase = "waiting";
    S.error = "";
    S.qrUrl = "";
    S.qrPng = "";
    S.startedAt = Date.now();
    S.expiresAt = 0;
    const ac = new AbortController();
    S.abort = ac;

    const existing = forceCreate ? "" : (config.appId || parseEnv(readEnvText()).FEISHU_APP_ID || "");
    rt.forceCreateNow = Boolean(forceCreate);

    let registerApp = deps.registerApp;
    if (!registerApp) {
      try { registerApp = (await import("./register-app.js")).registerApp; }
      catch (e) { S.phase = "error"; S.error = `加载扫码模块失败：${e?.message || e}`; note(S.error); return; }
    }
    const toDataUrl = deps.qrToDataUrl || (async (url) => (await import("qrcode")).default.toDataURL(url, { width: 460, margin: 2, errorCorrectionLevel: "M" }));

    try {
      const res = await registerApp({
        signal: ac.signal,
        source: "dsh-feishu-bind",
        ...(existing ? { appId: existing } : {}),
        appPreset: { name: config.appName, desc: config.appDesc },
        addons: {
          scopes: { tenant: ["im:message", "im:message:send_as_bot", "im:resource"] },
          events: { items: { tenant: ["im.message.receive_v1"] } },
          callbacks: { items: ["card.action.trigger"] },
        },
        onQRCodeReady: (info) => {
          S.qrUrl = info?.url || "";
          S.expiresAt = Date.now() + (Number(info?.expireIn) || 600) * 1000;
          S.phase = "waiting";
          if (!S.qrUrl) return;
          Promise.resolve()
            .then(() => toDataUrl(S.qrUrl))
            .then((url) => {
              S.qrPng = url;
              note(`二维码就绪（有效期 ${Math.round((S.expiresAt - Date.now()) / 1000)}s，${existing ? "更新既有应用 " + maskSecret(existing) : "新建应用"}）`);
            })
            .catch((e) => { S.error = `二维码生成失败：${e?.message || e}`; note(S.error); });
        },
        onStatusChange: (info) => { if (info?.status) note(`扫码状态：${info.status}`); },
      });

      if (ac.signal.aborted) return;
      if (!res?.client_id || !res?.client_secret) throw new Error("registerApp 未返回 client_id/client_secret");
      S.appId = res.client_id;
      S.appSecret = res.client_secret;
      S.tenant = res.user_info?.tenant_brand === "lark" ? "lark" : "feishu";
      S.phase = "authorized";
      note(`授权成功 appId=${maskSecret(S.appId)}，正在接线…`);
      await applyBindings();
    } catch (e) {
      if (ac.signal.aborted) return;
      S.phase = "error";
      S.error = String(e?.message || e);
      note(`扫码流程失败：${S.error}`);
    }
  }

  async function applyBindings() {
    try {
      S.phase = "applying";
      if (!S.appSecret) S.appSecret = parseEnv(readEnvText()).FEISHU_APP_SECRET || "";
      if (!S.appId || !S.appSecret) throw new Error("凭据不完整，无法写入");
      if (config.envFile) {
        writeEnvText(mergeEnvText(readEnvText(), {
          FEISHU_APP_ID: S.appId,
          FEISHU_APP_SECRET: S.appSecret,
          FEISHU_TENANT: S.tenant || "feishu",
        }));
        note(`凭据已写入 ${config.envFile}（appId=${maskSecret(S.appId)}，tenant=${S.tenant || "feishu"}）`);
      } else {
        note("未配置 envFile：凭据只显示在页面上，请手动填入你的桥配置");
      }
      S.boundAt = Date.now();
      saveState();
      S.phase = "bound";
      note("绑定完成，已安排重启接线");
      setTimeout(restartService, 1200);
      return true;
    } catch (e) {
      S.phase = "error";
      S.error = `写入凭据失败：${e?.message || e}`;
      note(S.error);
      return false;
    }
  }

  function snapshot() {
    const w = wiredInfo();
    return {
      phase: S.phase,
      qrPng: S.qrPng,
      qrUrl: S.qrUrl,
      expiresAt: S.expiresAt,
      appId: S.appId,
      appSecret: config.envFile ? "" : S.appSecret, // 只在"不写文件"的手动模式下回传，便于页面展示
      tenant: S.tenant,
      boundAt: S.boundAt,
      wired: w.wired,
      lastReadyAt: w.lastReadyAt,
      envAppId: config.envFile ? (parseEnv(readEnvText()).FEISHU_APP_ID || "") : "",
      envFile: config.envFile,
      serviceUnit: config.serviceUnit,
      hasToken: Boolean(config.token),
      forceCreate: rt.forceCreateNow === null ? Boolean(config.forceCreate) : rt.forceCreateNow,
      autoRestart: Boolean(config.autoRestart),
      serviceState: rt.serviceState,
      error: S.error,
      lastEvent: S.lastEvent,
      serverTime: Date.now(),
      log: S.log.slice(-12),
    };
  }

  const json = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  };

  /** 已通过口令校验？—— 允许 URL 带 ?k=，或登录后携带 Cookie */
  function authed(url, req) {
    if (!config.token) return true;
    if (url.searchParams.get("k") === config.token) return true;
    return parseCookies(req?.headers?.cookie || "")[COOKIE_NAME] === config.token;
  }

  const readBody = (req) =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => { data += c; if (data.length > 16 * 1024) req.destroy(); });
      req.on("end", () => resolve(data));
      req.on("error", () => resolve(""));
    });

  async function requestListener(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    try {
      // 登录端点：唯一免口令可访问的接口
      if (req.method === "POST" && url.pathname === "/api/login") {
        if (!config.token) return json(res, 200, { ok: true, note: "未设置口令" });
        const raw = await readBody(req);
        let k = "";
        try { k = JSON.parse(raw)?.k ?? ""; } catch { k = new URLSearchParams(raw).get("k") ?? ""; }
        if (k !== config.token) return json(res, 401, { ok: false, error: "口令不对" });
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": `${COOKIE_NAME}=${encodeURIComponent(config.token)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`,
        });
        return res.end(JSON.stringify({ ok: true }));
      }

      if (!authed(url, req)) {
        // 首页给"输入口令"的登录页；接口一律 403
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          return res.end(LOGIN_PAGE);
        }
        return json(res, 403, { error: "需要口令：在页面输入口令，或访问时带上 ?k=<token>" });
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(PAGE);
      }
      if (url.pathname === "/healthz") return json(res, 200, { ok: true, phase: S.phase });
      if (url.pathname === "/api/state") {
        const snap = snapshot();
        return serviceActive((st) => { rt.serviceState = st; json(res, 200, { ...snap, serviceState: st, wired: wiredInfo().wired }); });
      }
      if (req.method === "POST" && url.pathname === "/api/qr") {
        // 可选 body: {"create": true} → 本次走"新建应用"，覆盖默认的"复用既有应用"
        let want = {};
        try { const raw = await readBody(req); if (raw) want = JSON.parse(raw) || {}; } catch { want = {}; }
        const createNow = want.create === true || (want.create === undefined && Boolean(config.forceCreate));
        startFlow({ create: createNow }); // 不 await：先回包，页面轮询拿二维码
        const hasExisting = Boolean(createNow ? "" : (config.appId || parseEnv(readEnvText()).FEISHU_APP_ID));
        return json(res, 200, { ok: true, phase: "waiting", hasExistingApp: hasExisting, create: createNow });
      }
      if (req.method === "POST" && url.pathname === "/api/apply") {
        return applyBindings()
          .then((ok) => json(res, ok ? 200 : 500, { ok, phase: S.phase, error: S.error }))
          .catch((e) => json(res, 500, { ok: false, error: String(e?.message || e) }));
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      note(`请求出错 ${url.pathname}: ${e?.message || e}`);
      return json(res, 500, { error: String(e?.message || e) });
    }
  }

  return { state: S, startFlow, applyBindings, snapshot, requestListener, loadState, note, abortFlow };
}

// ---------------- 插件入口 ----------------

export function apply(ctx, config) {
  const svc = createBindService({
    config,
    log: (m) => { try { ctx.logger?.info?.(m); } catch { /* ignore */ } },
  });
  let server = null;
  try {
    svc.loadState();
    server = http.createServer(svc.requestListener);
    server.on("error", (e) => svc.note(`HTTP 服务错误：${e?.message || e}（${config.host}:${config.port} 可能被占用）`));
    server.listen(config.port, config.host, () => {
      const { port } = server.address() || {};
      svc.note(`绑定页已就绪：http://${config.host}:${port}/` + (config.token ? `?k=<token>` : ""));
    });
  } catch (e) {
    svc.note(`启动 HTTP 服务失败：${e?.message || e}`);
  }
  ctx.on?.("dispose", () => { svc.abortFlow(); try { server?.close(); } catch { /* ignore */ } });
  return svc;
}

// ---------------- 页面（单文件，无外部依赖） ----------------
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>飞书机器人绑定</title>
<style>
  :root { --fg:#12141a; --muted:#6b7280; --line:#e5e7eb; --ok:#16a34a; --warn:#d97706; --err:#dc2626; --brand:#2563eb; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html, body { -webkit-text-size-adjust:100%; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#f6f7f9; color:var(--fg); font:16px/1.55 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
         padding:20px max(20px, env(safe-area-inset-left)) calc(20px + env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-right)); }
  .card { width:100%; max-width:460px; background:#fff; border:1px solid var(--line); border-radius:18px; padding:26px 22px 20px; text-align:center;
          box-shadow:0 6px 28px rgba(16,24,40,.07); }
  h1 { margin:0 0 6px; font-size:21px; letter-spacing:.3px; }
  .sub { margin:0 0 18px; color:var(--muted); font-size:13.5px; }
  /* 二维码区域随屏幕缩放，窄屏不溢出 */
  .qr { width:min(264px, 70vw); aspect-ratio:1 / 1; margin:6px auto 10px; display:flex; align-items:center; justify-content:center;
        border:1px solid var(--line); border-radius:14px; background:#fff; overflow:hidden; }
  .qr img { width:100%; height:100%; object-fit:contain; }
  .spinner { width:38px; height:38px; border:4px solid #e8eefc; border-top-color:var(--brand); border-radius:50%; animation:spin .9s linear infinite; margin:0 auto 12px; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .tick { width:132px; height:132px; margin:8px auto 14px; border-radius:50%; background:var(--ok); color:#fff;
          display:flex; align-items:center; justify-content:center; font-size:74px; line-height:1; box-shadow:0 8px 22px rgba(22,163,74,.28); cursor:pointer;
          transition:transform .12s ease; }
  .tick:active { transform:scale(.96); }
  .tick.hint { animation:pulse 2.4s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{box-shadow:0 8px 22px rgba(22,163,74,.28);} 50%{box-shadow:0 8px 30px rgba(22,163,74,.55);} }
  .status { font-size:15.5px; font-weight:600; margin:2px 0 8px; }
  .status.ok { color:var(--ok); } .status.warn { color:var(--warn); } .status.err { color:var(--err); }
  .meta { margin:14px 0 0; padding:12px; background:#fafbfc; border:1px solid var(--line); border-radius:12px; text-align:left; font-size:12.5px; color:var(--muted); }
  .meta div { display:flex; gap:8px; margin:3px 0; word-break:break-all; }
  .meta b { flex:0 0 74px; color:#374151; font-weight:600; }
  button { margin-top:16px; padding:11px 18px; font-size:14.5px; border-radius:11px; border:1px solid var(--line); background:#fff; color:var(--fg); cursor:pointer; }
  button.primary { background:var(--brand); border-color:var(--brand); color:#fff; }
  button:active { transform:translateY(1px); }
  .warnbar { margin:0 0 16px; padding:10px 12px; border-radius:11px; background:#fff7ed; border:1px solid #fed7aa; color:#9a3412; font-size:12.5px; text-align:left; }
  .small { color:var(--muted); font-size:12.5px; margin-top:12px; }
  code { background:#f3f4f6; padding:1px 5px; border-radius:5px; font-size:12px; }
</style>
</head>
<body>
<div class="card">
  <h1>飞书机器人绑定</h1>
  <p class="sub">用飞书 App 扫码 → 选择/新建应用并授权 → 自动写入本机并接线</p>
  <div id="warnbar"></div>
  <div id="stage"></div>
  <div id="meta" class="meta" style="display:none"></div>
  <div id="actions"></div>
  <p class="small">刷新页面即生成新二维码；扫码会替换当前绑定。</p>
</div>
<script>
const K = new URLSearchParams(location.search).get('k') || '';
const q = (p) => p + (K ? (p.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(K) : '');
const api = (p, m) => fetch(q(p), { method: m || 'GET', cache: 'no-store' }).then(r => r.json());
let started = false, busy = false;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const t = (ms) => { if (!ms) return '—'; const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };

function fmtLeft(expiresAt, serverTime) {
  if (!expiresAt) return '';
  const left = Math.max(0, Math.round((expiresAt - serverTime) / 1000));
  return left > 0 ? ('二维码剩余 ' + Math.floor(left / 60) + ' 分 ' + (left % 60) + ' 秒') : '二维码已过期';
}

function render(s) {
  const stage = document.getElementById('stage');
  const actions = document.getElementById('actions');
  const warnbar = document.getElementById('warnbar');
  warnbar.innerHTML = s.hasToken ? '' :
    '<div class="warnbar"><b>注意</b>：本页未设访问口令。任何能访问到这个端口的人，都可以扫码把飞书应用绑到本机。可被公网访问时请在配置里设置 <code>token</code>。</div>';
  actions.innerHTML = '';

  if (s.phase === 'bound') {
    if (s.wired) {
      stage.innerHTML = '<div class="tick hint" title="点我生成新二维码">✓</div>'
        + '<div class="status ok">已绑定，桥已接线</div>'
        + '<div class="small">点上面的绿勾可生成新二维码（扫码即替换绑定）</div>';
      document.querySelector('.tick').onclick = () => newQr();
    } else {
      stage.innerHTML = '<div class="spinner"></div><div class="status warn">凭据已写入，等待桥重启接线…</div>';
    }
  } else if (s.phase === 'authorized' || s.phase === 'applying') {
    stage.innerHTML = '<div class="spinner"></div><div class="status">已授权，正在写入凭据并重启桥…</div>';
  } else if (s.phase === 'error') {
    stage.innerHTML = '<div class="status err">出错：' + esc(s.error) + '</div>';
    actions.innerHTML = '<button class="primary" id="retry">重试</button>';
    document.getElementById('retry').onclick = () => newQr();
  } else if (s.phase === 'waiting' && s.qrPng) {
    stage.innerHTML = '<div class="qr"><img alt="二维码" src="' + s.qrPng + '"></div>'
      + '<div class="status">等待扫码…</div>'
      + '<div class="small">' + fmtLeft(s.expiresAt, s.serverTime) + (s.forceCreate ? '　（将新建应用）' : (s.envAppId ? '　（将重新授权既有应用 ' + String(s.envAppId).slice(0,12) + '…）' : '　（将新建应用）')) + '</div>';
    actions.innerHTML = '<button id="again">换一张二维码</button>'
      + '<div class="small" style="margin-top:12px">想绑定一个<strong>全新的飞书应用</strong>（不覆盖现在这个）？'
      + '<a href="#" id="newapp" style="color:#2563eb">用新应用绑定</a></div>';
    document.getElementById('again').onclick = () => newQr();
    document.getElementById('newapp').onclick = (e) => { e.preventDefault(); newQr(true); };
  } else {
    stage.innerHTML = '<div class="spinner"></div><div class="status">正在生成二维码…</div>';
  }

  const meta = document.getElementById('meta');
  const rows = [];
  if (s.appId || s.envAppId) rows.push(['已绑定应用', s.appId || s.envAppId]);
  if (s.tenant) rows.push(['租户', s.tenant]);
  if (s.boundAt) rows.push(['绑定时间', t(s.boundAt)]);
  if (s.lastReadyAt) rows.push(['最近接线', t(Date.parse(s.lastReadyAt))]);
  if (s.serviceState) rows.push(['服务状态', s.serviceState]);
  if (s.envFile) rows.push(['凭据文件', s.envFile]);
  if (s.appSecret) rows.push(['app secret', s.appSecret]);
  meta.innerHTML = rows.map(([k, v]) => '<div><b>' + esc(k) + '</b><span>' + esc(v) + '</span></div>').join('');
  meta.style.display = '';
}

async function newQr(createNew) {
  if (busy) return; busy = true;
  document.getElementById('stage').innerHTML = '<div class="spinner"></div><div class="status">正在生成二维码…</div>';
  try {
    await fetch(q('/api/qr'), { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createNew ? { create: true } : {}) }).then(r => r.json());
  } catch (e) { /* 轮询会兜底 */ }
  busy = false;
  tick();
}

async function tick() {
  try { render(await api('/api/state')); }
  catch (e) { /* 桥重启期间会短暂连不上 */ }
}

window.addEventListener('load', async () => {
  if (!started) { started = true; newQr(); }
  setInterval(tick, 1500);
});
</script>
</body>
</html>`;


// ---------------- 登录页（设置了 token 时，未带口令先看这个） ----------------
const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>飞书机器人绑定 · 需要口令</title>
<style>
  /* 关键：不重置 box-sizing 的话，width:100% + padding 会让输入框和按钮
     各自溢出不同的宽度（30px vs 36px），窄屏上右边永远对不齐 */
  *, *::before, *::after { box-sizing:border-box; }
  html, body { -webkit-text-size-adjust:100%; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#f6f7f9;
         color:#12141a; font:16px/1.55 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
         padding:20px max(20px, env(safe-area-inset-left)) calc(20px + env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-right)); }
  .card { width:100%; max-width:420px; background:#fff; border:1px solid #e5e7eb; border-radius:18px; padding:26px 22px;
          text-align:center; box-shadow:0 6px 28px rgba(16,24,40,.07); }
  h1 { margin:0 0 6px; font-size:20px; }
  p { margin:0 0 18px; color:#6b7280; font-size:13.5px; }
  /* 输入框与按钮统一：同为 border-box、同宽、字号 ≥16px（否则 iOS 聚焦会放大页面） */
  /* 注意：这个类不要设 margin —— class 优先级高于元素选择器，
     会把下面 button 的间距盖掉（曾经因此让输入框和按钮粘在一起） */
  .field { display:block; width:100%; }
  input { display:block; width:100%; margin:0; padding:13px 14px; font-size:16px; line-height:1.4; color:#12141a;
          background:#fff; border:1px solid #e5e7eb; border-radius:11px; outline:none;
          appearance:none; -webkit-appearance:none; }
  input::placeholder { color:#9ca3af; }
  input:focus { border-color:#2563eb; box-shadow:0 0 0 3px rgba(37,99,235,.12); }
  button { display:block; width:100%; margin:22px 0 0; padding:14px 18px; font-size:16px; line-height:1.4;
           border-radius:11px; border:0; background:#2563eb; color:#fff; cursor:pointer;
           appearance:none; -webkit-appearance:none; }
  button:active { background:#1d4ed8; }
  button:disabled { opacity:.6; }
  .err { margin-top:12px; color:#dc2626; font-size:13px; min-height:18px; }
</style>
</head>
<body>
<div class="card">
  <h1>飞书机器人绑定</h1>
  <p>这个页面需要一个口令才能打开</p>
  <input id="k" class="field" type="password" inputmode="text" autocapitalize="off" autocorrect="off" spellcheck="false"
         placeholder="请输入口令" autocomplete="current-password" autofocus>
  <button id="go" class="field" type="button">进入</button>
  <div class="err" id="err"></div>
</div>
<script>
const q = new URLSearchParams(location.search);
const input = document.getElementById('k');
const btn = document.getElementById('go');
const err = document.getElementById('err');
if (q.get('k')) input.value = q.get('k');
async function login() {
  btn.disabled = true; err.textContent = '';
  try {
    const r = await fetch('/api/login', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ k: input.value }) });
    if (r.ok) { location.replace('/'); return; }
    err.textContent = r.status === 401 ? '口令不对，请再试一次' : '登录失败（HTTP ' + r.status + '）';
  } catch (e) { err.textContent = '连不上：' + (e && e.message || e); }
  btn.disabled = false;
}
btn.addEventListener('click', login);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
</script>
</body>
</html>`;
