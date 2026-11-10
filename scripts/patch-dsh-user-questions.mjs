#!/usr/bin/env node
/**
 * dsh 兼容补丁：让 Feishu 桥能收到 ask_user_question 的提问事件。
 *
 * 背景：dsh 0.2.x 的 dsh-user-questions 用 Agent 作用域派发 `user-questions/request`
 * （ctx.waterfall(scopeTarget(agent, agent), ...)），只投递给同一作用域里的监听者；
 * 飞书桥在根作用域注册，永远收不到 —— 表现为 ask_user_question 一直挂着、卡片不弹。
 *
 * 本脚本把派发改成不带作用域（payload 里的 agent 依然保留），幂等，可重复执行。
 *
 * 用法：
 *   node scripts/patch-dsh-user-questions.mjs            # 自动在全局 dsh 安装里找
 *   node scripts/patch-dsh-user-questions.mjs <index.js> # 显式指定目标文件
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

function candidates() {
  const out = [];
  if (process.argv[2]) out.push(process.argv[2]);
  if (process.env.DSH_UQ_PATH) out.push(process.env.DSH_UQ_PATH);
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    out.push(join(root, "@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-user-questions/lib/index.js"));
  } catch { /* ignore */ }
  return out;
}

const OLD_RE = /return await \(agent === void 0 \? this\.ctx\.waterfall\("user-questions\/request", request, noAnswerer\) : this\.ctx\.waterfall\(scopeTarget\(agent, agent\), "user-questions\/request", \{[\s\S]*?\}, noAnswerer\)\);/;

const NEW = 'return await this.ctx.waterfall("user-questions/request", { ...request, ...(agent === void 0 ? {} : { agent }) }, noAnswerer);';

let target = "";
for (const c of candidates()) if (c && existsSync(c)) { target = c; break; }
if (!target) {
  console.error("找不到 dsh-user-questions/lib/index.js，请把路径作为参数传入");
  process.exit(2);
}

const src = readFileSync(target, "utf8");
if (src.includes(NEW)) {
  console.log(`已打过补丁：${target}`);
  process.exit(0);
}
if (!OLD_RE.test(src)) {
  console.error(`目标文件里没有预期的派发代码，dsh 版本可能已变化：${target}`);
  process.exit(3);
}
copyFileSync(target, `${target}.orig`);
writeFileSync(target, src.replace(OLD_RE, NEW), "utf8");
console.log(`已打补丁：${target}（原文件备份为 .orig）`);
