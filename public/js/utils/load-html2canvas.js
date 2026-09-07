// 按需加载 html2canvas（215KB），避免在 dashboard 首屏同步阻塞。
// 用法：await loadHtml2canvas()  →  window.html2canvas 可用。
// 返回 Promise<boolean>（成功 true / 失败 false），失败时调用侧自行降级提示。
(function() {
    var SCRIPT_SRC = '/js/libs/html2canvas.min.js';
    var CDN_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    var CDN_INTEGRITY = 'sha384-ZZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H';

    function loadFrom(src, integrity) {
        return new Promise(function(resolve, reject) {
            var script = document.createElement('script');
            script.src = src;
            if (integrity) {
                script.crossOrigin = 'anonymous';
                script.integrity = integrity;
            }
            script.onload = function() { resolve(); };
            script.onerror = function() { reject(new Error('load failed: ' + src)); };
            document.head.appendChild(script);
        });
    }

    window.loadHtml2canvas = function() {
        if (window.html2canvas) return Promise.resolve(true);
        return loadFrom(SCRIPT_SRC, null).catch(function() {
            return loadFrom(CDN_SRC, CDN_INTEGRITY);
        }).then(function() {
            return typeof window.html2canvas === 'function';
        });
    };

    // 保留旧式自动加载行为：脚本立刻尝试拉取本地文件，失败回退 CDN。
    // 这样「读 window.html2canvas」的既有调用侧（检查型）无需 await 也能拿到实例。
    window.loadHtml2canvas();
})();