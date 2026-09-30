// AD101 - 元素选取器（AdGuard 式 Block element）
// 由 popup 通过 scripting.executeScript({files:['picker.js']}) 注入页面（isolated world）。
// 交互：悬停高亮 → 点选 → 底部确认条（预览/确认/取消，Esc 退出）→
//       确认后规则写入 browser.storage.local 的 ad101.user_rules 并即时生效，可连续选取。
(function () {
    'use strict';

    // 幂等：重复注入先卸载旧实例
    if (window.__ad101Picker && window.__ad101Picker.active) {
        window.__ad101Picker.destroy();
    }

    var browser = window.browser ?? window.chrome;
    var STORAGE_KEY = 'ad101.user_rules';
    var STYLE_ID = 'ad101-user-style';

    // ===== DOM =====

    var highlight = document.createElement('div');
    highlight.style.cssText =
        'position:fixed;z-index:2147483647;pointer-events:none;display:none;' +
        'background:rgba(255,59,48,.15);border:2px solid #ff3b30;border-radius:2px;';
    document.documentElement.appendChild(highlight);

    var bar = document.createElement('div');
    bar.style.cssText =
        'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;' +
        'background:rgba(28,28,30,.97);color:#fff;padding:10px 12px;' +
        'font:13px/1.5 -apple-system,"PingFang SC",sans-serif;' +
        'display:none;align-items:center;gap:8px;flex-wrap:wrap;';
    document.documentElement.appendChild(bar);

    var selText = document.createElement('span');
    selText.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'font-family:Menlo,monospace;font-size:12px;color:#ffd60a;';

    function makeBtn(text, bg) {
        var b = document.createElement('button');
        b.textContent = text;
        b.style.cssText =
            'padding:6px 14px;border:none;border-radius:6px;font-size:13px;color:#fff;' +
            'background:' + bg + ';cursor:pointer;';
        return b;
    }
    var btnPreview = makeBtn('预览', '#0a84ff');
    var btnConfirm = makeBtn('屏蔽此元素', '#ff3b30');
    var btnCancel = makeBtn('取消 (Esc)', '#48484a');
    bar.appendChild(selText);
    bar.appendChild(btnPreview);
    bar.appendChild(btnConfirm);
    bar.appendChild(btnCancel);

    // ===== 选择器生成 =====
    // 自底向上构造，优先 #id / tag.class，兄弟不唯一时补 :nth-of-type；
    // 每加一层就用 querySelectorAll 验证唯一性，命中即返回。
    function genSelector(el) {
        if (!el || el.nodeType !== 1) return null;
        if (el.id) return '#' + CSS.escape(el.id);

        var parts = [];
        var cur = el;
        while (cur && cur.nodeType === 1 && parts.length < 4) {
            var seg = cur.tagName.toLowerCase();
            if (cur.classList && cur.classList.length) {
                seg += Array.from(cur.classList).slice(0, 2)
                    .map(function (c) { return '.' + CSS.escape(c); }).join('');
            }
            var parent = cur.parentElement;
            if (parent) {
                var sameTag = Array.from(parent.children)
                    .filter(function (c) { return c.tagName === cur.tagName; });
                if (sameTag.length > 1) {
                    seg += ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')';
                }
            }
            parts.unshift(seg);
            var sel = parts.join(' > ');
            try {
                if (document.querySelectorAll(sel).length === 1) return sel;
            } catch (e) { /* 非法选择器则继续向上 */ }
            cur = parent;
        }
        return parts.join(' > ');
    }

    // ===== 规则应用（与 content.js 同一约定） =====

    function allSelectors(rules) {
        return (rules || []).filter(function (r) { return r && r.sel && r.on !== false; })
            .map(function (r) { return r.sel; });
    }

    function applyStyle(sels) {
        var style = document.getElementById(STYLE_ID);
        if (!sels.length) {
            if (style) style.remove();
            return;
        }
        if (!style) {
            style = document.createElement('style');
            style.id = STYLE_ID;
            (document.head || document.documentElement).appendChild(style);
        }
        style.textContent = sels.join(',\n') + ' { display:none !important; }';
    }

    // ===== 状态 =====

    var active = true;
    var selected = null;      // 当前点选元素
    var currentSel = null;    // 当前生成的选择器
    var previewing = false;

    function showBar() { bar.style.display = 'flex'; }
    function hideBar() { bar.style.display = 'none'; }

    function clearState() {
        selected = null;
        currentSel = null;
        previewing = false;
        btnPreview.textContent = '预览';
        selText.textContent = '';
        hideBar();
        applyCurrentRules();
    }

    // 从 storage 读当前站规则并应用（含父域回退）
    function hostKeys(hostname) {
        var keys = [hostname];
        var i = hostname.indexOf('.');
        while (i !== -1 && i < hostname.length - 2) {
            hostname = hostname.slice(i + 1);
            keys.push(hostname);
            i = hostname.indexOf('.');
        }
        return keys;
    }

    function applyCurrentRules() {
        browser.storage.local.get([STORAGE_KEY]).then(function (obj) {
            var all = obj[STORAGE_KEY] || {};
            var sels = [];
            hostKeys(location.hostname).forEach(function (k) {
                sels = sels.concat(allSelectors(all[k]));
            });
            applyStyle(sels);
        }).catch(function () { });
    }

    // ===== 事件 =====

    function onMove(e) {
        if (!active || selected) return;
        var t = e.target;
        if (!t || t.nodeType !== 1) return;
        if (bar.contains(t) || highlight.contains(t)) return;
        var r = t.getBoundingClientRect();
        highlight.style.display = 'block';
        highlight.style.left = r.left + 'px';
        highlight.style.top = r.top + 'px';
        highlight.style.width = r.width + 'px';
        highlight.style.height = r.height + 'px';
    }

    function onClick(e) {
        if (!active) return;
        if (bar.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        selected = e.target;
        currentSel = genSelector(selected);
        selText.textContent = currentSel || '（无法生成选择器）';
        showBar();
    }

    function onKey(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            if (selected) { clearState(); return; }
            api.destroy();
        }
    }

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);

    // ===== 确认条按钮 =====

    btnPreview.addEventListener('click', function () {
        if (!currentSel) return;
        previewing = !previewing;
        btnPreview.textContent = previewing ? '取消预览' : '预览';
        if (previewing) {
            applyStyle([currentSel]);
        } else {
            applyCurrentRules();
        }
    });

    btnCancel.addEventListener('click', function () {
        if (selected) clearState();
        else api.destroy();
    });

    btnConfirm.addEventListener('click', function () {
        if (!currentSel) return;
        var hostname = location.hostname;
        browser.storage.local.get([STORAGE_KEY]).then(function (obj) {
            var all = obj[STORAGE_KEY] || {};
            var list = all[hostname] || [];
            // 去重：同站同选择器不重复入库
            if (!list.some(function (r) { return r.sel === currentSel; })) {
                list.push({ sel: currentSel, on: true, ts: Date.now() });
                all[hostname] = list;
                var patch = {};
                patch[STORAGE_KEY] = all;
                return browser.storage.local.set(patch);
            }
        }).then(function () {
            flash('已屏蔽：' + currentSel);
            clearState(); // 继续选取下一个；再次 Esc 或点取消退出
        }).catch(function (e) {
            flash('保存失败：' + (e && e.message ? e.message : e));
        });
    });

    // 轻量提示（复用确认条位置，避免与页面 toast 冲突）
    var flashTimer = null;
    function flash(text) {
        var old = bar.style.display;
        selText.textContent = text;
        btnPreview.style.display = 'none';
        btnConfirm.style.display = 'none';
        btnCancel.style.display = 'none';
        showBar();
        clearTimeout(flashTimer);
        flashTimer = setTimeout(function () {
            btnPreview.style.display = '';
            btnConfirm.style.display = '';
            btnCancel.style.display = '';
            hideBar();
            if (old === 'flex') showBar();
        }, 1200);
    }

    // ===== 生命周期 =====

    var api = {
        active: true,
        destroy: function () {
            active = false;
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('keydown', onKey, true);
            highlight.remove();
            bar.remove();
            applyCurrentRules(); // 退出时恢复正式规则，清掉预览态
            if (window.__ad101Picker === api) window.__ad101Picker = null;
        },
    };
    window.__ad101Picker = api;
})();
