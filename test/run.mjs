/**
 * 测试套件（无网络、无真实飞书 SDK、无 dsh 宿主包）
 *
 * 覆盖：
 *   1. 纯逻辑：env 行合并 / 解析、接线判断、"已绑定"掩码
 *   2. 配置：默认值合理，且不含任何具体主机信息
 *   3. 卫生检查：发布出去的文件里不许出现主机痕迹（IP、用户名、隧道名、应用 ID…）
 *   4. 端到端（注入桩）：起真 HTTP 服务 → 出码 → 模拟扫码授权 → 写凭据 → 触发重启
 *      → 换码重绑；以及 token 口令、forceCreate（新建 vs 更新既有应用）两种分支
 *
 * 运行：node --import ./test/loader-hook.mjs test/run.mjs
 */

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Config, parseEnv, mergeEnvText, isWiredText, maskSecret, createBindService } from "../lib/index.js";
import { registerApp, buildQrUrl, encodeAddons, decodeAddons, normalizeAddons } from "../lib/register-app.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}\n      ${e?.message || e}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个临时服务：端口 0（内核分配），返回 base url 与关闭函数 */
async function serve(svc) {
  const server = http.createServer(svc.requestListener);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}
const getJson = async (url) => {
  const r = await fetch(url, { cache: "no-store" });
  return { status: r.status, body: await r.json() };
};
const postJson = async (url) => {
  const r = await fetch(url, { method: "POST", cache: "no-store" });
  return { status: r.status, body: await r.json() };
};

const BASE_CONFIG = (dir, extra = {}) => ({
  host: "127.0.0.1",
  port: 0,
  token: "",
  envFile: join(dir, "bridge.env"),
  stateFile: join(dir, "bind-state.json"),
  serviceUnit: "some-bridge.service",
  logFile: "",
  appId: "",
  appName: "Test App",
  appDesc: "Test",
  autoRestart: true,
  forceCreate: false,
  ...extra,
});

console.log("\n纯逻辑");

await test("parseEnv: 解析键值、去引号、忽略注释", () => {
  const env = parseEnv("# 注释\nA=1\nB=\"two words\"\nC='x'\n\n坏行\nD=with=equals\n");
  assert.deepEqual(env, { A: "1", B: "two words", C: "x", D: "with=equals" });
});

await test("mergeEnvText: 更新已有键、追加缺失键、保留其它行", () => {
  const before = "# 我的配置\nFEISHU_APP_ID=cli_old\nKEEP_ME=1\nFEISHU_TENANT=feishu\n";
  const after = mergeEnvText(before, { FEISHU_APP_ID: "cli_new", FEISHU_APP_SECRET: "s3cret", FEISHU_TENANT: "lark" });
  assert.match(after, /^# 我的配置$/m);
  assert.match(after, /^KEEP_ME=1$/m);
  assert.match(after, /^FEISHU_APP_ID=cli_new$/m);
  assert.match(after, /^FEISHU_APP_SECRET=s3cret$/m);
  assert.match(after, /^FEISHU_TENANT=lark$/m);
  assert.equal(after.split("\n").filter((l) => l.startsWith("FEISHU_APP_ID=")).length, 1);
  // 幂等
  assert.equal(mergeEnvText(after, { FEISHU_APP_ID: "cli_new" }), after);
});

await test("isWiredText: 只认比绑定更新的 ready 行", () => {
  const log = [
    "[2026-01-01T00:00:10.000Z] feishu [info] feishu long connection ready",
    "[2026-01-01T00:05:00.000Z] feishu [info] feishu long connection ready",
    "[2026-01-01T00:06:00.000Z] feishu [warn]: ignore me",
  ].join("\n");
  const bound = Date.parse("2026-01-01T00:05:30.000Z");
  assert.equal(isWiredText(log, bound).wired, false, "绑定晚于最后一次 ready → 还没接线");
  const boundOld = Date.parse("2026-01-01T00:00:00.000Z");
  assert.equal(isWiredText(log, boundOld).wired, true, "绑定早于 ready → 已接线");
  assert.equal(isWiredText(log, 0).lastReadyAt, "2026-01-01T00:05:00.000Z");
  assert.equal(isWiredText("", 0).wired, false);
});

await test("maskSecret: 长串只露头尾", () => {
  assert.equal(maskSecret("cli_ab12cd34ef567890"), "cli_ab12…890");
  assert.equal(maskSecret("short"), "short");
});

console.log("\n配置与卫生检查");

await test("默认配置合理（本机地址 + 本机端口 + 无口令）", () => {
  const c = Config.parse({});
  assert.equal(c.host, "127.0.0.1");
  assert.equal(typeof c.port, "number");
  assert.ok(c.port > 0 && c.port < 65536);
  assert.equal(c.token, "");
  assert.equal(c.forceCreate, false);
  assert.equal(c.autoRestart, true);
});

await test("发布文件里不含任何具体主机痕迹", () => {
  const files = ["lib/index.js", "lib/register-app.js", "cordis.patch.yml", "README.md", "package.json"];
  const forbid = [
    { re: /\b(?!127\.0\.0\.1)\d{1,3}(?:\.\d{1,3}){3}\b/, what: "IP 地址（只能出现回环 127.0.0.1）" },
    { re: /\/home\/(?!(?:user|runner|node)\b)[a-z0-9._-]+\//i, what: "绝对家目录路径" },
    { re: /\bcli_[a-z0-9]{8,}\b/, what: "形如真应用 ID 的串" },
    { re: /\b(localPort|remotePort|remotePort)\b/, what: "端口映射/隧道配置键" },
    { re: /\bsshpass\b/i, what: "免密登录工具" },
    { re: /(?:^|\s)(?:password|passwd|secret|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{6,}["']/im, what: "硬编码口令" },
    { re: /~\/\.ssh|id_rsa|known_hosts/i, what: "SSH 私钥/主机记录" },
  ];
  for (const f of files) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const { re, what } of forbid) {
      const m = re.exec(text);
      assert.equal(m, null, `${f} 中出现${what}：${m?.[0]}`);
    }
  }
});

console.log("\n扫码协议（自带实现，零依赖）");

const jsonRes = (o, status = 200) => ({ status, text: async () => JSON.stringify(o) });

await test("encodeAddons ↔ decodeAddons：gzip + base64url 往返一致", () => {
  const addons = {
    scopes: { tenant: ["im:message", "im:resource"] },
    events: { items: { tenant: ["im.message.receive_v1"] } },
    callbacks: { items: ["card.action.trigger"] },
  };
  const enc = encodeAddons(addons);
  assert.match(enc, /^[A-Za-z0-9_-]+$/, "只能是 URL 安全字符集");
  assert.deepEqual(decodeAddons(enc), JSON.parse(JSON.stringify(normalizeAddons(addons))));
  assert.equal(encodeAddons(addons), enc, "同样的输入必须编码一致（确定性）");
});

await test("buildQrUrl：授权页参数完整", () => {
  const url = new URL(buildQrUrl({
    verificationUri: "https://open.example/page/launcher?user_code=ABCD-1234",
    source: "my-plugin",
    appPreset: { name: "我的机器人", desc: "描述" },
    addons: { scopes: { tenant: ["im:message"] } },
    appId: "cli_existing",
  }));
  assert.equal(url.searchParams.get("from"), "sdk");
  assert.equal(url.searchParams.get("tp"), "sdk");
  assert.equal(url.searchParams.get("source"), "node-sdk/my-plugin");
  assert.equal(url.searchParams.get("name"), "我的机器人");
  assert.equal(url.searchParams.get("desc"), "描述");
  assert.equal(url.searchParams.get("clientID"), "cli_existing");
  assert.equal(url.searchParams.get("user_code"), "ABCD-1234");
  assert.ok(url.searchParams.get("addons"), "应带上 addons 载荷");
  assert.equal(new URL(buildQrUrl({ verificationUri: "https://x/y", createOnly: true })).searchParams.get("createOnly"), "true");
  assert.equal(new URL(buildQrUrl({ verificationUri: "https://x/y" })).searchParams.get("createOnly"), null);
});

await test("registerApp：begin → 轮询 pending → 成功拿凭据", async () => {
  const calls = [];
  let polls = 0;
  const fakeFetch = async (u, init) => {
    calls.push({ url: u, body: init.body });
    const action = new URLSearchParams(init.body).get("action");
    if (action === "begin") {
      return jsonRes({ verification_uri_complete: "https://open.example/page/launcher?user_code=UU-11", device_code: "dev1", interval: 0, expires_in: 600 });
    }
    polls++;
    return polls === 1
      ? jsonRes({ error: "authorization_pending" })
      : jsonRes({ client_id: "cli_9", client_secret: "sec_9", user_info: { tenant_brand: "feishu" } });
  };
  let qr = null;
  const res = await registerApp(
    { source: "t", onQRCodeReady: (i) => { qr = i; }, addons: { scopes: { tenant: ["im:message"] } } },
    { fetch: fakeFetch },
  );
  assert.equal(res.client_id, "cli_9");
  assert.equal(res.client_secret, "sec_9");
  assert.equal(res.user_info.tenant_brand, "feishu");
  assert.match(qr.url, /open\.example\/page\/launcher/);
  assert.match(qr.url, /source=node-sdk%2Ft/);
  assert.equal(qr.expireIn, 600);
  assert.equal(calls[0].url, "https://accounts.feishu.cn/oauth/v1/app/registration");
  assert.match(calls[0].body, /action=begin/);
  assert.ok(calls.length >= 3, "begin + 至少两次 poll");
});

await test("registerApp：用户拒绝 / 主动中止都能干净收尾", async () => {
  const denyFetch = async (u, init) => {
    const action = new URLSearchParams(init.body).get("action");
    return action === "begin"
      ? jsonRes({ verification_uri_complete: "https://x.invalid/a?user_code=1", device_code: "d", interval: 0 })
      : jsonRes({ error: "access_denied", error_description: "用户拒绝" });
  };
  await assert.rejects(() => registerApp({ onQRCodeReady: () => {} }, { fetch: denyFetch }), /用户拒绝/);

  const hangFetch = async (u, init) => {
    const action = new URLSearchParams(init.body).get("action");
    return action === "begin"
      ? jsonRes({ verification_uri_complete: "https://x.invalid/a?user_code=1", device_code: "d", interval: 5 })
      : jsonRes({ error: "authorization_pending" });
  };
  const ac = new AbortController();
  const p = registerApp({ signal: ac.signal, onQRCodeReady: () => {} }, { fetch: hangFetch });
  ac.abort();
  await assert.rejects(() => p, /取消/);
});

await test("registerApp：tenant_brand=lark 时切到国际站域名再轮询", async () => {
  const seen = [];
  let polls = 0;
  const f = async (u, init) => {
    seen.push(u);
    const action = new URLSearchParams(init.body).get("action");
    if (action === "begin") return jsonRes({ verification_uri_complete: "https://x.invalid/a?user_code=1", device_code: "d", interval: 0 });
    polls++;
    return polls === 1
      ? jsonRes({ user_info: { tenant_brand: "lark" } })
      : jsonRes({ client_id: "cli_l", client_secret: "s" });
  };
  const r = await registerApp({ onQRCodeReady: () => {} }, { fetch: f });
  assert.equal(r.client_id, "cli_l");
  assert.ok(seen.some((u) => u.includes("accounts.larksuite.com")), "应切换成功后用国际站地址");
});

console.log("\n端到端（注入桩，真 HTTP）");

await test("出码 → 扫码授权 → 写凭据 → 触发重启（更新既有应用）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-bind-"));
  writeFileSync(join(dir, "bridge.env"), "# 保留我\nFEISHU_APP_ID=cli_existing\nKEEP_ME=1\n");
  const auth = {};
  auth.promise = new Promise((resolve) => { auth.resolve = resolve; });
  let seenOpts = null;
  let rounds = 0;
  const restarts = [];
  const svc = createBindService({
    config: BASE_CONFIG(dir),
    log: () => {},
    deps: {
      registerApp: (opts) => {
        seenOpts = opts;
        rounds++;
        opts.onQRCodeReady({ url: "https://example.invalid/launcher?user_code=TEST", expireIn: 600 });
        // 第一轮：等测试显式 resolve；之后（换码重绑）：永挂起，保持"等待扫码"
        return rounds === 1 ? auth.promise : new Promise(() => {});
      },
      qrToDataUrl: async () => "data:image/png;base64,FAKEQR",
      restart: () => restarts.push(Date.now()),
      serviceActive: (cb) => cb("active"),
    },
  });
  const { base, close } = await serve(svc);
  try {
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /飞书机器人绑定/);

    const started = await postJson(base + "/api/qr");
    assert.equal(started.status, 200);
    assert.equal(started.body.hasExistingApp, true, "env 里已有应用 → 走更新");

    let st = (await getJson(base + "/api/state")).body;
    assert.equal(st.phase, "waiting");
    assert.equal(st.qrPng, "data:image/png;base64,FAKEQR");
    assert.equal(st.envAppId, "cli_existing");
    assert.equal(seenOpts.appId, "cli_existing", "应带着既有 appId 去重新授权");
    assert.deepEqual(seenOpts.addons.scopes.tenant.includes("im:message:send_as_bot"), true);

    auth.resolve({ client_id: "cli_new", client_secret: "new-secret", user_info: { tenant_brand: "feishu" } });
    await sleep(200);
    st = (await getJson(base + "/api/state")).body;
    assert.equal(st.phase, "bound");
    assert.equal(st.appId, "cli_new");
    assert.equal(st.wired, true, "注入 serviceActive=active → 已接线");
    assert.equal(st.serviceState, "active");

    const env = readFileSync(join(dir, "bridge.env"), "utf8");
    assert.match(env, /^# 保留我$/m);
    assert.match(env, /^KEEP_ME=1$/m);
    assert.match(env, /^FEISHU_APP_ID=cli_new$/m);
    assert.match(env, /^FEISHU_APP_SECRET=new-secret$/m);
    assert.match(env, /^FEISHU_TENANT=feishu$/m);

    await sleep(1400);
    assert.equal(restarts.length, 1, "授权后应触发一次重启");
    assert.ok(existsSync(join(dir, "bind-state.json")), "绑定记录应落盘");

    // 刷新/点绿勾 = 新一轮扫码（可重绑）
    const again = await postJson(base + "/api/qr");
    assert.equal(again.status, 200);
    st = (await getJson(base + "/api/state")).body;
    assert.equal(st.phase, "waiting", "换码后回到等待扫码");
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("forceCreate=true：不理会既有应用，走新建", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-bind-"));
  writeFileSync(join(dir, "bridge.env"), "FEISHU_APP_ID=cli_existing\n");
  let seenOpts = null;
  const svc = createBindService({
    config: BASE_CONFIG(dir, { forceCreate: true }),
    log: () => {},
    deps: {
      registerApp: (opts) => {
        seenOpts = opts;
        opts.onQRCodeReady({ url: "https://example.invalid/x", expireIn: 60 });
        return new Promise(() => {}); // 永远等扫码
      },
      qrToDataUrl: async () => "data:image/png;base64,X",
      restart: () => {},
      serviceActive: (cb) => cb("inactive"),
    },
  });
  const { base, close } = await serve(svc);
  try {
    const r = await postJson(base + "/api/qr");
    assert.equal(r.body.hasExistingApp, false);
    assert.equal(seenOpts.appId, undefined, "forceCreate 时不应带 appId");
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("token 口令：不带 k 一律 403，带了才放行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-bind-"));
  const svc = createBindService({
    config: BASE_CONFIG(dir, { token: "s3cr3t" }),
    log: () => {},
    deps: { registerApp: () => new Promise(() => {}), qrToDataUrl: async () => "", restart: () => {}, serviceActive: (cb) => cb("active") },
  });
  const { base, close } = await serve(svc);
  try {
    assert.equal((await fetch(base + "/api/state")).status, 403);
    assert.equal((await fetch(base + "/")).status, 403);
    assert.equal((await getJson(base + "/api/state?k=s3cr3t")).status, 200);
    assert.equal((await fetch(base + "/?k=s3cr3t")).status, 200);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("没有日志文件时，退化为按服务状态判断接线", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-bind-"));
  const svc = createBindService({
    config: BASE_CONFIG(dir, { logFile: join(dir, "missing.log") }),
    log: () => {},
    deps: {
      registerApp: (opts) => { opts.onQRCodeReady({ url: "https://example.invalid/y", expireIn: 60 }); return Promise.resolve({ client_id: "cli_z", client_secret: "s" }); },
      qrToDataUrl: async () => "data:image/png;base64,Y",
      restart: () => {},
      serviceActive: (cb) => cb("inactive"),
    },
  });
  const { base, close } = await serve(svc);
  try {
    await postJson(base + "/api/qr");
    await sleep(200);
    const st = (await getJson(base + "/api/state")).body;
    assert.equal(st.phase, "bound");
    assert.equal(st.wired, false, "服务未 active → 不算接线（不假装成功）");
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.error(`\n--- ${f.name}\n${f.error?.stack || f.error}`);
  process.exit(1);
}
