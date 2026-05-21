/*
 * Loon TestFlight Auto Join
 *
 * Inputs from plugin:
 * - App_ID: comma/newline separated invite codes or full join links.
 * - MAX_PER_RUN: optional, default 8, max 20.
 * - REMOVE_404: 1 removes invalid/expired codes, 0 keeps them.
 *
 * Legacy compatibility:
 * - Existing App_ID/APP_ID and fmz200_TF_header values from Kelee/fmz200 scripts are imported.
 */

const PREFIX = "tfaj.";
const KEYS = {
  account: PREFIX + "account",
  codes: PREFIX + "codes",
  done: PREFIX + "done",
  lastNoAccountNotice: PREFIX + "lastNoAccountNotice"
};
const COMPAT_HEADER_KEY = "fmz200_TF_header";
const ARGUMENTS = parseArguments(typeof $argument === "string" ? $argument : "");
const PLACEHOLDER_VALUES = {
  App_ID: true,
  APP_ID: true,
  TF_CODES: true,
  MAX_PER_RUN: true,
  REMOVE_404: true
};

const CAPTURE_HEADER_MAP = {
  "user-agent": "User-Agent",
  "accept-language": "Accept-Language",
  "x-session-id": "X-Session-Id",
  "x-session-digest": "X-Session-Digest",
  "x-request-id": "X-Request-Id",
  "x-apple-store-front": "X-Apple-Store-Front",
  "x-apple-locale": "X-Apple-Locale",
  "x-apple-amd-x": "X-Apple-AMD-X",
  "x-apple-i-md": "X-Apple-I-MD",
  "x-apple-i-md-m": "X-Apple-I-MD-M",
  "x-apple-i-md-rinfo": "X-Apple-I-MD-RINFO",
  "x-apple-i-client-time": "X-Apple-I-Client-Time",
  "x-apple-i-timezone": "X-Apple-I-TimeZone"
};

!(async function main() {
  try {
    if (typeof $request !== "undefined" && $request) {
      handleCapture($request);
      $done({});
      return;
    }

    await runAutoJoin();
    $done();
  } catch (error) {
    log("fatal: " + stringifyError(error));
    notify("TestFlight Auto Join", "script error", stringifyError(error));
    $done();
  }
})();

function handleCapture(request) {
  const url = request.url || "";
  const accountId = extractAccountId(url);
  const code = extractInviteCode(url);
  const messages = [];

  if (accountId) {
    const headers = captureHeaders(request.headers || {});
    if (headers["X-Session-Id"] && headers["X-Session-Digest"]) {
      const previous = readJson(KEYS.account, null);
      const changed = !previous ||
        previous.accountId !== accountId ||
        !previous.headers ||
        previous.headers["X-Session-Id"] !== headers["X-Session-Id"] ||
        previous.headers["X-Session-Digest"] !== headers["X-Session-Digest"];

      writeJson(KEYS.account, {
        accountId,
        headers,
        capturedAt: new Date().toISOString()
      });
      writeJson(COMPAT_HEADER_KEY, {
        key: accountId,
        session_id: headers["X-Session-Id"],
        session_digest: headers["X-Session-Digest"],
        request_id: headers["X-Request-Id"],
        tf_ua: headers["User-Agent"],
        update_time: formatLocalTime()
      });

      if (changed) {
        messages.push("令牌获取成功");
        log("captured account: " + accountId);
      } else {
        log("account session refreshed: " + accountId);
      }
    } else {
      log("matched TestFlight API request, but required session headers were missing");
    }
  }

  if (code) {
    const added = mergeCodes([code]);
    if (added.length) {
      syncAppIdStore();
      messages.push("已添加APP_ID: " + added.join(","));
      log("captured invite code: " + added.join(","));
    }
  }

  if (messages.length) {
    notify("TestFlight Auto Join", "", messages.join(" | "));
  }
}

async function runAutoJoin() {
  importConfiguredCodes();

  const account = getAccount();
  const queue = readJson(KEYS.codes, []);
  const doneSet = toSet(readJson(KEYS.done, []));
  const codes = unique(queue).filter(code => !doneSet[code]);

  writeJson(KEYS.codes, codes);

  const maxPerRun = readInt(["MAX_PER_RUN", "max_per_run"], 8, 1, 20);
  const remove404 = readBool(["REMOVE_404", "remove404"], false);

  if (!codes.length) {
    notify("TestFlight Auto Join", "未添加 App_ID", "在插件参数 App_ID 填入邀请码，例如 wUz8czx3");
    log("no invite codes to check");
    return;
  }

  if (!account || !account.accountId || !account.headers) {
    await monitorPublicLinks(codes.slice(0, maxPerRun));
    maybeNotifyNoAccount();
    log("missing TestFlight session. Public join pages were monitored instead; auto-accept requires a captured token.");
    return;
  }

  const runCodes = codes.slice(0, maxPerRun);
  log("checking " + runCodes.length + "/" + codes.length + " code(s)");

  for (let i = 0; i < runCodes.length; i++) {
    const code = runCodes[i];
    const result = await checkAndJoin(account, code, remove404);

    if (result.remove) {
      removeCode(code);
    }

    if (result.done) {
      markDone(code);
      removeCode(code);
    }

    if (result.stop) {
      break;
    }

    await sleep(700);
  }
}

async function checkAndJoin(account, code, remove404) {
  const baseUrl = "https://testflight.apple.com/v3/accounts/" + account.accountId + "/ru/" + code;
  const headers = buildRequestHeaders(account.headers);
  const info = await http("get", { url: baseUrl, headers });

  if (info.error) {
    log(code + " check failed: " + stringifyError(info.error));
    return {};
  }

  const status = Number(info.response && info.response.status);

  if (status === 404) {
    log(code + " is 404" + (remove404 ? ", removing" : ", keeping"));
    if (remove404) {
      notify("TestFlight link invalid", code, "removed from queue");
    }
    return { remove: remove404 };
  }

  if (status === 401 || status === 403) {
    notify("TestFlight session expired", "open TestFlight again", "headers need to be captured again");
    log(code + " auth failed: " + status);
    return { stop: true };
  }

  if (status === 429) {
    notify("TestFlight rate limited", "stopped this run", "next cron run will retry");
    log(code + " rate limited");
    return { stop: true };
  }

  if (status < 200 || status >= 300) {
    log(code + " unexpected status: " + status);
    return {};
  }

  const payload = parseJson(info.data);
  const data = payload && payload.data;
  const appName = appNameFrom(data, code);

  if (!data) {
    log(code + " has no data: " + summarizeMessages(payload));
    return {};
  }

  if (String(data.status || "").toUpperCase() === "FULL") {
    log(appName + " (" + code + ") is full");
    return {};
  }

  const accepted = await http("post", { url: baseUrl + "/accept", headers });
  const acceptStatus = Number(accepted.response && accepted.response.status);

  if (accepted.error) {
    log(code + " accept failed: " + stringifyError(accepted.error));
    return {};
  }

  if (acceptStatus === 200 || acceptStatus === 201) {
    const body = parseJson(accepted.data);
    const name = appNameFrom(body && body.data, appName);
    notify("TestFlight joined", name, code);
    log(name + " (" + code + ") joined");
    return { done: true };
  }

  if (acceptStatus === 401 || acceptStatus === 403) {
    notify("TestFlight session expired", "open TestFlight again", "headers need to be captured again");
    log(code + " accept auth failed: " + acceptStatus);
    return { stop: true };
  }

  if (acceptStatus === 429) {
    notify("TestFlight rate limited", "stopped this run", "next cron run will retry");
    log(code + " accept rate limited");
    return { stop: true };
  }

  const bodyText = String(accepted.data || "");
  if (/already|accepted|enrolled|joined/i.test(bodyText)) {
    notify("TestFlight already joined", appName, code);
    log(appName + " (" + code + ") already joined");
    return { done: true };
  }

  log(code + " accept returned status " + acceptStatus + ": " + truncate(bodyText, 240));
  return {};
}

async function monitorPublicLinks(codes) {
  log("no token available, monitoring public join page(s): " + codes.join(","));
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const result = await checkPublicJoinPage(code);
    if (result.available) {
      notify(
        "TestFlight available",
        result.name || code,
        "tap to open " + code,
        { openUrl: "https://testflight.apple.com/join/" + code }
      );
    }
    await sleep(500);
  }
}

async function checkPublicJoinPage(code) {
  const url = "https://testflight.apple.com/join/" + code;
  const response = await http("get", {
    url,
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    }
  });

  if (response.error) {
    log(code + " public monitor failed: " + stringifyError(response.error));
    return {};
  }

  const status = Number(response.response && response.response.status);
  const body = String(response.data || "");

  if (status === 404) {
    log(code + " public page: 404");
    return {};
  }

  if (status < 200 || status >= 300) {
    log(code + " public page status: " + status);
    return {};
  }

  if (/This beta is full|版本的测试员已满|测试员已满/i.test(body)) {
    log(code + " public page: full");
    return {};
  }

  if (/This beta isn't accepting any new testers|版本目前不接受任何新测试员|不接受任何新测试员/i.test(body)) {
    log(code + " public page: not accepting");
    return {};
  }

  if (/To join the|要加入 Beta 版|View in TestFlight|在 TestFlight 中查看/i.test(body)) {
    log(code + " public page: available");
    return { available: true, name: extractPublicPageName(body) };
  }

  log(code + " public page: unknown but reachable");
  return {};
}

function extractPublicPageName(body) {
  const title = String(body || "").match(/<title>\s*([^<]+?)\s*-\s*TestFlight\s*<\/title>/i);
  if (title && title[1]) {
    return decodeHtml(title[1].trim());
  }
  const ogTitle = String(body || "").match(/property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (ogTitle && ogTitle[1]) {
    return decodeHtml(ogTitle[1].trim());
  }
  return "";
}

function importConfiguredCodes() {
  const rawItems = [
    readArgument("App_ID"),
    readArgument("APP_ID"),
    readArgument("TF_CODES"),
    readStore("TF_CODES"),
    readStore("tf_codes"),
    readStore("TESTFLIGHT_CODES"),
    readStore("App_ID"),
    readStore("APP_ID")
  ];

  const codes = [];
  rawItems.forEach(item => {
    codes.push.apply(codes, extractInviteCodes(item || ""));
  });

  const added = mergeCodes(codes);
  if (added.length) {
    log("imported invite code(s): " + added.join(","));
  }
}

function mergeCodes(codes) {
  const doneSet = toSet(readJson(KEYS.done, []));
  const current = readJson(KEYS.codes, []);
  const set = toSet(current);
  const added = [];

  unique(codes).forEach(code => {
    if (!doneSet[code] && !set[code]) {
      current.push(code);
      set[code] = true;
      added.push(code);
    }
  });

  if (added.length) {
    writeJson(KEYS.codes, current);
  }

  return added;
}

function removeCode(code) {
  const codes = readJson(KEYS.codes, []).filter(item => item !== code);
  writeJson(KEYS.codes, codes);

  ["App_ID", "APP_ID", "TF_CODES"].forEach(key => {
    const legacy = extractInviteCodes(readStore(key) || "").filter(item => item !== code);
    writeStore(key, legacy.join(","));
  });
}

function syncAppIdStore() {
  const codes = readJson(KEYS.codes, []);
  if (codes.length) {
    writeStore("App_ID", codes.join(","));
  }
}

function markDone(code) {
  const done = unique(readJson(KEYS.done, []).concat([code]));
  writeJson(KEYS.done, done);
}

function buildRequestHeaders(captured) {
  const headers = {};
  Object.keys(captured || {}).forEach(key => {
    if (captured[key]) {
      headers[key] = captured[key];
    }
  });
  headers.Accept = headers.Accept || "application/json";
  return headers;
}

function captureHeaders(headers) {
  const lower = {};
  Object.keys(headers || {}).forEach(key => {
    lower[String(key).toLowerCase()] = headers[key];
  });

  const captured = {};
  Object.keys(CAPTURE_HEADER_MAP).forEach(lowerName => {
    if (lower[lowerName]) {
      captured[CAPTURE_HEADER_MAP[lowerName]] = lower[lowerName];
    }
  });
  return captured;
}

function getAccount() {
  const account = readJson(KEYS.account, null);
  if (account && account.accountId && account.headers) {
    return account;
  }

  const compat = readJson(COMPAT_HEADER_KEY, null);
  if (!compat || !compat.key) {
    return null;
  }

  const headers = {
    "X-Session-Id": compat.session_id,
    "X-Session-Digest": compat.session_digest,
    "X-Request-Id": compat.request_id,
    "User-Agent": compat.tf_ua
  };

  if (!headers["X-Session-Id"] || !headers["X-Session-Digest"]) {
    return null;
  }

  return {
    accountId: compat.key,
    headers,
    capturedAt: compat.update_time || ""
  };
}

function extractAccountId(url) {
  const match = String(url || "").match(/^https:\/\/testflight\.apple\.com\/v3\/accounts\/([^/]+)\//);
  return match ? match[1] : "";
}

function extractInviteCode(url) {
  return extractInviteCodes(url)[0] || "";
}

function extractInviteCodes(input) {
  const text = String(input || "");
  const codes = [];
  const urlPattern = /https:\/\/testflight\.apple\.com\/(?:join\/|v3\/accounts\/[^/]+\/ru\/)([A-Za-z0-9_-]{6,80})/g;
  let match;

  while ((match = urlPattern.exec(text)) !== null) {
    codes.push(match[1]);
  }

  text.split(/[\s,;|]+/).forEach(part => {
    const cleaned = part
      .replace(/^.*\/join\//, "")
      .replace(/^.*\/ru\//, "")
      .replace(/[?#].*$/, "")
      .trim();
    if (/^[A-Za-z0-9_-]{6,80}$/.test(cleaned) && !PLACEHOLDER_VALUES[cleaned]) {
      codes.push(cleaned);
    }
  });

  return unique(codes);
}

function http(method, request) {
  return new Promise(resolve => {
    const client = $httpClient && $httpClient[method];
    if (!client) {
      resolve({ error: "missing $httpClient." + method });
      return;
    }

    client(request, (error, response, data) => {
      resolve({ error, response, data });
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => {
    if (typeof setTimeout === "function") {
      setTimeout(resolve, ms);
    } else {
      resolve();
    }
  });
}

function maybeNotifyNoAccount() {
  const now = Date.now();
  const last = Number(readStore(KEYS.lastNoAccountNotice) || 0);
  if (!last || now - last > 6 * 60 * 60 * 1000) {
    writeStore(KEYS.lastNoAccountNotice, String(now));
    notify("TestFlight Auto Join", "无账号令牌", "已降级为公开页监控；全自动加入仍需要令牌");
  }
}

function readBool(keys, fallback) {
  for (let i = 0; i < keys.length; i++) {
    const value = readConfig(keys[i]);
    if (value === null || value === undefined || value === "") {
      continue;
    }
    return /^(1|true|yes|on)$/i.test(String(value).trim());
  }
  return fallback;
}

function readInt(keys, fallback, min, max) {
  for (let i = 0; i < keys.length; i++) {
    const raw = readConfig(keys[i]);
    const value = Number(raw);
    if (Number.isFinite(value)) {
      return Math.max(min, Math.min(max, Math.floor(value)));
    }
  }
  return fallback;
}

function readConfig(key) {
  const fromArgument = readArgument(key);
  if (fromArgument !== null && fromArgument !== undefined && fromArgument !== "") {
    return fromArgument;
  }
  return readStore(key);
}

function readArgument(key) {
  return Object.prototype.hasOwnProperty.call(ARGUMENTS, key) ? ARGUMENTS[key] : null;
}

function parseArguments(argument) {
  const result = {};
  String(argument || "").split("&").forEach(pair => {
    if (!pair) {
      return;
    }
    const index = pair.indexOf("=");
    const rawKey = index >= 0 ? pair.slice(0, index) : pair;
    const rawValue = index >= 0 ? pair.slice(index + 1) : "";
    const key = decodeURIComponent(rawKey || "").trim();
    if (!key) {
      return;
    }
    result[key] = decodeURIComponent(rawValue || "").trim();
  });
  return result;
}

function readJson(key, fallback) {
  const raw = readStore(key);
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    log("failed to parse " + key + ": " + stringifyError(error));
    return fallback;
  }
}

function writeJson(key, value) {
  writeStore(key, JSON.stringify(value));
}

function readStore(key) {
  try {
    return $persistentStore.read(key);
  } catch (error) {
    return null;
  }
}

function writeStore(key, value) {
  try {
    return $persistentStore.write(String(value), key);
  } catch (error) {
    log("failed to write " + key + ": " + stringifyError(error));
    return false;
  }
}

function notify(title, subtitle, message, options) {
  try {
    const opts = options || {};
    if (!opts["auto-dismiss"]) {
      opts["auto-dismiss"] = 5;
    }
    $notification.post(String(title || ""), String(subtitle || ""), String(message || ""), opts);
  } catch (error) {
    log([title, subtitle, message].filter(Boolean).join(" | "));
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch (error) {
    return null;
  }
}

function appNameFrom(data, fallback) {
  return (data && data.app && data.app.name) || (data && data.name) || fallback || "TestFlight";
}

function summarizeMessages(payload) {
  if (!payload || !payload.messages) {
    return "empty response";
  }
  return payload.messages.map(item => item.message || item).join("; ");
}

function truncate(text, maxLength) {
  text = String(text || "");
  return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function unique(list) {
  const set = {};
  const result = [];
  (list || []).forEach(item => {
    const value = String(item || "").trim();
    if (value && !set[value]) {
      set[value] = true;
      result.push(value);
    }
  });
  return result;
}

function toSet(list) {
  const set = {};
  (list || []).forEach(item => {
    set[item] = true;
  });
  return set;
}

function stringifyError(error) {
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  return error.message || JSON.stringify(error);
}

function log(message) {
  console.log("[TF AutoJoin] " + message);
}

function formatLocalTime() {
  const date = new Date();
  const pad = value => String(value).padStart(2, "0");
  return date.getFullYear() + "-" +
    pad(date.getMonth() + 1) + "-" +
    pad(date.getDate()) + " " +
    pad(date.getHours()) + ":" +
    pad(date.getMinutes()) + ":" +
    pad(date.getSeconds());
}
