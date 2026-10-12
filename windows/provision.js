/**
 * 把一个「扫码新建的应用」落成一套完全隔离的实例 —— Windows / Linux 同一套代码。
 *
 * 与 dsh-feishu-bind v0.4.x 的隔离语义一致：
 *   - 插件树**整棵复制**成副本，并把树内指向父实例的链接改指副本（含 .dsh-module-fallback 的绝对链接）
 *   - settings.yaml / memory / skills 逐项复制
 *   - sessions / feishu / storages 等状态目录**新建空目录**（不继承）
 *   - 只读框架依赖（dsh 安装闭包）保持原样：那是库不是状态
 *   - 派生实例的凭据只写进**它自己**的东西，父实例一个字节都不动
 *
 * 平台差异全部集中在 platform.js（路径/服务机制/凭据落点），代码里没有写死的 D:\ 或 /home。
 *
 * 用法:
 *   node provision.js plan   <实例名>
 *   node provision.js create <实例名> --appId cli_x --appSecret y
 *   node provision.js start|remove <实例名>
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { IS_WIN, P, sanitizeInstanceName, instancePaths, platformInfo, credentialSource } from "./platform.js";

export { sanitizeInstanceName, instancePaths, platformInfo, credentialSource, P };

// ---------------- 复制（含链接处理） ----------------

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

/** <tree> 里所有「指向 <foreign> 树内」的链接（验证隔离用） */
export function linksInto(tree, foreign) {
  const hits = [];
  for (const l of scanLinks(tree)) {
    let raw;
    try { raw = fs.readlinkSync(l); } catch { continue; }
    const abs = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(l), raw);
    if (foreign && abs.startsWith(foreign + path.sep)) hits.push({ link: l, target: abs });
  }
  return hits;
}

/** 自己遍历复制：目录建、文件拷、链接**原样重建**
 *  （Windows 上 Node 的 cpSync 会跳过 junction，pnpm 的 node_modules 几乎全是 junction，用它等于没复制） */
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
    } catch {
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

/** 递归实体复制（把链接展开成真文件） */
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

/** 克隆父实例的 profiles 树，并把「指向父树」的链接改指副本 */
export function cloneProfileTree({ src, dest }) {
  if (!fs.existsSync(src)) throw new Error(`找不到源 profile: ${src}`);
  const real = fs.realpathSync(src);
  const root = path.dirname(real);
  const entries = new Set([path.basename(real)]);
  for (const l of scanLinks(real)) {
    let t;
    try { t = fs.realpathSync(l); } catch { continue; }
    if (t === real || t.startsWith(real + path.sep)) continue;
    const rel = path.relative(root, t);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const top = rel.split(path.sep)[0];
    if (top === "node_modules") continue;      // 依赖镜像按 DSH_HOME 自己维护
    entries.add(top);
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const e of entries) copyTree(path.join(root, e), path.join(dest, e));

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

// ---------------- 凭据 / 启动 ----------------

/** 派生实例的 profile 补丁：只有新应用的凭据（默认不挂父实例的 MCP → 插件就是 bridge + memory） */
export function patchText(appId, appSecret, name) {
  const ws = instancePaths(name).workspace;
  return `# 派生实例 ${name} 自己的补丁层（完全隔离：父实例一个字节都不动）
# 顶层必须是 YAML 数组 —— 空文件或只有注释会让 profile 起不来。
- id: feishu
  config:
    appId: '${appId}'
    appSecret: '${appSecret}'
    # 派生实例关掉「必须先 /cd 选工作目录」的门禁，并把默认工作目录钉到它自己的
    # workspace —— 扫码新建后第一次说话就能干活，不用先发 /cd（父实例保留门禁）。
    # 这两条在 profile 启动时校验，写错会让实例起不来；已在 Windows 实测通过。
    requireWorkingDir: false
    defaultCwd: '${ws}'
`;
}

/** 读父实例的 env（Linux 从 EnvironmentFile，Windows 从 WinSW xml 的 <env>；读不到就用 P.parentEnv） */
export function readParentEnv() {
  const out = { ...P.parentEnv };
  if (IS_WIN) {
    for (const f of ["winsw-dsh.xml", "winsw.xml"]) {
      const p = path.join(P.parentHome, "..", f);
      try {
        const t = fs.readFileSync(p, "utf8");
        for (const m of t.matchAll(/<env\s+name="([^"]+)"\s+value="([^"]*)"/g)) out[m[1]] = m[2];
      } catch {}
    }
  } else {
    const p = path.join(os.homedir(), ".config", `dsh-${P.parentProfile}.env`);
    try {
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {}
  }
  return out;
}

/** Windows：启动脚本（内置崩溃重启循环）+ 计划任务。Linux：systemd user 单元 + EnvironmentFile。 */
export function serviceText(name, appId, appSecret) {
  const p = instancePaths(name);
  const baseEnv = readParentEnv();
  const env = { ...baseEnv, DSH_HOME: p.home, DSH_BIND_ENABLED: "0", FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret };

  if (IS_WIN) {
    const lines = Object.entries(env).filter(([, v]) => v !== "").map(([k, v]) => `set ${k}=${v}`).join("\r\n");
    return `@echo off\r
chcp 65001 >nul\r
title dsh ${p.name}\r
${lines}\r
cd /d "${p.workspace}"\r
:loop\r
"${P.node}" "${P.dshBin}" --profile ${P.parentProfile} >> "${p.log}" 2>&1\r
echo [%date% %time%] dsh ${p.name} exited, restart in 10s >> "${p.log}"\r
timeout /t 10 /nobreak >nul\r
goto loop\r
`;
  }
  // Linux：单元文件 + env 文件
  const envFile = `${Object.entries(env).filter(([, v]) => v !== "").map(([k, v]) => `${k}=${v}`).join("\n")}\n`;
  const unit = `[Unit]
Description=dsh bridge instance ${p.name} (profile: ${P.parentProfile})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${p.workspace}
EnvironmentFile=${p.cmd}
Environment=DSH_HOME=${p.home}
ExecStart=${P.node} ${P.dshBin} --profile ${P.parentProfile}
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=20
StandardOutput=append:${p.log}
StandardError=append:${p.log}

[Install]
WantedBy=default.target
`;
  return { envFile, unit };
}

// ---------------- 主流程 ----------------

export function plan(name) {
  const p = instancePaths(name);
  return {
    ...p,
    platform: platformInfo(),
    credentialsFrom: credentialSource(),
    copyFrom: path.join(P.parentHome, "profiles"),
    copyItems: ["settings.yaml", "memory", "skills"].map((i) => ({
      from: path.join(P.parentHome, i), to: path.join(p.home, i),
    })),
    freshDirs: ["sessions", "feishu", "storages", "attachments"].map((d) => path.join(p.home, d)),
  };
}

export function create(name, appId, appSecret) {
  const pl = plan(name);
  const out = { name: pl.name, home: pl.home, workspace: pl.workspace, platform: pl.platform.os, steps: [] };
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

  fs.writeFileSync(path.join(pl.profiles, P.parentProfile, "cordis.patch.yml"), patchText(appId, appSecret, pl.name));
  out.steps.push(IS_WIN ? "写自己的凭据补丁（Windows 从 profile 补丁读应用凭据）" : "写自己的凭据补丁");

  fs.mkdirSync(pl.workspace, { recursive: true });
  out.steps.push(`建工作目录 ${pl.workspace}`);

  const svc = serviceText(pl.name, appId, appSecret);
  if (IS_WIN) {
    fs.writeFileSync(pl.cmd, svc);
    out.steps.push(`写启动脚本 ${pl.cmd}`);
    try {
      execFileSync("schtasks", ["/create", "/tn", pl.task, "/tr", pl.cmd, "/sc", "onstart", "/ru", "SYSTEM", "/rl", "HIGHEST", "/f"], { stdio: "pipe" });
      out.steps.push(`注册计划任务 ${pl.task}`);
    } catch (e) { out.steps.push(`注册计划任务失败: ${String(e.stdout || e.message).trim()}`); }
  } else {
    fs.mkdirSync(path.dirname(pl.cmd), { recursive: true });
    fs.writeFileSync(pl.cmd, svc.envFile, { mode: 0o600 });
    fs.mkdirSync(pl.unitDir, { recursive: true });
    fs.writeFileSync(pl.unitPath, svc.unit, { mode: 0o644 });
    out.steps.push(`写 env 文件 ${pl.cmd} 与 systemd 单元 ${pl.unitPath}`);
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
      execFileSync("systemctl", ["--user", "enable", "--now", pl.unit], { stdio: "pipe" });
      out.steps.push(`enable --now ${pl.unit}`);
    } catch (e) { out.steps.push(`systemctl 失败: ${String(e.stderr || e.message).trim()}`); }
  }

  fs.writeFileSync(path.join(pl.home, "instance.json"), JSON.stringify({ ...out, appId, at: new Date().toISOString() }, null, 2));
  return out;
}

export function start(name) {
  const pl = instancePaths(name);
  try {
    if (IS_WIN) { execFileSync("schtasks", ["/run", "/tn", pl.task], { stdio: "pipe" }); return `已启动 ${pl.task}`; }
    execFileSync("systemctl", ["--user", "restart", pl.unit], { stdio: "pipe" });
    return `已启动 ${pl.unit}`;
  } catch (e) { return `启动失败: ${String(e.stdout || e.stderr || e.message).trim()}`; }
}

export function remove(name) {
  const pl = instancePaths(name);
  const done = [];
  if (IS_WIN) {
    try { execFileSync("schtasks", ["/end", "/tn", pl.task], { stdio: "pipe" }); } catch {}
    try { execFileSync("schtasks", ["/delete", "/tn", pl.task, "/f"], { stdio: "pipe" }); done.push("删计划任务"); } catch {}
    try { execFileSync("taskkill", ["/F", "/FI", "WINDOWTITLE eq dsh " + pl.name, "/T"], { stdio: "pipe" }); } catch {}
  } else {
    try { execFileSync("systemctl", ["--user", "disable", "--now", pl.unit], { stdio: "pipe" }); done.push("disable --now"); } catch {}
    if (fs.existsSync(pl.unitPath)) { fs.rmSync(pl.unitPath, { force: true }); done.push("删单元文件"); }
    try { execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" }); } catch {}
  }
  for (const p of [pl.home, pl.workspace]) {
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); done.push(`删 ${p}`); }
  }
  for (const p of [pl.cmd, pl.log]) { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); done.push(`删 ${p}`); } }
  return done;
}

// ---------------- CLI ----------------
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  const [cmd, name, ...rest] = process.argv.slice(2);
  const arg = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
  if (cmd === "plan") console.log(JSON.stringify(plan(name || "feishu2"), null, 2));
  else if (cmd === "create") console.log(JSON.stringify(create(name, arg("appId", "cli_test"), arg("appSecret", "test_secret")), null, 2));
  else if (cmd === "start") console.log(start(name));
  else if (cmd === "remove") console.log(JSON.stringify(remove(name), null, 2));
  else console.log("用法: node provision.js plan|create|start|remove <实例名> [--appId x --appSecret y]\n" +
                   "环境变量覆盖: DSH_INSTANCE_ROOT / DSH_INSTANCE_DIRNAME / DSH_WORKSPACE_ROOT / DSH_PARENT_HOME / DSH_PROFILE / DSH_NODE / DSH_BIN / DSH_LOG_DIR / DSH_UNIT_DIR");
}
