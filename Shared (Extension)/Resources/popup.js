// AD101 - popup
// 站点开关（P0-1）：本站暂停/恢复 + 全局开关。
// host 一律由 background 侧 tabs.query 判定，popup 不传 URL。
const browser = globalThis.browser ?? globalThis.chrome;

const siteToggle = document.getElementById('site-toggle');
const globalToggle = document.getElementById('global-toggle');
const hostEl = document.getElementById('host');
const panel = document.getElementById('panel');
const notApplicable = document.getElementById('not-applicable');
const tip = document.getElementById('tip');

function showTip(text) {
    tip.textContent = text;
    tip.classList.remove('hidden');
}

function send(cmd, param) {
    // Safari Web Extension 扩展页可直接使用 Promise 风格 API
    return browser.runtime.sendMessage({ cmd, param });
}

async function init() {
    let state;
    try {
        state = await send({ cmd: 'get_popup_state' });
    } catch (e) {
        console.warn('[ad101] get_popup_state failed:', e);
        notApplicable.querySelector('p').textContent = '无法连接扩展后台';
        notApplicable.classList.remove('hidden');
        return;
    }

    if (!state?.applicable) {
        notApplicable.classList.remove('hidden');
        return;
    }

    hostEl.textContent = state.host;
    currentHost = state.host;
    // 语义：开关打开 = 拦截生效；disabled = 用户暂停
    siteToggle.checked = !state.disabled;
    globalToggle.checked = state.extensionOn;
    updatePickBtn(state.extensionOn, !state.disabled);
    panel.classList.remove('hidden');
    renderRules();
}

// 站点暂停或全局关闭时，选取屏蔽没有意义，禁用按钮
function updatePickBtn(extensionOn, siteEnabled) {
    const usable = Boolean(extensionOn) && Boolean(siteEnabled);
    pickBtn.disabled = !usable;
    pickBtn.title = usable ? '' : '请先开启拦截';
}

siteToggle.addEventListener('change', async () => {
    const disabled = !siteToggle.checked; // 开关打开 = 拦截生效
    try {
        const res = await send({ cmd: 'set_site_toggle', param: { disabled } });
        if (!res?.ok) throw new Error('set_site_toggle failed');
        updatePickBtn(globalToggle.checked, !disabled);
        showTip(disabled ? '已为本站暂停拦截，刷新页面生效' : '已恢复本站拦截，刷新页面生效');
    } catch (e) {
        console.warn('[ad101] set_site_toggle failed:', e);
        siteToggle.checked = !disabled; // 回滚 UI
        showTip('设置失败，请重试');
    }
});

globalToggle.addEventListener('change', async () => {
    const enabled = globalToggle.checked;
    try {
        // 全局开关需同时更新 rules.extensionStatus 与 DNR 规则集
        await send({ cmd: 'set_extension_status', param: enabled });
        updatePickBtn(enabled, siteToggle.checked);
        showTip(enabled ? '已开启全局拦截' : '已关闭全局拦截');
    } catch (e) {
        console.warn('[ad101] set_extension_status failed:', e);
        globalToggle.checked = !enabled;
        showTip('设置失败，请重试');
    }
});

// ===== 自定义元素屏蔽（AdGuard 式） =====
const USER_RULES_KEY = 'ad101_user_rules';
const pickBtn = document.getElementById('pick-btn');
const rulesSection = document.getElementById('user-rules');
const rulesList = document.getElementById('rules-list');
const rulesEmpty = document.getElementById('rules-empty');
let currentHost = null;

// 与 content.js 一致：host 及其父域的键都纳入匹配
function hostKeys(hostname) {
    const keys = [hostname];
    let h = hostname, dot = h.indexOf('.');
    while (dot !== -1 && dot < h.length - 2) {
        h = h.slice(dot + 1);
        keys.push(h);
        dot = h.indexOf('.');
    }
    return keys;
}

async function getSiteRules() {
    const stored = await browser.storage.local.get([USER_RULES_KEY]);
    const all = stored?.[USER_RULES_KEY] ?? {};
    const merged = [];
    for (const k of hostKeys(currentHost)) {
        for (const r of all[k] ?? []) {
            merged.push({ ...r, _key: k });
        }
    }
    return merged;
}

async function saveSiteRules(key, list) {
    const stored = await browser.storage.local.get([USER_RULES_KEY]);
    const all = stored?.[USER_RULES_KEY] ?? {};
    if (list.length) {
        all[key] = list;
    } else {
        delete all[key];
    }
    return browser.storage.local.set({ [USER_RULES_KEY]: all });
}

function renderRules() {
    getSiteRules().then((rules) => {
        rulesList.innerHTML = '';
        rulesSection.classList.toggle('hidden', false);
        rulesEmpty.style.display = rules.length ? 'none' : 'block';
        for (const r of rules) {
            const li = document.createElement('li');
            if (r.on === false) li.classList.add('off');

            const sw = document.createElement('label');
            sw.className = 'mini-switch';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = r.on !== false;
            const slider = document.createElement('span');
            slider.className = 'mini-slider';
            sw.append(input, slider);

            const sel = document.createElement('span');
            sel.className = 'sel';
            sel.textContent = r.sel;
            sel.title = r.sel;

            const del = document.createElement('button');
            del.className = 'del';
            del.textContent = '×';
            del.title = '删除此规则';

            input.addEventListener('change', async () => {
                const stored = await browser.storage.local.get([USER_RULES_KEY]);
                const all = stored?.[USER_RULES_KEY] ?? {};
                const list = all[r._key] ?? [];
                const target = list.find(x => x.sel === r.sel && x.ts === r.ts);
                if (target) {
                    target.on = input.checked;
                    await browser.storage.local.set({ [USER_RULES_KEY]: all });
                }
                renderRules();
                showTip(input.checked ? '已启用，刷新页面生效' : '已停用，刷新页面生效');
            });

            del.addEventListener('click', async () => {
                const stored = await browser.storage.local.get([USER_RULES_KEY]);
                const all = stored?.[USER_RULES_KEY] ?? {};
                const list = (all[r._key] ?? []).filter(x => !(x.sel === r.sel && x.ts === r.ts));
                await saveSiteRules(r._key, list);
                renderRules();
                showTip('已删除，刷新页面生效');
            });

            li.append(sw, sel, del);
            rulesList.appendChild(li);
        }
    }).catch((e) => console.warn('[ad101] render rules failed:', e));
}

pickBtn.addEventListener('click', async () => {
    if (!currentHost) return;
    try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error('no active tab');
        await browser.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['picker.js'],
        });
        window.close(); // popup 关闭后用户在页面上直接选取
    } catch (e) {
        console.warn('[ad101] inject picker failed:', e);
        showTip('无法启动选取器，请刷新页面后重试');
    }
});

// ===== 今日计数 + 最近记录（事件流水来自 background 的 recordStats） =====
const CAT_LABEL = { read: '展开全文', adblock: '去广告', nojump: '防跳转' };

function pad2(n) { return String(n).padStart(2, '0'); }

async function renderLogSection() {
    let log = [];
    let rulesVersion = null;
    try {
        const stored = await browser.storage.local.get(['ad101.log', 'rules', 'rules_version']);
        log = stored?.['ad101.log'] ?? [];
        rulesVersion = stored?.rules_version ?? stored?.rules?.rules_version ?? null;
    } catch (e) {
        console.warn('[ad101] read log failed:', e);
    }

    if (rulesVersion != null) {
        document.getElementById('rules-version').textContent = '规则 v' + rulesVersion;
    }

    // 今日计数：按事件时间戳的本地日期过滤
    const today = new Date();
    const isToday = (ts) => {
        const d = new Date(ts);
        return d.getFullYear() === today.getFullYear()
            && d.getMonth() === today.getMonth()
            && d.getDate() === today.getDate();
    };
    const counts = { read: 0, adblock: 0, nojump: 0 };
    for (const evt of log) {
        if (evt?.cat in counts && isToday(evt.t)) counts[evt.cat] += 1;
    }
    document.getElementById('stat-read').textContent = counts.read;
    document.getElementById('stat-adblock').textContent = counts.adblock;
    document.getElementById('stat-nojump').textContent = counts.nojump;

    const listEl = document.getElementById('log-list');
    const emptyEl = document.getElementById('log-empty');
    const items = log.slice(-30).reverse(); // 最新在前，最多展示 30 条
    if (!items.length) {
        emptyEl.style.display = 'block';
        return;
    }
    emptyEl.style.display = 'none';
    listEl.innerHTML = '';
    for (const evt of items) {
        const li = document.createElement('li');
        const time = document.createElement('span');
        time.className = 'time';
        const d = new Date(evt.t);
        time.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
        const host = document.createElement('span');
        host.className = 'host';
        host.textContent = evt.host ?? '';
        host.title = evt.host ?? '';
        const cat = document.createElement('span');
        cat.className = 'cat ' + (evt.cat ?? '');
        cat.textContent = CAT_LABEL[evt.cat] ?? evt.cat ?? '';
        li.append(time, host, cat);
        listEl.appendChild(li);
    }
}

init();
renderLogSection();
