// Only allow https URLs to the hosts the extension intentionally frames
// (bilibili.com / tieba.baidu.com subdomains). Everything else is rejected.
var ALLOWED_HOST_SUFFIXES = ["bilibili.com", "tieba.baidu.com"];

function isAllowedTargetUrl(raw) {
    try {
        var u = new URL(raw);
        if (u.protocol !== "https:") {
            return false;
        }
        var host = u.hostname.toLowerCase();
        return ALLOWED_HOST_SUFFIXES.some(function (suffix) {
            return host === suffix || host.endsWith("." + suffix);
        });
    } catch (e) {
        return false;
    }
}

(function () {
    var raw = new URL(location.href).searchParams.get("url");
    if (raw && isAllowedTargetUrl(raw)) {
        document.getElementById("ifr1").src = raw;
    }
})();
