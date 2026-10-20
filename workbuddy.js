/**
 * WorkBuddy 多账号一键签到 · Quantumult X 整合版（无个人令牌，可直接分享）
 *
 * 一个脚本、两种运行模式，按环境自动分流：
 *   ① 重写模式 [rewrite_local]：登录 WorkBuddy 时自动捕获“长效令牌”。
 *      支持多账号：依次切换登录不同账号，会按账号唯一 ID 去重累积，互不覆盖。
 *   ② 任务模式 [task_local]：每天串行签到所有账号，每个账号独立刷新令牌、
 *      签到、派 Buddy 旅行、查真实余额，最后【合并成一条通知】逐账号播报。
 *
 * 账号显示：昵称（手机尾号），如 “Roam（6351）”；无昵称时用脱敏手机号。
 *
 * ============================ QX 配置 ============================
 * [rewrite_local]
 * ^https?://(copilot\.tencent\.com|www\.codebuddy\.cn|www\.workbuddy\.cn)/.* url script-response-body workbuddy.js
 *
 * [task_local]
 * 0 9 * * * workbuddy.js, tag=WorkBuddy多账号签到, enabled=true
 *
 * [mitm]
 * hostname = copilot.tencent.com, www.codebuddy.cn, www.workbuddy.cn
 *
 * ============================ 添加多个账号 ============================
 * 1. 装好并信任 QX 证书、打开 MitM，加好上面三段配置。
 * 2. 用 Safari 打开 https://www.codebuddy.cn/login 登录账号 A，收到“已捕获账号 A”。
 * 3. 退出登录，再登录账号 B、C……（每登录一个就会自动累积一个）。
 * 4. 全部登录完，定时任务会每天自动签到所有账号。
 *
 * 通知示例：
 *   🎯 WorkBuddy 签到（2个账号）
 *   ✅ 全部完成 2/2
 *   👤 Roam（6351）
 *   ✅ 今日已签到 +100　💰 2685.85
 *   📅 连签17天　🐱 旅行中
 *   ━━━━━━━━━
 *   👤 小号（2222）
 *   🎉 签到成功 +100　💰 500
 *   📅 连签4天　🐱 Buddy 已出发
 *
 * 安全：每个账号令牌只保存在本机 $prefs，不收集、不外传、不改动服务器响应。
 */

// ===================== 接口常量 =====================
const REFRESH_URL = "https://copilot.tencent.com/v2/plugin/auth/token/refresh";
const CHECKIN_DOMAIN = "https://www.codebuddy.cn";
const STATUS_URL = CHECKIN_DOMAIN + "/v2/billing/meter/checkin-activity-status";
const CHECKIN_URL = CHECKIN_DOMAIN + "/v2/billing/meter/daily-checkin";
// 真实账户余额（注意：该接口没有 /v2 前缀，且必须带 User-Agent）
const BALANCE_URL = CHECKIN_DOMAIN + "/billing/meter/get-user-resource-summary";
const TRAVEL_DOMAIN = "https://www.workbuddy.cn";
const TRAVEL_STATUS_URL = TRAVEL_DOMAIN + "/activity/growth/buddy/travel/status";
const TRAVEL_CLAIM_URL = TRAVEL_DOMAIN + "/activity/growth/buddy/travel/claim";
const TRAVEL_DEPART_URL = TRAVEL_DOMAIN + "/activity/growth/buddy/travel/depart";

const PREF_ACCOUNTS = "workbuddy_accounts_v2";   // 多账号存储键
const PREF_LEGACY_RT = "workbuddy_checkin_rt";   // 旧单账号键（自动迁移）
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

const IS_REWRITE = (typeof $response !== "undefined") && !!$response;

// ===================== 基础工具 =====================
function getPrefRaw(k) {
  try {
    if (typeof $prefs !== "undefined" && $prefs && $prefs.valueForKey) {
      const v = $prefs.valueForKey(k);
      if (v != null && v !== "") return v;
    }
  } catch (e) {}
  return null;
}

function setPref(k, v) {
  try {
    if (typeof $prefs !== "undefined" && $prefs && $prefs.setValueForKey) {
      $prefs.setValueForKey(v, k);
    }
  } catch (e) {}
}

function notify(title, subtitle, body) {
  try { if (typeof $notify === "function") $notify(title, subtitle, body); } catch (e) {}
}

function httpRequest(url, method, headers, body) {
  return $task.fetch({
    url: url, method: method, headers: headers, body: body,
    opts: { 'redirection': true, 'skip-cert-verify': false, 'auto-cookie': false }
  });
}

function parseBody(resp) {
  let body = resp && resp.body;
  if (!body) return {};
  if (typeof body === "object") return body;
  try { return JSON.parse(body); } catch (e) { return {}; }
}

function headersWithToken(token) {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Authorization": "Bearer " + token,
    "User-Agent": USER_AGENT
  };
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ===================== JWT / 令牌识别 =====================
const JWT_IS = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JWT_SCAN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const RT_KEYS = ["refreshToken", "refresh_token", "refreshTokenValue", "refreshTokenStr", "refreshTokenInfo"];

function b64urlDecode(s) {
  try {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    let bin = "";
    if (typeof atob === "function") {
      bin = atob(s);
    } else {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      for (let bc = 0, bs = 0, i = 0; i < s.length; i++) {
        const buffer = chars.indexOf(s.charAt(i));
        if (buffer < 0) continue;
        bs = bc % 4 ? bs * 64 + buffer : buffer;
        if (bc++ % 4) bin += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)));
      }
    }
    try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; }
  } catch (e) { return ""; }
}

function decodeJwtPayload(jwt) {
  try {
    const parts = String(jwt).split(".");
    if (parts.length < 2) return null;
    return JSON.parse(b64urlDecode(parts[1]));
  } catch (e) { return null; }
}

function isRefreshToken(jwt) {
  const p = decodeJwtPayload(jwt);
  if (!p || typeof p !== "object") return false;
  if (p.typ === "Offline") return true;
  if (p.type && /refresh|offline/i.test(String(p.type))) return true;
  if (p.scope && /offline_access/.test(String(p.scope))) return true;
  return false;
}

function findTokenByKey(obj, depth) {
  if (obj == null || depth > 10) return null;
  if (typeof obj === "object") {
    for (let i = 0; i < RT_KEYS.length; i++) {
      const v = obj[RT_KEYS[i]];
      if (typeof v === "string" && JWT_IS.test(v)) return v;
    }
    for (const k in obj) {
      try { const t = findTokenByKey(obj[k], depth + 1); if (t) return t; } catch (e) {}
    }
  }
  return null;
}

function extractToken(text) {
  if (!text) return null;
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (data) {
    const t = findTokenByKey(data, 0);
    if (t) return t;
  }
  const all = text.match(JWT_SCAN) || [];
  for (let i = 0; i < all.length; i++) {
    if (isRefreshToken(all[i])) return all[i];
  }
  return null;
}

// 手机号脱敏：138****6351
function maskPhone(p) {
  if (!p) return "";
  const m = String(p).match(/(\d{3})\d{4}(\d{4})/);
  return m ? m[1] + "****" + m[2] : "";
}

// 手机尾号：6351
function phoneTail(p) {
  if (!p) return "";
  const m = String(p).match(/(\d{4})$/);
  return m ? m[1] : "";
}

// 账号显示名：有昵称 -> 昵称（手机尾号）；无昵称 -> 脱敏手机号；都没有 -> 账号
function displayName(p) {
  if (!p) return "账号";
  const tail = phoneTail(p.preferred_username);
  if (p.nickname) {
    return tail ? (p.nickname + "（" + tail + "）") : p.nickname;
  }
  const mp = maskPhone(p.preferred_username);
  if (mp) return mp;
  return "账号";
}

// ===================== 账号存储 =====================
function loadAccounts() {
  // 1) 多账号存储
  try {
    const raw = getPrefRaw(PREF_ACCOUNTS);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.accounts)) {
        return obj.accounts.filter(function (a) { return a && a.rt && a.rt.length > 20; });
      }
    }
  } catch (e) {}
  // 2) 兼容旧单账号键：自动迁移
  const oldRt = getPrefRaw(PREF_LEGACY_RT);
  if (oldRt && oldRt.length > 20) {
    const p = decodeJwtPayload(oldRt) || {};
    return [{ sub: p.sub || "legacy", name: displayName(p), phone: maskPhone(p.preferred_username), rt: oldRt, updated: 0 }];
  }
  return [];
}

function saveAccounts(list) {
  setPref(PREF_ACCOUNTS, JSON.stringify({ accounts: list }));
}

// ===================== 模式①：登录捕获（多账号去重） =====================
function captureMode() {
  let raw = ($response && $response.body !== undefined) ? $response.body : "";
  let text = raw;
  if (raw != null && typeof raw === "object") {
    try { text = JSON.stringify(raw); } catch (e) { text = ""; }
  }
  try {
    if (typeof text === "string" && text.indexOf("eyJ") >= 0) {
      const rt = extractToken(text);
      if (rt && rt.length > 100) {
        const p = decodeJwtPayload(rt) || {};
        const sub = p.sub || ("fallback_" + rt.slice(-12));
        const name = displayName(p);
        const phone = maskPhone(p.preferred_username);
        const list = loadAccounts();
        let idx = -1;
        for (let i = 0; i < list.length; i++) { if (list[i].sub === sub) { idx = i; break; } }
        if (idx >= 0) {
          // 已存在：静默更新令牌，不重复弹通知
          list[idx].rt = rt;
          list[idx].name = name || list[idx].name;
          if (phone) list[idx].phone = phone;
          list[idx].updated = Date.now();
          saveAccounts(list);
        } else {
          list.push({ sub: sub, name: name, phone: phone, rt: rt, updated: Date.now() });
          saveAccounts(list);
          notify("🔑 已捕获账号 " + name, "当前共 " + list.length + " 个账号", "切换登录下一个账号即可继续累积；都登录完即可关闭本条重写");
        }
      }
    }
  } catch (e) {}
  $done({ body: raw != null ? raw : "" });
}

// ===================== 单账号 API =====================
async function refreshAccount(rt) {
  if (!rt || rt.length < 20) throw new Error("令牌缺失，请重新登录该账号");
  const resp = await httpRequest(REFRESH_URL, "POST", {
    "Content-Type": "application/json",
    "X-Refresh-Token": rt,
    "X-Auth-Refresh-Source": "plugin",
    "X-Domain": "copilot.tencent.com"
  }, "{}");
  const data = parseBody(resp);
  if (data.code !== 0 || !data.data || !data.data.accessToken) {
    throw new Error("刷新令牌失败(code=" + (data.code != null ? data.code : "?") + ")，请重新登录该账号");
  }
  return { accessToken: data.data.accessToken, newRt: data.data.refreshToken || "" };
}

async function fetchStatus(token) {
  const resp = await httpRequest(STATUS_URL, "POST", headersWithToken(token), "{}");
  const data = parseBody(resp);
  if (data.code === 0 && data.data) {
    const d = data.data;
    return {
      already: d.today_checked_in === true,
      streak: d.streak_days != null ? d.streak_days : null,
      dailyCredit: d.daily_credit != null ? d.daily_credit : null   // 今日真实额度（第7天为1000）
    };
  }
  if (String(data.code) === "10001") return { already: true, streak: null, dailyCredit: null };
  return { already: false, streak: null, dailyCredit: null };
}

async function checkinAccount(token) {
  const resp = await httpRequest(CHECKIN_URL, "POST", headersWithToken(token), "{}");
  const data = parseBody(resp);
  if (data.code === 0) {
    const dd = data.data || {};
    return {
      status: "clicked",
      credit: dd.credit != null ? dd.credit : null,      // 实际到账积分
      streak: dd.streak_days != null ? dd.streak_days : null
    };
  }
  if (String(data.code) === "10001" || /已签到/.test(data.msg || data.message || "")) {
    return { status: "skip_already_signed", credit: null, streak: null };
  }
  return { status: "error:" + (data.msg || data.message || data.code), credit: null, streak: null };
}

async function travelFlow(token) {
  try {
    const sResp = await httpRequest(TRAVEL_STATUS_URL, "GET", headersWithToken(token), undefined);
    const sData = parseBody(sResp);
    if (sData.code !== 0 || !sData.data) return "unavailable";
    const st = sData.data;

    if (st.state === "arrived") {
      await httpRequest(TRAVEL_CLAIM_URL, "POST", headersWithToken(token), "{}");
      const s2Resp = await httpRequest(TRAVEL_STATUS_URL, "GET", headersWithToken(token), undefined);
      const s2Data = parseBody(s2Resp);
      if (s2Data.code === 0 && s2Data.data) {
        if (s2Data.data.state === "idle" && s2Data.data.daily_limit_reached !== true) {
          await httpRequest(TRAVEL_DEPART_URL, "POST", headersWithToken(token),
            JSON.stringify({ location_id: Math.floor(Math.random() * 4) + 1 }));
          return "claimed_and_departed";
        }
        return "claimed";
      }
      return "claimed";
    }
    if (st.state === "idle" && st.daily_limit_reached !== true) {
      await httpRequest(TRAVEL_DEPART_URL, "POST", headersWithToken(token),
        JSON.stringify({ location_id: Math.floor(Math.random() * 4) + 1 }));
      return "departed";
    }
    if (st.state === "traveling") return "traveling";
    return "daily_limit_reached";
  } catch (e) { return "unavailable"; }
}

async function getBalance(token) {
  try {
    const resp = await httpRequest(BALANCE_URL, "POST", headersWithToken(token), "{}");
    const data = parseBody(resp);
    if (data && data.code === 0 && data.data) {
      const v = data.data.TotalCredits;
      if (v != null && v !== "" && !isNaN(Number(v))) return Number(v);
    }
  } catch (e) {}
  return null;
}

function formatBalance(v) {
  if (v == null || isNaN(v)) return "";
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

// ===================== 模式②：多账号签到任务 =====================
function travelLine(t) {
  switch (t) {
    case "claimed_and_departed": return "🐱 已领奖·已再派";
    case "departed": return "🐱 Buddy 已出发";
    case "claimed": return "🐱 旅行奖励已领";
    case "traveling": return "🐱 旅行中";
    case "daily_limit_reached": return "🐱 今日次数已用完";
    default: return "";
  }
}

function buildAccountText(r) {
  const lines = ["👤 " + r.name];
  if (r.error) {
    lines.push("⚠️ " + r.error);
    return lines.join("\n");
  }
  const balText = formatBalance(r.balance);
  // 领取积分必须真实：clicked 用实际到账 credit，已签用状态接口 daily_credit；没有就不显示
  const gain = r.dailyCredit != null ? r.dailyCredit : null;
  const gainText = gain != null ? " +" + gain : "";
  let signText;
  if (r.checkin === "clicked") signText = "🎉 签到成功" + gainText;
  else if (r.checkin === "skip_already_signed") signText = "✅ 今日已签到" + gainText;
  else signText = "⚠️ " + r.checkin;
  lines.push(signText + (balText ? "　💰 " + balText : ""));
  const detail = [];
  if (r.streak != null) detail.push("📅 连签" + r.streak + "天");
  const tl = travelLine(r.travel);
  if (tl) detail.push(tl);
  if (detail.length) lines.push(detail.join("　"));
  return lines.join("\n");
}

async function processAccount(acc) {
  const r = {
    name: acc.name || acc.phone || "账号",
    error: null, checkin: "", balance: null, dailyCredit: null,
    streak: null, travel: "", gained: false
  };
  let token = "";
  try {
    const tok = await refreshAccount(acc.rt);
    if (tok.newRt) acc.rt = tok.newRt;   // 回写轮换后的令牌
    token = tok.accessToken;

    const st = await fetchStatus(token);
    if (st.streak != null) r.streak = st.streak;
    if (st.dailyCredit != null) r.dailyCredit = st.dailyCredit;

    if (st.already) {
      r.checkin = "skip_already_signed";
    } else {
      const ci = await checkinAccount(token);
      r.checkin = ci.status;
      if (ci.credit != null) r.dailyCredit = ci.credit;   // 实际到账优先
      if (ci.streak != null) r.streak = ci.streak;
      if (ci.status === "clicked") r.gained = true;
    }

    r.travel = await travelFlow(token);
    if (r.travel === "claimed" || r.travel === "claimed_and_departed") r.gained = true;

    // 有积分到账则等入账，再查真实余额
    if (r.gained) await sleep(1000);
    r.balance = await getBalance(token);
  } catch (e) {
    r.error = e && e.message ? e.message : String(e);
    if (token && r.balance == null) { try { r.balance = await getBalance(token); } catch (e2) {} }
  }
  return r;
}

async function runTasks() {
  const accounts = loadAccounts();
  if (!accounts.length) {
    notify("🎯 WorkBuddy 签到", "⚠️ 未捕获任何账号", "请先在手机上登录 WorkBuddy 让脚本捕获令牌；多账号请依次切换登录");
    $done();
    return;
  }

  const results = [];
  for (let i = 0; i < accounts.length; i++) {
    results.push(await processAccount(accounts[i]));   // 串行，避免并发限流
  }
  saveAccounts(accounts);   // 保存各账号轮换后的新令牌

  const total = results.length;
  const okCount = results.filter(function (r) { return !r.error; }).length;
  const title = "🎯 WorkBuddy 签到" + (total > 1 ? "（" + total + "个账号）" : "");
  const sub = okCount === total
    ? "✅ 全部完成 " + okCount + "/" + total
    : "⚠️ " + okCount + "成功 / " + (total - okCount) + "失败";
  const body = results.map(buildAccountText).join("\n━━━━━━━━━━\n");

  notify(title, sub, body);
  console.log(JSON.stringify(results));
  $done();
}

// ===================== 入口：按环境分流 =====================
if (IS_REWRITE) {
  captureMode();
} else {
  runTasks();
}
