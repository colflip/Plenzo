        // Update copyright year
        const currentYear = new Date().getFullYear();
        const startYear = 2007;
        const yearText = currentYear > startYear ? `${startYear}-${currentYear}` : startYear;
        document.getElementById('copyrightYear').textContent = yearText;

        /* ============================================
         * Mouse-follow Ink Blot Background
         * Preserves original CSS radial gradients,
         * adds green ink blobs that follow the cursor
         * with smooth, organic movement.
         * ============================================ */
        (function() {
            'use strict';

            var inkBg = document.getElementById('ink-bg');
            if (!inkBg) return;

            var blobs = inkBg.querySelectorAll('.ink-blob');
            if (!blobs.length) return;

            var W, H, cx, cy;
            var mouseX = 0, mouseY = 0;
            var targetMX = 0, targetMY = 0;
            var rafId = null;
            var time = 0;
            var visible = true;
            var loaded = false;

            // Each blob has its own parallax depth, organic wobble, and base offset
            var defs = [
                { x: 0.50, y: 0.50,  depth: 1.0,  wobbleAmp: 35, wobbleSpeed: 0.0012, driftX: 0.0008, driftY: 0.0006 },
                { x: 0.60, y: 0.40,  depth: 0.7,  wobbleAmp: 25, wobbleSpeed: 0.0015, driftX: 0.0010, driftY: 0.0009 },
                { x: 0.40, y: 0.55,  depth: 0.5,  wobbleAmp: 20, wobbleSpeed: 0.0010, driftX: 0.0006, driftY: 0.0011 }
            ];

            var positions = [];
            var sizes = [];

            function init() {
                W = window.innerWidth;
                H = window.innerHeight;
                cx = W / 2;
                cy = H / 2;

                for (var i = 0; i < blobs.length; i++) {
                    var bw = blobs[i].offsetWidth;
                    var bh = blobs[i].offsetHeight;
                    sizes.push({ w: bw, h: bh });

                    // Each blob starts at a different offset from center
                    positions.push({
                        curX: defs[i].x * W,
                        curY: defs[i].y * H,
                        targetX: defs[i].x * W,
                        targetY: defs[i].y * H
                    });
                }

                // Fade in after first frame
                requestAnimationFrame(function() {
                    for (var i = 0; i < blobs.length; i++) {
                        blobs[i].classList.add('loaded');
                    }
                    loaded = true;
                });

                tick();
            }

            function lerp(a, b, n) { return a + (b - a) * n; }

            function onMove(e) {
                targetMX = (e.clientX / W - 0.5) * 2;  // -1 ~ 1
                targetMY = (e.clientY / H - 0.5) * 2;
            }

            function onVisibility() {
                visible = !document.hidden;
                if (visible && !rafId) tick();
            }

            function tick() {
                if (!visible) { rafId = null; return; }

                time++;

                // Smooth mouse tracking
                mouseX = lerp(mouseX, targetMX, 0.025);
                mouseY = lerp(mouseY, targetMY, 0.025);

                for (var i = 0; i < blobs.length; i++) {
                    var d = defs[i];
                    var p = positions[i];

                    // Mouse parallax: deeper blobs move more
                    var mxOff = mouseX * d.depth * 80;
                    var myOff = mouseY * d.depth * 80;

                    // Organic wobble: sine + cosine at different rates
                    var wobbleX = Math.sin(time * d.wobbleSpeed) * d.wobbleAmp;
                    var wobbleY = Math.cos(time * d.wobbleSpeed * 0.7) * d.wobbleAmp;

                    // Slow drift around base position
                    var driftX = Math.sin(time * d.driftX) * 30;
                    var driftY = Math.cos(time * d.driftY) * 25;

                    // Combine: base position + mouse + wobble + drift
                    p.curX = lerp(p.curX, d.x * W + mxOff + wobbleX + driftX, 0.03);
                    p.curY = lerp(p.curY, d.y * H + myOff + wobbleY + driftY, 0.03);

                    // Apply transform
                    var halfW = sizes[i].w / 2;
                    var halfH = sizes[i].h / 2;
                    blobs[i].style.transform =
                        'translate3d(' + (p.curX - halfW) + 'px,' + (p.curY - halfH) + 'px,0)';
                }

                rafId = requestAnimationFrame(tick);
            }

            window.addEventListener('resize', function() {
                W = window.innerWidth;
                H = window.innerHeight;
                cx = W / 2;
                cy = H / 2;
            });
            window.addEventListener('mousemove', onMove);
            document.addEventListener('visibilitychange', onVisibility);

            // Wait for layout to settle
            if (document.readyState === 'complete') {
                init();
            } else {
                window.addEventListener('load', init);
            }
        })();
    