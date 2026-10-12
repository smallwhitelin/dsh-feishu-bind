/**
 * 平台层：同一套功能在 Windows 与 Linux 下的差异都集中在这里。
 *
 * 差异只有四处：① 实例家目录的命名 ② 工作目录根 ③ 怎么把服务拉起来/开机自启 ④ 父实例的凭据来源。
 * 全部可以用环境变量覆盖；代码里不再出现写死的 D:\ 路径。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const IS_WIN = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";

const env = (k, d) => (process.env[k] && String(process.env[k]).trim()) || d;

/** 把 {name}/{root} 这类占位替换掉 */
const tpl = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));

export const P = {
  // ---- 实例家目录（DSH_HOME）：Linux 沿用插件的 ~/.dsh-<名>，Windows 是 D:\dsh\home-<名>
  instanceRoot: env("DSH_INSTANCE_ROOT", IS_WIN ? "D:\\dsh" : os.homedir()),
  homeDirName: env("DSH_INSTANCE_DIRNAME", IS_WIN ? "home-{name}" : ".dsh-{name}"),

  // ---- 工作目录：扫码成功后自动建的那个（跟实例同名）
  workspaceRoot: env("DSH_WORKSPACE_ROOT", IS_WIN ? "D:\\" : os.homedir()),

  // ---- 父实例（插件树与配置的来源）
  parentHome: env("DSH_PARENT_HOME", IS_WIN ? "D:\\dsh\\home" : path.join(os.homedir(), ".dsh")),
  parentProfile: env("DSH_PROFILE", "feishu"),

  // ---- 怎么起服务
  node: env("DSH_NODE", IS_WIN ? "D:\\Program Files\\nodejs\\node.exe" : "node"),
  dshBin: env("DSH_BIN", IS_WIN
    ? "D:\\dsh\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"
    : path.join(os.homedir(), ".npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js")),
  logDir: env("DSH_LOG_DIR", IS_WIN ? "D:\\dsh\\logs" : path.join(os.homedir(), "logs")),
  // Linux：systemd user 单元目录；Windows：计划任务名前缀
  unitDir: env("DSH_UNIT_DIR", path.join(os.homedir(), ".config", "systemd", "user")),

  // ---- 派生实例要继承的父实例 env（凭据/权限模式等；Windows 从 winsw-*.xml 抄，Linux 从 EnvironmentFile 抄）
  parentEnv: {
    DSH_PERMISSION_MODE: env("DSH_PERMISSION_MODE", "danger-full-access"),
    SGLANG_API_KEY: env("SGLANG_API_KEY", ""),
  },
};

export function sanitizeInstanceName(raw, fallback = "feishu2") {
  const v = String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
  return v || fallback;
}

/** 实例的各个路径（平台无关，靠 P 里的模板拼） */
export function instancePaths(name) {
  const n = sanitizeInstanceName(name);
  const home = path.join(P.instanceRoot, tpl(P.homeDirName, { name: n }));
  return {
    name: n,
    home,
    profiles: path.join(home, "profiles"),
    workspace: path.join(P.workspaceRoot, n),
    log: path.join(P.logDir, `dsh-${n}.log`),
    // Windows：启动脚本 + 计划任务名；Linux：systemd 单元名 + 单元文件
    cmd: path.join(P.instanceRoot, IS_WIN ? `start-${n}.cmd` : `.dsh-${n}.env`),
    task: `dsh-${n}`,
    unit: `dsh-${n}.service`,
    unitPath: path.join(P.unitDir, `dsh-${n}.service`),
  };
}

/** 平台说明（写进页面/日志/README 用） */
export function platformInfo() {
  return {
    os: IS_WIN ? "windows" : IS_LINUX ? "linux" : process.platform,
    instanceRoot: P.instanceRoot,
    homeDirName: P.homeDirName,
    workspaceRoot: P.workspaceRoot,
    service: IS_WIN ? "计划任务 schtasks + start-<名>.cmd" : "systemd user 单元 dsh-<名>.service",
  };
}

/** 派生实例的凭据从哪来（供 README/页面提示） */
export function credentialSource() {
  return IS_WIN
    ? { file: path.join(P.parentHome, "..", "winsw-dsh.xml"), what: "父实例 WinSW 定义里的 <env>（SGLANG_API_KEY 等）" }
    : { file: path.join(os.homedir(), ".config", `dsh-${P.parentProfile}.env`), what: "父实例的 EnvironmentFile（整份继承，只换应用凭据/DSH_HOME）" };
}
