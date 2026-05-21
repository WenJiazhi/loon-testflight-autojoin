/*
 * Loon TestFlight Auto Join
 *
 * Inputs from plugin:
 * - TF_CODES: comma/newline separated invite codes or full join links.
 * - MAX_PER_RUN: optional, default 8, max 20.
 * - REMOVE_404: 1 removes invalid/expired codes, 0 keeps them.
 *
 * Legacy compatibility:
 * - Existing APP_ID values from older Auto_join_TF scripts are imported.
 */

const PREFIX = "tfaj.";
const KEYS = {
  account: PREFIX + "account",
  codes: PREFIX + "codes",
  done: PREFIX + "done",
  lastNoAccountNotice: PREFIX + "lastNoAccountNotice",
  legacyCodes: "APP_ID"
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

      if (changed) {
        messages.push("account saved");
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
      messages.push("code added: " + added.join(","));
      log("captured invite code: " + added.join(","));
    }
  }

  if (messages.length) {
    notify("TestFlight Auto Join", "capture updated", messages.join(" | "));
  }
}

async function runAutoJoin() {
  importConfiguredCodes();

  const account = readJson(KEYS.account, null);
  const queue = readJson(KEYS.codes, []);
  const doneSet = toSet(readJson(KEYS.done, []));
  const codes = unique(queue).filter(code => !doneSet[code]);

  writeJson(KEYS.codes, codes);

  if (!codes.length) {
    log("no invite codes to check");
    return;
  }

  if (!account || !account.accountId || !account.headers) {
    maybeNotifyNoAccount();
    log("missing TestFlight session. Open TestFlight once with Loon MITM enabled.");
    return;
  }

  const maxPerRun = readInt(["MAX_PER_RUN", "max_per_run"], 8, 1, 20);
  const remove404 = readBool(["REMOVE_404", "remove404"], false);
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

function importConfiguredCodes() {
  const rawItems = [
    readStore("TF_CODES"),
    readStore("tf_codes"),
    readStore("TESTFLIGHT_CODES"),
    readStore(KEYS.legacyCodes)
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

  const legacy = extractInviteCodes(readStore(KEYS.legacyCodes) || "").filter(item => item !== code);
  if (legacy.length) {
    writeStore(KEYS.legacyCodes, legacy.join(","));
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
    if (/^[A-Za-z0-9_-]{6,80}$/.test(cleaned)) {
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
    notify("TestFlight Auto Join", "missing session", "open TestFlight once while Loon MITM is enabled");
  }
}

function readBool(keys, fallback) {
  for (let i = 0; i < keys.length; i++) {
    const value = readStore(keys[i]);
    if (value === null || value === undefined || value === "") {
      continue;
    }
    return /^(1|true|yes|on)$/i.test(String(value).trim());
  }
  return fallback;
}

function readInt(keys, fallback, min, max) {
  for (let i = 0; i < keys.length; i++) {
    const raw = readStore(keys[i]);
    const value = Number(raw);
    if (Number.isFinite(value)) {
      return Math.max(min, Math.min(max, Math.floor(value)));
    }
  }
  return fallback;
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

function notify(title, subtitle, message) {
  try {
    $notification.post(String(title || ""), String(subtitle || ""), String(message || ""), { "auto-dismiss": 5 });
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
