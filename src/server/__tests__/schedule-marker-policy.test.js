const ScheduleMarkerPolicy = require('../../../public/js/utils/schedule-marker-policy');

describe('ScheduleMarkerPolicy', () => {
    test.each([
        [[''], '', ['']],
        [['+'], '+', ['']],
        [['~'], '~', ['']],
        [['~', '~'], '~', ['', '']],
        [['+', '+'], '+', ['', '']],
        [['~', '~', '+'], '~', ['', '', '+']],
        [['+', '+', '~'], '+', ['', '', '~']],
        [['~', '+'], '~', ['', '+']],
        [['⁺', '~'], '~', ['+', '']],
        [['~', '+', ''], '', ['~', '+', '']]
    ])('resolve(%j) → course=%s teachers=%j', (markers, courseMarker, teacherMarkers) => {
        expect(ScheduleMarkerPolicy.resolve(markers)).toEqual({
            courseMarker,
            teacherMarkers
        });
    });

    test('无输入返回空策略', () => {
        expect(ScheduleMarkerPolicy.resolve()).toEqual({
            courseMarker: '',
            teacherMarkers: []
        });
    });

    test('图片显示文本将临时加课和调整标识都拆成角标 token', () => {
        expect(ScheduleMarkerPolicy.tokenizeDisplayText(
            '~评审：侯老师，⁺高渊，~周老师'
        )).toEqual([
            { text: '~', isMarker: true },
            { text: '评审：侯老师，', isMarker: false },
            { text: '+', isMarker: true },
            { text: '高渊，', isMarker: false },
            { text: '~', isMarker: true },
            { text: '周老师', isMarker: false }
        ]);
    });

    test('普通文本保持单一非角标 token', () => {
        expect(ScheduleMarkerPolicy.tokenizeDisplayText('入户：周老师')).toEqual([
            { text: '入户：周老师', isMarker: false }
        ]);
    });
});
