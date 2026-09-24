/**
 * 飞书「扫码创建/更新应用」的设备码流程（device-code flow）
 *
 * 为什么自带一份：官方 @larksuiteoapi/node-sdk 会拖进 protobufjs 等带
 * 构建脚本的重依赖，pnpm 默认拦截构建脚本会让安装直接失败。这里只保留
 * 扫码流程需要的那点协议，零依赖（gzip 用 node:zlib）。
 *
 * 线协议与 @larksuiteoapi/node-sdk（MIT）的 registerApp 保持一致：
 *   1. POST {base}/oauth/v1/app/registration  action=begin
 *      → { verification_uri_complete, device_code, interval, expires_in }
 *   2. 二维码 = verification_uri_complete + from/source/tp [+ name/desc/avatar]
 *      [+ addons（JSON→gzip→base64→URL 安全）] [+ createOnly] [+ clientID]
 *   3. POST 同端点 action=poll&device_code=... 轮询
 *      → 成功 { client_id, client_secret, user_info }
 *      → 未完成 { error: authorization_pending | slow_down | access_denied | expired_token }
 *      → 首次拿到 user_info.tenant_brand === 'lark' 时切到国际站域名再来一次
 *
 * 所有纯函数（normalizeAddons / encodeAddons / buildQrUrl）都导出，便于单测。
 */

import zlib from "node:zlib";

export const ENDPOINT = "/oauth/v1/app/registration";
export const DEFAULT_FEISHU_DOMAIN = "accounts.feishu.cn";
export const DEFAULT_LARK_DOMAIN = "accounts.larksuite.com";
export const SDK_NAME = "node-sdk"; // 与官方 SDK 的 source 前缀保持一致
const AVATAR_MAX_COUNT = 6;

const nonEmpty = (arr) => (Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && x !== "") : undefined);

/** 只保留平台认识的字段，形状与官方 SDK 的 addons 一致 */
export function normalizeAddons(addons) {
  const out = {};
  if (addons?.preset !== undefined) out.preset = addons.preset;
  if (addons?.scopes) {
    out.scopes = { tenant: nonEmpty(addons.scopes.tenant), user: nonEmpty(addons.scopes.user) };
  }
  if (addons?.events?.items) {
    out.events = { items: { tenant: nonEmpty(addons.events.items.tenant), user: nonEmpty(addons.events.items.user) } };
  }
  if (addons?.callbacks?.items) {
    out.callbacks = { items: nonEmpty(addons.callbacks.items) };
  }
  return out;
}

/** JSON → gzip → base64 → URL 安全（'+'→'-'，'/'→'_'，去掉 '=' 填充） */
export function encodeAddons(addons) {
  const json = JSON.stringify(normalizeAddons(addons));
  return zlib
    .gzipSync(Buffer.from(json, "utf8"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 反解（仅测试/排查用） */
export function decodeAddons(encoded) {
  const b64 = String(encoded).replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(zlib.gunzipSync(Buffer.from(b64, "base64")).toString("utf8"));
}

/** 把授权页地址拼成最终二维码里的 URL */
export function buildQrUrl({ verificationUri, source = "", appPreset, addons, createOnly, appId } = {}) {
  const url = new URL(verificationUri);
  url.searchParams.set("from", "sdk");
  url.searchParams.set("source", source ? `${SDK_NAME}/${source}` : SDK_NAME);
  url.searchParams.set("tp", "sdk");
  if (appPreset?.avatar !== undefined) {
    const avatars = Array.isArray(appPreset.avatar) ? appPreset.avatar : [appPreset.avatar];
    if (avatars.length === 0) throw new Error("appPreset.avatar 至少要有一个 URL");
    if (avatars.length > AVATAR_MAX_COUNT) throw new Error(`appPreset.avatar 最多 ${AVATAR_MAX_COUNT} 个 URL`);
    for (const a of avatars) url.searchParams.append("avatar", a);
  }
  if (appPreset?.name !== undefined) url.searchParams.set("name", appPreset.name);
  if (appPreset?.desc !== undefined) url.searchParams.set("desc", appPreset.desc);
  if (addons) url.searchParams.set("addons", encodeAddons(addons));
  if (createOnly === true) url.searchParams.set("createOnly", "true");
  if (appId) url.searchParams.set("clientID", appId);
  return url.toString();
}

/** POST 表单到注册端点；RFC 8628 的"未完成"也是 HTTP 400，按正常响应解析 */
async function requestRegistration(baseUrl, params, fetchImpl) {
  const res = await fetchImpl(`${baseUrl}${ENDPOINT}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`注册端点返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
}

/**
 * 与 @larksuiteoapi/node-sdk registerApp 同语义的最小实现。
 * @param {object} o  onQRCodeReady 必填；signal 可中止；其余同官方
 * @param {object} [deps] 便于测试注入 fetch / 计时
 * @returns {Promise<{client_id:string, client_secret:string, user_info?:object}>}
 */
export async function registerApp({ domain, larkDomain, source, signal, onQRCodeReady, onStatusChange, appPreset, addons, createOnly, appId }, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (typeof onQRCodeReady !== "function") throw new Error("onQRCodeReady 必填");
  if (appId !== undefined && (typeof appId !== "string" || appId === "")) throw new Error("appId 必须是非空字符串");

  const baseUrl = `https://${domain || DEFAULT_FEISHU_DOMAIN}`;
  const beginRes = await requestRegistration(baseUrl, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  }, fetchImpl);
  if (!beginRes?.verification_uri_complete) {
    throw new Error(beginRes?.error_description || beginRes?.error || "注册端点未返回 verification_uri_complete");
  }
  const qrUrl = buildQrUrl({ verificationUri: beginRes.verification_uri_complete, source, appPreset, addons, createOnly, appId });
  onQRCodeReady({ url: qrUrl, expireIn: beginRes.expires_in ?? 600 });

  // ---- 轮询 ----
  return new Promise((resolve, reject) => {
    let base = baseUrl;
    let interval = (beginRes.interval ?? 5) * 1000;
    let domainSwitched = false;
    let settled = false;
    let pollTimer = null;
    const setTimer = deps.setTimeout || setTimeout;

    const cleanup = () => {
      if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
      try { signal?.removeEventListener("abort", onAbort); } catch { /* ignore */ }
    };
    const succeed = (r) => { if (settled) return; settled = true; cleanup(); resolve(r); };
    const fail = (e) => { if (settled) return; settled = true; cleanup(); reject(e); };
    const onAbort = () => fail(Object.assign(new Error("注册流程已取消"), { code: "abort" }));

    if (signal?.aborted) return onAbort();
    try { signal?.addEventListener("abort", onAbort, { once: true }); } catch { /* ignore */ }
    setTimer(() => fail(Object.assign(new Error("二维码已过期"), { code: "expired_token" })), (beginRes.expires_in ?? 600) * 1000);

    const poll = async () => {
      if (settled) return;
      try {
        const res = await requestRegistration(base, { action: "poll", device_code: beginRes.device_code }, fetchImpl);
        if (settled) return; // 请求在途时被取消/过期，丢弃结果

        if (res?.user_info?.tenant_brand === "lark" && !domainSwitched) {
          base = `https://${larkDomain || DEFAULT_LARK_DOMAIN}`;
          domainSwitched = true;
          onStatusChange?.({ status: "domain_switched" });
          return void poll();
        }
        if (res?.client_id && res?.client_secret) {
          return succeed({ client_id: res.client_id, client_secret: res.client_secret, user_info: res.user_info });
        }
        switch (res?.error) {
          case "authorization_pending":
            onStatusChange?.({ status: "polling" });
            break;
          case "slow_down":
            interval += 5000;
            onStatusChange?.({ status: "slow_down", interval: interval / 1000 });
            break;
          case "access_denied":
          case "expired_token":
            return fail(Object.assign(new Error(res.error_description || "未知错误"), { code: res.error }));
          default:
            if (res?.error) return fail(Object.assign(new Error(res.error_description || "未知错误"), { code: res.error }));
        }
        pollTimer = setTimer(poll, interval);
      } catch (e) {
        fail(e);
      }
    };
    poll();
  });
}
