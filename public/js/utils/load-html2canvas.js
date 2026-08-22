        (function() {
            var script = document.createElement('script');
            script.src = '/js/libs/html2canvas.min.js';
            script.onerror = function() {
                var cdnScript = document.createElement('script');
                cdnScript.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
                cdnScript.crossOrigin = 'anonymous';
                cdnScript.integrity = 'sha384-ZZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H';
                document.head.appendChild(cdnScript);
            };
            document.head.appendChild(script);
        })();
    