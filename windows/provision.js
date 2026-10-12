/**
 * old-home：把一个「扫码新建的应用」落成一套完全隔离的实例
 *
 * 与 dsh-feishu-bind 的 v0.4.x 语义一致（那份是 Linux/systemd 版）：
 *   - 插件树**整棵复制**成副本，并把树内指向父实例的链接改指副本（含 .dsh-module-fallback 的绝对链接）
 *   - settings.yaml / memory / skills 逐项复制
 *   - sessions / feishu / storages 等状态目录**新建空目录**（不继承）
 *   - 只读框架依赖（D:\dsh\npm-global\...）保持原样：那是库不是状态
 *   - 派生实例的凭据只写进**它自己**的 patch，父实例一个字节都不动
 *
 * 用法:
 *   node provision.js plan   <实例名>                  → 只打印计划
 *   node provision.js create <实例名> --appId cli_x --appSecret y
 *   node provision.js remove <实例名>                  → 删干净（unit/cmd/home/logs/workspace）
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const P = {
  dshHomeRoot: "D:\\dsh",              // 实例家目录根：<root>\home-<名字>
  workspaceRoot: "D:\\",               // 工作目录根：<root>\<名字>
  parentHome: "D:\\dsh\\home",         // 父实例 DSH_HOME（插件树的来源）
  parentProfile: "feishu",
  node: "D:\\Program Files\\nodejs\\node.exe",
  dshBin: "D:\\dsh\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
  logDir: "D:\\dsh\\logs",
  // 派生实例继承父实例的 env（少了它会行为不一致）；只替换/新增下面几项
  parentEnv: {
    DSH_PERMISSION_MODE: "danger-full-access",
    SGLANG_API_KEY: "strata888",
  },
};

// ---------- 工具 ----------

function scanLinks(root, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(root, e.name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) { out.push(p); continue; }
    if (st.isDirectory()) scanLinks(p, out);
  }
  return out;
}

/** 找出 <tree> 里所有「指向 <foreign> 树内」的链接（用于验证派生实例没有指回父实例） */
export function linksInto(tree, foreign) {
  const hits = [];
  for (const l of scanLinks(tree)) {
    let raw, abs;
    try { raw = fs.readlinkSync(l); } catch { continue; }
    abs = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(l), raw);
    if (foreign && abs.startsWith(foreign + path.sep)) hits.push({ link: l, target: abs });
  }
  return hits;
}

/** 兼容旧名：扫 <home>\profiles 里指向 <home> 的链接 */
export function linksIntoParent(home = P.parentHome) {
  return linksInto(path.join(home, "profiles"), home);
}

/** 自己遍历复制：目录建、文件拷、链接**原样重建**（Node 的 cpSync 在 Windows 上会跳过 junction） */
function copyNode(src, dest) {
  let st;
  try { st = fs.lstatSync(src); } catch { return; }
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(src);
    let isDir = false;
    try { isDir = fs.statSync(src).isDirectory(); } catch {}
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.symlinkSync(target, dest, isDir ? "junction" : "file");
    } catch (e) {
      // 建链接失败（权限/目标不在）→ 退化成实体复制，保证能用
      try { isDir ? copyTreeReal(src, dest) : fs.copyFileSync(src, dest); } catch {}
    }
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src)) copyNode(path.join(src, e), path.join(dest, e));
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** 递归实体复制（dereference：把所有链接展开成真文件） */
function copyTreeReal(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    let isDir = false;
    try { isDir = fs.statSync(s).isDirectory(); } catch { continue; }
    if (isDir) copyTreeReal(s, d);
    else { try { fs.copyFileSync(s, d); } catch {} }
  }
}

function copyTree(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  copyNode(src, dest);
}

/**
 * 克隆父实例的 profiles 树到派生实例，并把「指向父树」的链接改指副本。
 * 返回 { dest, entries }。
 */
export function cloneProfileTree({ src, dest }) {
  if (!fs.existsSync(src)) throw new Error(`找不到源 profile: ${src}`);
  const real = fs.realpathSync(src);
  const root = path.dirname(real);            // <DSH_HOME>\profiles
  const entries = new Set([path.basename(real)]);
  // profile 引用的同级条目（例如 plugins/ 或框架镜像）一起带上，但依赖镜像 node_modules 由驱动按 DSH_HOME 自己维护
  for (const l of scanLinks(real)) {
    let t;
    try { t = fs.realpathSync(l); } catch { continue; }
    if (t === real || t.startsWith(real + path.sep)) continue;
    const rel = path.relative(root, t);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const top = rel.split(path.sep)[0];
    if (top === "node_modules") continue;
    entries.add(top);
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const e of entries) copyTree(path.join(root, e), path.join(dest, e));

  // 树内指向老树的链接 → 改指新树
  let repointed = 0;
  for (const l of scanLinks(dest)) {
    let raw;
    try { raw = fs.readlinkSync(l); } catch { continue; }
    const abs = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(l), raw);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;   // 框架依赖：保持原样
    if (!entries.has(rel.split(path.sep)[0])) continue;
    const target = path.join(dest, rel);
    fs.rmSync(l, { force: true });
    fs.symlinkSync(path.relative(path.dirname(l), target), l);
    repointed += 1;
  }
  return { dest, profilePath: path.join(dest, path.basename(real)), entries: [...entries], repointed };
}

export function sanitizeInstanceName(raw, fallback = "feishu2") {
  const v = String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
  return v || fallback;
}

export function instancePaths(name) {
  const n = sanitizeInstanceName(name);
  const home = path.join(P.dshHomeRoot, `home-${n}`);
  return {
    name: n,
    home,
    profiles: path.join(home, "profiles"),
    workspace: path.join(P.workspaceRoot, n),
    cmd: path.join(P.dshHomeRoot, `start-${n}.cmd`),
    log: path.join(P.logDir, `dsh-${n}.log`),
    task: `dsh-${n}`,
  };
}

/** 派生实例的补丁：只有飞书凭据（= 新应用）；默认不挂 MCP，插件就是 bridge + memory */
export function patchText(appId, appSecret, name) {
  return `# 派生实例 ${name} 自己的补丁层（完全隔离：父实例一个字节都不动）
# 顶层必须是 YAML 数组 —— 空文件或只有注释会让 profile 起不来。
- id: feishu
  config:
    appId: '${appId}'
    appSecret: '${appSecret}'
`;
}

export function launcherText(name) {
  const p = instancePaths(name);
  const envs = Object.entries({ ...P.parentEnv, DSH_HOME: p.home, DSH_BIND_ENABLED: "0" })
    .map(([k, v]) => `set ${k}=${v}`).join("\r\n");
  return `@echo off\r
chcp 65001 >nul\r
title dsh ${p.name}\r
${envs}\r
cd /d "${path.join(p.profiles, P.parentProfile)}"\r
:loop\r
"D:\\Program Files\\nodejs\\node.exe" "${P.dshBin}" --profile ${P.parentProfile} >> "${p.log}" 2>&1\r
echo [%date% %time%] dsh ${p.name} exited, restart in 10s >> "${p.log}"\r
timeout /t 10 /nobreak >nul\r
goto loop\r
`;
}

// ---------- 主流程 ----------

export function plan(name) {
  const p = instancePaths(name);
  return {
    ...p,
    copyFrom: path.join(P.parentHome, "profiles"),
    copyItems: ["settings.yaml", "memory", "skills"].map((i) => ({
      from: path.join(P.parentHome, i), to: path.join(p.home, i),
    })),
    freshDirs: ["sessions", "feishu", "storages", "attachments"].map((d) => path.join(p.home, d)),
    task: p.task,
  };
}

export function create(name, appId, appSecret) {
  const pl = plan(name);
  const out = { name: pl.name, home: pl.home, workspace: pl.workspace, steps: [] };
  if (fs.existsSync(pl.home)) throw new Error(`实例已存在: ${pl.home}（先 remove）`);

  fs.mkdirSync(pl.home, { recursive: true });
  for (const d of pl.freshDirs) fs.mkdirSync(d, { recursive: true });
  out.steps.push("建目录");

  const copied = cloneProfileTree({ src: path.join(pl.copyFrom, P.parentProfile), dest: pl.profiles });
  out.steps.push(`复制插件树（${copied.entries.join("+")}，改指副本的链接 ${copied.repointed} 条）`);

  for (const it of pl.copyItems) {
    if (!fs.existsSync(it.from)) continue;
    copyTree(it.from, it.to);
    out.steps.push(`复制 ${path.basename(it.from)}`);
  }

  // 凭据：只改**副本**里的 patch
  fs.writeFileSync(path.join(pl.profiles, P.parentProfile, "cordis.patch.yml"), patchText(appId, appSecret, pl.name));
  out.steps.push("写自己的凭据补丁");

  // 工作目录
  fs.mkdirSync(pl.workspace, { recursive: true });
  out.steps.push(`建工作目录 ${pl.workspace}`);

  // 启动脚本 + 开机自启
  fs.writeFileSync(pl.cmd, launcherText(pl.name));
  out.steps.push(`写启动脚本 ${pl.cmd}`);
  try {
    execFileSync("schtasks", ["/create", "/tn", pl.task, "/tr", pl.cmd, "/sc", "onstart", "/ru", "SYSTEM", "/rl", "HIGHEST", "/f"], { stdio: "pipe" });
    out.steps.push(`注册计划任务 ${pl.task}`);
  } catch (e) { out.steps.push(`注册计划任务失败: ${String(e.stdout || e.message).trim()}`); }

  fs.writeFileSync(path.join(pl.home, "instance.json"), JSON.stringify({ ...out, appId, at: new Date().toISOString() }, null, 2));
  return out;
}

export function start(name) {
  const pl = instancePaths(name);
  try { execFileSync("schtasks", ["/run", "/tn", pl.task], { stdio: "pipe" }); return `已启动 ${pl.task}`; }
  catch (e) { return `启动失败: ${String(e.stdout || e.message).trim()}`; }
}

export function remove(name) {
  const pl = instancePaths(name);
  const done = [];
  try { execFileSync("schtasks", ["/end", "/tn", pl.task], { stdio: "pipe" }); } catch {}
  try { execFileSync("schtasks", ["/delete", "/tn", pl.task, "/f"], { stdio: "pipe" }); done.push("删计划任务"); } catch {}
  try { execFileSync("taskkill", ["/F", "/FI", "WINDOWTITLE eq dsh " + pl.name, "/T"], { stdio: "pipe" }); } catch {}
  for (const p of [pl.home, pl.workspace]) {
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); done.push(`删 ${p}`); }
  }
  for (const p of [pl.cmd, pl.log]) { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); done.push(`删 ${p}`); } }
  return done;
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  const [cmd, name, ...rest] = process.argv.slice(2);
  const arg = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
  if (cmd === "plan") console.log(JSON.stringify(plan(name), null, 2));
  else if (cmd === "create") console.log(JSON.stringify(create(name, arg("appId", "cli_test"), arg("appSecret", "test_secret")), null, 2));
  else if (cmd === "start") console.log(start(name));
  else if (cmd === "remove") console.log(JSON.stringify(remove(name), null, 2));
  else console.log("用法: node provision.js plan|create|start|remove <实例名> [--appId x --appSecret y]");
}
