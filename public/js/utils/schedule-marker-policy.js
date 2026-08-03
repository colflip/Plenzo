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
