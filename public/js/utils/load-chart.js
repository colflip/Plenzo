// 按需加载 Chart.js（204KB），避免在 dashboard 首屏同步阻塞
// 用法：await loadChart()  →  window.Chart 可用
(function() {
    window.loadChart = function() {
        if (window.Chart) return Promise.resolve();
        return new Promise(function(resolve, reject) {
            var script = document.createElement('script');
            script.src = '/js/libs/chart.umd.js';
            script.onload = function() { resolve(); };
            script.onerror = function() {
                var cdnScript = document.createElement('script');
                cdnScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.1/chart.umd.min.js';
                cdnScript.crossOrigin = 'anonymous';
                cdnScript.integrity = 'sha384-' + 'jb8JQMbMoBUzgWatfe6COACi2ljcDdZQ2OxczGA3bGNeWe+6DChMTBJemed7ZnvJ';
                cdnScript.onload = function() { resolve(); };
                cdnScript.onerror = function() { reject(new Error('Chart.js load failed')); };
                document.head.appendChild(cdnScript);
            };
            document.head.appendChild(script);
        });
    };
})();
