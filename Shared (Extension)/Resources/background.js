// AD101 - background（Manifest V3 Service Worker，兼容 iOS 15.4+ / iOS 27 Safari）
// 注意：MV3 下 background 是 Service Worker，没有 window / DOM，统一使用 globalThis。
const browser = globalThis.browser ?? globalThis.chrome;

// 为后台请求增加超时保护，避免上游无响应时长期挂起（Service Worker 中使用 globalThis.fetch）
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = function (input, opts) {
    const timeoutMs = opts?.timeout || 2000;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fetch timeout')), timeoutMs);
        originalFetch(input, opts || {}).then(
            (res) => { clearTimeout(timer); resolve(res); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
};

// setter 返回 Promise，便于调用方 await（原版丢弃了 Promise，写入失败无从感知）
const storage = {
    set rules(value) {
        return browser.storage.local.set({ "rules": value });
    },
    get rules() {
        return browser.storage.local.get(["rules"]);
    },
    set rules_version(value) {
        return browser.storage.local.set({ "rules_version": value });
    },
    get rules_version() {
        return browser.storage.local.get(["rules_version"]);
    },
};

// 原生通道的应用标识。Safari 会把 sendNativeMessage 路由到容器 App 的
// SafariWebExtensionHandler（applicationId 参数被忽略），此处填写容器 App 的 bundle id 仅作标识。
// 若原生侧未实现对应命令，sendNativeMessage 会失败并被 catch 捕获，规则回退到默认值，不影响扩展功能。
const NATIVE_APP_ID = 'com.ad101.ios';

// ===== DNR 规则开关 =====

function ruleset(enabled) {
    const action = enabled
        ? { enableRulesetIds: ['ruleset_1'], disableRulesetIds: [] }
        : { enableRulesetIds: [], disableRulesetIds: ['ruleset_1'] };
    browser.declarativeNetRequest.updateEnabledRulesets(action).catch(() => { });
}

// ===== 规则初始化 / 同步 =====

async function init_rules() {
    // SW 每次启动都向原生拉取一次规则：sendNativeMessage 是本地 IPC 成本极低，
    // 且保证 rules.json 更新（如垃圾站点名单）随 Safari 冷启动即时生效
    await sync_rules();
    applyStoredJunkRules();
}

// 通过 Safari 原生通道获取最新规则（browser.* 为 Promise API）
async function sync_rules() {
    try {
        const res = await browser.runtime.sendNativeMessage(NATIVE_APP_ID, { cmd: "get_rules" });
        const rules = res?.data;
        // 结构校验：content.js 依赖 domains.domain_list 做站点匹配，
        // 不合格的数据不写入 storage，避免覆盖掉可用规则（含内置默认值）
        if (rules && rules.domains && rules.domains.domain_list) {
            await browser.storage.local.set({
                rules,
                rules_synced_at: Date.now(),
                ...(rules.rules_version != null ? { rules_version: rules.rules_version } : {}),
            });
            applyJunkRules(rules).catch((e) => console.warn('[ad101] applyJunkRules failed:', e));
            syncSubscription(rules).catch((e) => console.warn('[ad101] syncSubscription failed:', e));
        } else {
            console.warn('[ad101] sync_rules: invalid rules payload, keep current rules');
        }
    } catch (e) {
        // 没有配套原生 App 时必然失败，此时 content 侧会回退到内置默认规则
        console.warn('[ad101] sync_rules failed:', e);
    }
}

// ===== 垃圾站点拦截（域名/IP 黑名单，DNR 动态规则） =====
// 名单来自 rules.json 的 junkBlock（原生通道热更新），urlFilter ||domain^ 同时匹配
// 导航与子资源；id >= 10000 为本模块专属段，apply 前先清段保证幂等。
const JUNK_RULE_ID_BASE = 10000;
// 广告规则订阅（ABP 兼容清单，如 AWAvenue）：id >= 20000 专属段
const SUB_RULE_ID_BASE = 20000;
const SUB_MAX_RULES = 4900;          // DNR 动态规则配额（Chrome/Safari 上限 5000+），留余量
const DNR_RESOURCE_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'];

// 幂等写入某 id 段的动态规则：先清段再添加
async function setDnrRules(idBase, filters) {
    const dnr = browser.declarativeNetRequest;
    if (!dnr || typeof dnr.updateDynamicRules !== 'function' || typeof dnr.getDynamicRules !== 'function') {
        return; // Safari 16.4 以下无此 API，静默降级
    }
    try {
        const existing = await dnr.getDynamicRules();
        const removeRuleIds = existing
            .map((r) => r.id)
            .filter((id) => id >= idBase && id < idBase + 10000);
        const addRules = filters.map((f, i) => ({
            id: idBase + i,
            priority: 100,
            action: { type: 'block' },
            condition: { urlFilter: f, resourceTypes: DNR_RESOURCE_TYPES },
        }));
        await dnr.updateDynamicRules({ removeRuleIds, addRules });
    } catch (e) {
        console.warn('[ad101] setDnrRules failed (idBase=' + idBase + '):', e);
    }
}

async function applyJunkRules(rules) {
    const junk = rules?.junkBlock;
    const enabled = junk && junk.status && (junk.domains?.length || junk.ips?.length);
    const targets = enabled
        ? [...(junk.domains ?? []), ...(junk.ips ?? [])]
            .filter((h) => typeof h === 'string' && h.trim())
            .map((h) => `||${h.trim()}^`)
        : [];
    await setDnrRules(JUNK_RULE_ID_BASE, targets);
}

// ===== 广告规则订阅（ABP 兼容清单，如 AWAvenue Ads Rule） =====
// 配置来自 rules.json 的 subscription（原生通道热更新）；清单缓存到 storage，
// 24h 节流 + URL 变更即刷，拉取失败沿用上次名单。
const SUB_FILTERS_KEY = 'ad101.sub.filters';
const SUB_SYNCED_AT_KEY = 'ad101.sub.synced_at';
const SUB_URL_KEY = 'ad101.sub.url';
const SUB_SYNC_INTERVAL = 24 * 3600 * 1000;

function parseFilterList(text) {
    // ABP 兼容清单 → DNR urlFilter：||domain^、*通配* 均可直接使用；
    // 暂不支持的语法（注释/白名单/选项/正则）直接剔除
    return text.split('\n')
        .map((l) => l.trim())
        .filter((l) => l
            && !l.startsWith('!') && !l.startsWith('#')     // 注释
            && !l.startsWith('@@')                           // 白名单
            && !l.includes('$')                              // 选项语法
            && !l.startsWith('/'))                           // 正则语法
        .slice(0, SUB_MAX_RULES);
}

async function syncSubscription(rules) {
    const dnr = browser.declarativeNetRequest;
    if (!dnr || typeof dnr.updateDynamicRules !== 'function') return;

    let cfg = rules?.subscription;
    if (!cfg) {
        const stored = await browser.storage.local.get(['rules']);
        cfg = stored?.rules?.subscription;
    }

    const store = await browser.storage.local.get([SUB_FILTERS_KEY, SUB_SYNCED_AT_KEY, SUB_URL_KEY]);
    const cached = store[SUB_FILTERS_KEY] ?? [];
    const lastUrl = store[SUB_URL_KEY];
    const syncedAt = store[SUB_SYNCED_AT_KEY] ?? 0;

    if (!cfg || !cfg.status || !cfg.url) {
        if (cached.length) await setDnrRules(SUB_RULE_ID_BASE, []); // 配置关闭：清规则
        return;
    }

    const urlChanged = lastUrl !== cfg.url;
    if (!urlChanged && Date.now() - syncedAt < SUB_SYNC_INTERVAL) {
        await setDnrRules(SUB_RULE_ID_BASE, cached); // 未到期：用缓存幂等应用
        return;
    }

    try {
        const res = await fetch(cfg.url, { timeout: 20000 });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const filters = parseFilterList(await res.text());
        await browser.storage.local.set({
            [SUB_FILTERS_KEY]: filters,
            [SUB_SYNCED_AT_KEY]: Date.now(),
            [SUB_URL_KEY]: cfg.url,
        });
        await setDnrRules(SUB_RULE_ID_BASE, filters);
        console.log('[ad101] subscription synced:', filters.length, 'filters from', cfg.url);
    } catch (e) {
        console.warn('[ad101] subscription sync failed, keep cached:', e);
        if (cached.length) await setDnrRules(SUB_RULE_ID_BASE, cached);
    }
}

async function applyStoredJunkRules() {
    try {
        const { rules } = await browser.storage.local.get(['rules']);
        if (rules) await applyJunkRules(rules);
    } catch (e) {
        console.warn('[ad101] applyStoredJunkRules failed:', e);
    }
}

async function getRules() {
    const { rules } = await storage.rules;
    return rules;
}

// ===== 拦截统计上报（容器 App 仪表盘数据源） =====
// 分类：domain/<site>/read.js → read；domain/<site>/call.js → adblock；
//       jumpapp/<app>/content.<engine>.js → nojump。
// 注意：jumpapp/tc.<engine>.js（搜索页公共脚本）与 nojump.*.js（空文件）必须排除，否则计数翻倍。
const STATS_KEY = 'ad101.stats.pending';
const LOG_KEY = 'ad101.log';        // 事件流水（popup 展示），环形保留最近 100 条
const LOG_MAX = 100;
const FLUSH_DELAY_MS = 800;
const DEDUP_TTL_MS = 10000;

let pendingStats = null;          // { batch, day, delta: { read|adblock|nojump: {count, sites} } }
const statsDedup = new Map();     // `${tabId}|${url}|${cat}|${host}` -> ts
let statsFlushTimer = null;

function categorizeInject(code) {
    if (typeof code !== 'string') return null;
    const m = /^domain\/[^/]+\/(read|call)\.js$/.exec(code);
    if (m) return m[1] === 'read' ? 'read' : 'adblock';
    if (/^jumpapp\/[^/]+\/content\.[^/]+\.js$/.test(code)) return 'nojump';
    return null;
}

function statsToday() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function loadPendingStats() {
    try {
        const stored = await browser.storage.local.get([STATS_KEY]);
        if (stored && stored[STATS_KEY]) return stored[STATS_KEY];
    } catch (e) { /* 读不到就新建 */ }
    return {
        batch: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        day: statsToday(),
        delta: { read: { count: 0, sites: {} }, adblock: { count: 0, sites: {} }, nojump: { count: 0, sites: {} } },
        events: [],
    };
}

function statsIsEmpty(delta) {
    return Object.values(delta).every((v) => !v || !v.count);
}

// 追加事件流水（popup 展示用），环形保留最近 LOG_MAX 条
async function appendLog(evt) {
    try {
        const stored = await browser.storage.local.get([LOG_KEY]);
        const log = stored?.[LOG_KEY] ?? [];
        log.push(evt);
        while (log.length > LOG_MAX) log.shift();
        await browser.storage.local.set({ [LOG_KEY]: log });
    } catch (e) { /* 日志失败不影响主流程 */ }
}

// 注入成功后调用；归因用 active tab（inject 本来就注入 active tab）
async function recordStats(code, tab) {
    const cat = categorizeInject(code);
    if (!cat || !tab || tab.id == null || !tab.url) return;
    let host = 'unknown';
    try { host = new URL(tab.url).hostname || 'unknown'; } catch (e) { /* 保留 unknown */ }

    // 页面级去重：同 tab 同 URL 同类别 10s 内只计一次（吃掉子 frame / 多规则命中）
    const key = `${tab.id}|${tab.url}|${cat}|${host}`;
    const now = Date.now();
    if (now - (statsDedup.get(key) ?? 0) < DEDUP_TTL_MS) return;
    statsDedup.set(key, now);
    if (statsDedup.size > 200) {
        for (const [k, t] of statsDedup) if (now - t > DEDUP_TTL_MS) statsDedup.delete(k);
    }

    if (!pendingStats) pendingStats = await loadPendingStats();
    if (pendingStats.day !== statsToday()) pendingStats = null;   // 跨午夜重建批次
    if (!pendingStats) pendingStats = await loadPendingStats();
    pendingStats.delta[cat].count += 1;
    pendingStats.delta[cat].sites[host] = (pendingStats.delta[cat].sites[host] ?? 0) + 1;
    pendingStats.events.push({ t: Date.now(), cat, host });

    // 先落盘再异步 flush：SW 随时可能被杀
    try { await browser.storage.local.set({ [STATS_KEY]: pendingStats }); } catch (e) { /* 忽略 */ }
    appendLog({ t: Date.now(), cat, host });
    scheduleStatsFlush();
}

function scheduleStatsFlush() {
    if (statsFlushTimer) clearTimeout(statsFlushTimer);
    statsFlushTimer = setTimeout(() => { statsFlushTimer = null; flushStats(); }, FLUSH_DELAY_MS);
}

async function flushStats() {
    if (!pendingStats) pendingStats = await loadPendingStats();
    if (statsIsEmpty(pendingStats.delta) && !(pendingStats.events ?? []).length) {
        pendingStats = null;
        await browser.storage.local.remove(STATS_KEY).catch(() => { });
        return;
    }
    try {
        const res = await browser.runtime.sendNativeMessage(NATIVE_APP_ID, {
            cmd: 'report_stats',
            batch: pendingStats.batch,
            day: pendingStats.day,
            delta: pendingStats.delta,
            events: pendingStats.events ?? [],
        });
        if (res?.ok) {
            pendingStats = null;
            await browser.storage.local.remove(STATS_KEY).catch(() => { });
        }
        // 失败/无响应：pending 留在 storage，SW 重启后补报（幂等靠 batch）
    } catch (e) {
        console.warn('[ad101] stats flush failed:', e);
    }
}

// ===== 标签页工具 =====

async function getActiveTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0] ?? null;
}

function close() {
    getActiveTab().then((tab) => {
        if (tab) browser.tabs.remove(tab.id);
    });
}

// ===== 站点开关（P0-1） =====
// 用户意图独立存储在 site_toggles，绝不写进 rules —— rules 会被 sync_rules 整体覆盖。
// 优先级：site_toggles[host].disabled > rules 内各白名单 > extensionStatus。
const SITE_TOGGLE_KEY = 'site_toggles';

async function getSiteToggles() {
    const obj = await browser.storage.local.get([SITE_TOGGLE_KEY]);
    return obj?.[SITE_TOGGLE_KEY] ?? {};
}

// popup 只能操作 http(s) 页面；host 一律从 background 侧 tabs.query 取得，不信任调用方传参
function activeHttpHost() {
    return getActiveTab().then((tab) => {
        if (!tab?.url) return null;
        let url;
        try {
            url = new URL(tab.url);
        } catch (e) {
            return null;
        }
        return (url.protocol === 'http:' || url.protocol === 'https:') ? url.hostname : null;
    });
}

async function get_popup_state(param, sendResponse) {
    const host = await activeHttpHost();
    if (!host) {
        sendResponse({ applicable: false });
        return;
    }
    const [toggles, stored] = await Promise.all([
        getSiteToggles(),
        browser.storage.local.get(['rules', GLOBAL_TOGGLE_KEY]),
    ]);
    // 与 content.js init() 的判定保持一致：用户手动设置过全局开关则优先
    const extensionOn = typeof stored?.[GLOBAL_TOGGLE_KEY] === 'boolean'
        ? stored[GLOBAL_TOGGLE_KEY]
        : Boolean(Number(stored?.rules?.extensionStatus ?? 1));
    sendResponse({
        applicable: true,
        host,
        disabled: Boolean(toggles[host]?.disabled),
        extensionOn,
    });
}

async function set_site_toggle(param, sendResponse) {
    const host = await activeHttpHost();
    if (!host) {
        sendResponse({ ok: false });
        return;
    }
    const toggles = await getSiteToggles();
    if (param?.disabled) {
        toggles[host] = { ...(toggles[host] ?? {}), disabled: true };
    } else if (toggles[host]) {
        const entry = { ...toggles[host] };
        delete entry.disabled;
        if (Object.keys(entry).length) {
            toggles[host] = entry;
        } else {
            delete toggles[host];
        }
    }
    await browser.storage.local.set({ [SITE_TOGGLE_KEY]: toggles });
    const disabled = Boolean(toggles[host]?.disabled);
    sendResponse({ ok: true, host, disabled });
}

// 全局开关：用户意图独立存储（extension_on），rules.extensionStatus 会被 sync_rules 覆盖。
// 同时切换 DNR 规则集；undefined 表示从未手动设置过，跟随原生下发的默认值。
const GLOBAL_TOGGLE_KEY = 'extension_on';

async function set_extension_status(param, sendResponse) {
    const enabled = Boolean(param);
    await browser.storage.local.set({ [GLOBAL_TOGGLE_KEY]: enabled });
    ruleset(enabled);
    sendResponse({ ok: true, enabled });
}

async function get_extension_status() {
    const stored = await browser.storage.local.get([GLOBAL_TOGGLE_KEY]);
    return stored?.[GLOBAL_TOGGLE_KEY];
}

// ===== MV3 scripting API 注入 =====
// MV2 的 tabs.executeScript/insertCSS 已移除，统一改用 chrome.scripting。
// runAt 语义映射：document_start → injectImmediately: true；其余交由浏览器默认时机。

function buildTarget(tabId, param) {
    return param.allFrames === false
        ? { tabId }
        : { tabId, allFrames: true };
}

function buildInjectOptions(param) {
    return {
        injectImmediately: param.runAt === 'document_start',
    };
}

async function inject(param) {
    const tab = await getActiveTab();
    if (!tab) return;

    try {
        if (param.type === 'set_frame_path') {
            // MV3 不允许注入任意 code 字符串，改用 func + args
            await browser.scripting.executeScript({
                target: buildTarget(tab.id, param),
                func: (url) => { window.ybdextpathframe = url; },
                args: [param.url],
                ...buildInjectOptions(param),
            });
        } else if (param.type === 'code') {
            console.warn('[ad101] MV3 已不支持任意 code 注入，请改用 set_frame_path / func:', param.code);
        } else if (param.type === 'file') {
            await browser.scripting.executeScript({
                target: buildTarget(tab.id, param),
                files: [param.code],
                ...buildInjectOptions(param),
            });
            recordStats(param.code, tab).catch((e) => console.warn('[ad101] recordStats failed:', e));
        } else {
            // 兼容直接传文件路径字符串的调用方式
            await browser.scripting.executeScript({
                target: buildTarget(tab.id, param),
                files: [param],
                ...buildInjectOptions(param),
            });
            recordStats(param, tab).catch((e) => console.warn('[ad101] recordStats failed:', e));
        }
    } catch (e) {
        console.warn('[ad101] inject failed:', e);
    }
}

async function injectCSS(param) {
    const tab = await getActiveTab();
    if (!tab) return;

    const options = param.type === 'code'
        ? { css: param.code }
        : { files: [param.type === 'file' ? param.code : param] };

    try {
        await browser.scripting.insertCSS({ target: buildTarget(tab.id, param), ...options });
    } catch (e) {
        console.warn('[ad101] injectCSS failed:', e);
    }
}

// param.frameId 在原设计中是「用于匹配 frame URL 的正则字符串」，并非数字 frameId；
// MV3 下直接用 target.frameIds 精确注入，无需逐 frame 循环。
async function injectIntoMatchingFrames(api, param) {
    const tab = await getActiveTab();
    if (!tab) return;

    const frames = await browser.webNavigation.getAllFrames({ tabId: tab.id });
    const matcher = new RegExp(param.frameId);
    const frameIds = frames.filter(frame => matcher.test(frame.url)).map(frame => frame.frameId);
    if (!frameIds.length) return;

    const options = param.type === 'code' ? { css: param.code } : { files: [param.code] };
    await api(tab.id, frameIds, options).catch(e => console.warn('[ad101] frame inject failed:', e));
}

function injectByFrameID(param) {
    return injectIntoMatchingFrames(
        (tabId, frameIds, options) =>
            browser.scripting.executeScript({ target: { tabId, frameIds }, ...options, ...buildInjectOptions(param) }),
        param
    );
}

function injectCSSByFrameID(param) {
    return injectIntoMatchingFrames(
        (tabId, frameIds, options) => browser.scripting.insertCSS({ target: { tabId, frameIds }, ...options }),
        param
    );
}

// ===== 消息分发（保持原有 cmd 协议不变） =====
// 使用白名单而非 globalThis[cmd]：后者允许外部消息调用 Service Worker 上任意全局函数
// （如 fetch、importScripts），存在被滥用的风险。
const BACKGROUND_COMMANDS = new Set([
    'ruleset', 'init_rules', 'sync_rules', 'getRules', 'close',
    'inject', 'injectCSS', 'injectByFrameID', 'injectCSSByFrameID',
    'sendMessageToContentScript', 'sendMessageToAllContentScript',
    'get_popup_state', 'set_site_toggle', 'set_extension_status',
]);

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const cmd = request?.cmd;
    if (cmd && BACKGROUND_COMMANDS.has(cmd) && typeof globalThis[cmd] === 'function') {
        try {
            globalThis[cmd](request.param, sendResponse);
        } catch (e) {
            console.warn('[ad101] command failed:', cmd, e);
        }
    }
    return true;
});

function sendMessageToContentScript(message, callback) {
    getActiveTab().then((tab) => {
        if (!tab) return;
        browser.tabs.sendMessage(tab.id, message, (response) => {
            if (callback) callback(response);
        });
    });
}

function sendMessageToAllContentScript(message, callback) {
    browser.tabs.query({}).then((tabs) => {
        tabs.forEach(tab => {
            browser.tabs.sendMessage(tab.id, message, (response) => {
                if (callback) callback(response);
            });
        });
    });
}

init_rules();
// SW 启动即补报上次未成功上报的统计（幂等靠 batch id）
flushStats();
// SW 启动即按 storage 中的规则应用垃圾站点拦截（幂等）
applyStoredJunkRules();
// SW 启动即尝试同步广告订阅（内部 24h 节流，命中缓存直接幂等应用）
syncSubscription();
