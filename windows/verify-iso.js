/**
 * 隔离审计：验证派生实例与父实例「不共享」
 *   node verify-iso.js <实例名>
 * 退出码 = 不合格项数
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { linksInto, instancePaths } from "./provision.js";

const name = process.argv[2] || "feishu-test";
const P = { parentHome: "D:\\dsh\\home", profile: "feishu" };
const p = instancePaths(name);
let bad = 0;
const ok = (cond, msg, extra = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${extra ? "  " + extra : ""}`); if (!cond) bad += 1; };

console.log(`=== 隔离审计：${p.name} ===\n`);
ok(fs.existsSync(p.home), `实例家目录存在 ${p.home}`);
ok(fs.existsSync(p.workspace), `工作目录存在 ${p.workspace}`);

// 1) 还有没有指向父实例的链接
const hits = linksInto(p.home, P.parentHome);
ok(hits.length === 0, `树内没有指向父实例的链接`, hits.length ? `（${hits.length} 条，例：${hits[0].link} → ${hits[0].target}）` : "");
// 1b) 反向对照：父实例里指向副本的链接（应为 0）
const back = linksInto(P.parentHome, p.home);
ok(back.length === 0, `父实例里没有指向副本的链接`, back.length ? `（${back.length} 条）` : "");

// 2) profiles/<p> 是不是自己的实体目录（不是指回父实例）
const prof = path.join(p.home, "profiles", P.profile);
ok(fs.existsSync(prof), `profiles/${P.profile} 存在`);
try {
  const real = fs.realpathSync(prof);
  ok(real.startsWith(p.home + path.sep), `profiles/${P.profile} 解析到自己家（不是父实例）`, `→ ${real}`);
} catch (e) { ok(false, `profiles/${P.profile} 解析失败`, e.message); }

// 3) settings.yaml / memory 是实体副本（inode 不同）
for (const item of ["settings.yaml", "memory"]) {
  const a = path.join(P.parentHome, item), b = path.join(p.home, item);
  if (!fs.existsSync(a) || !fs.existsSync(b)) { ok(false, `${item} 缺失`); continue; }
  const sa = fs.statSync(a), sb = fs.statSync(b);
  ok(sa.ino !== sb.ino || String(sa.birthtimeMs) !== String(sb.birthtimeMs), `${item} 是独立副本（inode 不同）`);
  ok(sa.isFile() === sb.isFile(), `${item} 同为文件/目录`);
}

// 4) 状态目录是新建的空目录（不继承父实例）
let instJson = {};
try { instJson = JSON.parse(fs.readFileSync(path.join(p.home, "instance.json"), "utf8")); } catch {}
const started = Boolean(instJson.started);
for (const d of ["sessions", "feishu", "storages"]) {
  const b = path.join(p.home, d);
  const n = fs.existsSync(b) ? fs.readdirSync(b).length : -1;
  if (n === 0) ok(true, `${d} 是空目录（不继承状态）`);
  else if (started) console.log(`  INFO  ${d} 有 ${n} 项 —— 实例已运行过，它自己写的状态（正常）`);
  else ok(false, `${d} 不该有内容`, `项数=${n}`);
}

// 5) 写探针：改副本，父实例必须纹丝不动
const probe = path.join(p.home, "memory", `__iso_probe_${Date.now()}.md`);
const parentMemBefore = fs.readdirSync(path.join(P.parentHome, "memory")).sort().join("|");
try { fs.writeFileSync(probe, "iso probe\n"); } catch (e) { ok(false, "写探针失败", e.message); }
const parentMemAfter = fs.readdirSync(path.join(P.parentHome, "memory")).sort().join("|");
ok(parentMemBefore === parentMemAfter, "写副本不影响父实例 memory");
try { fs.rmSync(probe, { force: true }); } catch {}

// 6) 凭据补丁：副本里是别人的 appId，父实例还是老的
try {
  const child = fs.readFileSync(path.join(prof, "cordis.patch.yml"), "utf8");
  const parent = fs.readFileSync(path.join(P.parentHome, "profiles", P.profile, "cordis.patch.yml"), "utf8");
  const wantApp = instJson.appId || '';
  ok(wantApp && child.includes(wantApp), `副本 patch 里是它自己的 appId (${wantApp})`);
  ok(!wantApp || !parent.includes(wantApp), "父实例 patch 没被写进新 appId");
  ok(!/mcp-aoci|mcp-deveco/.test(child), "副本没挂父实例的 MCP 插件（默认只留 bridge + memory）");
} catch (e) { ok(false, "读 patch 失败", e.message); }

console.log(`\n不合格项: ${bad}`);
process.exit(bad);
