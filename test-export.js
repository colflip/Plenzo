const fs = require('fs');

global.window = {};
eval(fs.readFileSync('./public/js/components/export-manager.js', 'utf8'));

// 补充测试数据字段，确保 format 能读到
const mockData = [
  { date: "2026-03-07", student_name: "小明", teacher_name: "周耀华", type_name: "入户",  startTime: "19:00", endTime: "22:00", status: "completed" },
  { date: "2026-03-07", student_name: "小明", teacher_name: "赵润杰", type_name: "入户",  startTime: "19:00", endTime: "22:00", status: "completed" },
  { date: "2026-03-07", student_name: "小黑", teacher_name: "图帕尔", type_name: "试教",  startTime: "19:00", endTime: "22:00", status: "completed" },
  { date: "2026-03-07", student_name: "小白", teacher_name: "金博", type_name: "评审",  startTime: "14:00", endTime: "16:00", status: "completed" },
  { date: "2026-03-07", student_name: "小白", teacher_name: "周耀华", type_name: "评审记录",  startTime: "14:00", endTime: "16:00", status: "completed" },
  { date: "2026-03-07", student_name: "小白", teacher_name: "叶婷婷", type_name: "评审",  startTime: "14:00", endTime: "16:00", status: "completed" },
  { date: "2026-03-07", student_name: "阿紫", teacher_name: "李四", type_name: "试教",  startTime: "19:00", endTime: "22:00", status: "0" } // 取消的试教
];

global.window.ScheduleTypesStore = {
  getAll: () => [
    { id: 1, name: 'visit', description: '入户' },
    { id: 2, name: 'trial', description: '试教' },
    { id: 3, name: 'review', description: '评审' }
  ],
  getById: (id) => global.window.ScheduleTypesStore.getAll().find(t => t.id == id || t.name === id)
};

const mockState = { startDate: new Date('2026-03-07'), endDate: new Date('2026-03-07'), selectedType: 'admin' };
const result = window.ExportManager.transformExportData(mockData, null, null, 'admin', mockState);

console.log(JSON.stringify(result['每日排课明细'], null, 2));
