// 知乎去广告 v2（2026-09-26 更新：应对知乎改版，多层启发式策略）
// 策略：①保留 2021 旧版选择器兜底 ②知乎官方埋点 data-za-extra-module 中的 has_ad 标记（跨版本最稳定）
// ③类名模糊匹配 ④文本+定位特征识别"打开App"引导层 ⑤登录墙（强制 App 登录阅读）的模态弹窗
(function () {
    'use strict';

    var LEGACY_SELECTORS = [
        '.ModalWrap', '.OpenInApp', '.MHotFeedAd', '.AdBelowMoreAnswers',
        '.WeiboAd-wrap', '.MRelateFeedAd', '.MBannerAd', '.Baidu-header',
        '.Baidu-ad', '.OpenInAppButton'
    ];

    // 类名模糊匹配：知乎改版后广告卡片类名仍保留这些词根
    var FUZZY_SELECTORS = [
        '[class*="HotFeedAd"]', '[class*="BannerAd"]', '[class*="RelateFeedAd"]',
        '[class*="Advert"]', '[class*="AdCard"]', '[class*="Pc-word"]',
        '[class*="AdFeed"]', '[id*="ad-card"]'
    ];

    // "打开App"引导层的文本特征
    // 注意：sweep() 比对前已把 textContent 去空白，关键词不能带空格
    var APP_PROMPT_TEXTS = ['打开App', '在App内打开', '打开知乎App', '下载知乎App', 'App内打开', 'App内阅读', '知乎App内阅读', 'App内继续阅读'];

    // 登录墙：知乎强制"登录/使用App"阅读的模态弹窗（新旧版选择器 + 遮罩）
    var LOGIN_MODAL_SELECTORS = [
        '.signFlowModal', '[class*="signFlow"]', '.signFlow',
        '.Modal-wrapper', '.Modal-backdrop', '[class*="LoginModal"]',
        '[class*="loginModal"]', '[class*="LoginGuide"]', '[class*="login-guide"]'
    ].join(',');
    var LOGIN_CLOSE_SELECTORS = '.Modal-closeButton, button[aria-label="关闭"], [class*="closeButton"][aria-label*="关"]';
    var LOGIN_PROMPT_TEXTS = ['登录知乎', '立即登录', '登录/注册', '手机号登录', '验证码登录', '注册登录', '登录后继续阅读', '使用App阅读', 'App内阅读'];

    var LEGACY = LEGACY_SELECTORS.join(',');

    function sweep() {
        try {
            // ① 旧版选择器
            document.querySelectorAll(LEGACY).forEach(function (el) {
                if (el.classList.contains('OpenInApp') || el.classList.contains('OpenInAppButton')) {
                    el.style.setProperty('left', '-9999px', 'important');
                } else {
                    el.remove();
                }
            });

            // ② 知乎埋点标记：广告卡片携带 data-za-extra-module 且含 "has_ad":true
            document.querySelectorAll('[data-za-extra-module*="has_ad"]').forEach(function (el) {
                var card = el.closest('.Card') || el.closest('[class*="ContentItem"]') || el;
                card.remove();
            });

            // ③ 类名模糊匹配
            document.querySelectorAll(FUZZY_SELECTORS.join(',')).forEach(function (el) {
                el.remove();
            });

            // ④ 文本 + fixed 定位识别"打开App"引导条 / 浮层
            document.querySelectorAll('div,button,a,header,footer').forEach(function (el) {
                var t = (el.textContent || '').replace(/\s+/g, '');
                if (!t || t.length > 40) return;
                var hit = false;
                for (var i = 0; i < APP_PROMPT_TEXTS.length; i++) {
                    if (t.indexOf(APP_PROMPT_TEXTS[i]) !== -1) { hit = true; break; }
                }
                if (!hit) return;
                var cs = getComputedStyle(el);
                if (cs.position !== 'fixed') return;
                var r = el.getBoundingClientRect();
                if (r.height > 0 && r.height < 260) {
                    el.style.setProperty('display', 'none', 'important');
                }
            });

            // ⑤ 登录墙：先尝试点关闭按钮（React 场景更干净），再移除模态与遮罩
            document.querySelectorAll(LOGIN_CLOSE_SELECTORS).forEach(function (btn) {
                btn.click();
            });
            document.querySelectorAll(LOGIN_MODAL_SELECTORS).forEach(function (el) {
                el.remove();
            });
            // 全屏 fixed 容器含登录文案 → 整层移除（覆盖哈希类名的新版登录墙）
            document.querySelectorAll('div[role="dialog"], div[class*="Modal"]').forEach(function (el) {
                var t = (el.textContent || '').replace(/\s+/g, '');
                if (!t || t.length > 120) return;
                for (var i = 0; i < LOGIN_PROMPT_TEXTS.length; i++) {
                    if (t.indexOf(LOGIN_PROMPT_TEXTS[i]) !== -1) {
                        el.remove();
                        break;
                    }
                }
            });

            // ⑥ 解除知乎的滚动锁（登录墙/引导墙会锁 body overflow）
            var b = document.body;
            if (b && b.style.overflow === 'hidden') {
                b.style.overflow = 'auto';
            }
            if (b && b.classList && b.classList.contains('ModalWrap-body')) {
                b.classList.remove('ModalWrap-body');
            }
            if (document.documentElement && document.documentElement.style.overflow === 'hidden') {
                document.documentElement.style.overflow = 'auto';
            }
        } catch (e) { /* 忽略单次扫描异常，interval 会继续 */ }
    }

    setInterval(sweep, 60);
})();
