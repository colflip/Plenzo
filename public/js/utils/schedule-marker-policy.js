/**
 * 排课标记策略（UMD：浏览器挂 window.ScheduleMarkerPolicy，服务端可 require）
 * @description 归一化 '+' / '⁺' / '~' 标记，并把带标记的展示文本切分为可渲染片段；
 *              服务端测试直接 require 本文件，改动要同步跑 schedule-marker-policy 套件。
 */
(function (root, factory) {
    const policy = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = policy;
    }

    if (root) {
        root.ScheduleMarkerPolicy = policy;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function normalizeMarker(marker) {
        if (marker === '+' || marker === '⁺') return '+';
        if (marker === '~') return '~';
        return '';
    }

    function tokenizeDisplayText(text) {
        const tokens = [];
        let buffer = '';

        for (const char of String(text || '')) {
            const marker = char === '⁺' ? '+' : (char === '~' ? '~' : '');
            if (!marker) {
                buffer += char;
                continue;
            }

            if (buffer) {
                tokens.push({ text: buffer, isMarker: false });
                buffer = '';
            }
            tokens.push({ text: marker, isMarker: true });
        }

        if (buffer) {
            tokens.push({ text: buffer, isMarker: false });
        }

        return tokens;
    }

    function resolve(markers) {
        const normalized = Array.isArray(markers)
            ? markers.map(normalizeMarker)
            : [];

        if (normalized.length === 0) {
            return { courseMarker: '', teacherMarkers: [] };
        }

        if (normalized.length === 1) {
            return {
                courseMarker: normalized[0],
                teacherMarkers: ['']
            };
        }

        const allMarked = normalized.every(Boolean);
        if (!allMarked) {
            return {
                courseMarker: '',
                teacherMarkers: normalized
            };
        }

        const adjustedCount = normalized.filter(marker => marker === '~').length;
        const temporaryCount = normalized.filter(marker => marker === '+').length;
        const courseMarker = adjustedCount >= temporaryCount ? '~' : '+';

        return {
            courseMarker,
            teacherMarkers: normalized.map(marker => (
                marker === courseMarker ? '' : marker
            ))
        };
    }

    return {
        normalizeMarker,
        tokenizeDisplayText,
        resolve
    };
});
