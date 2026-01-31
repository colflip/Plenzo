/**
 * 课程类型数据存储 (单例模式)
 * 负责从后端加载、缓存和提供课程类型数据
 */
(function (window) {
    // 预定义颜色池（用于统计图表）
    const COLOR_POOL = [
        '#3366CC', // Blue
        '#FF9933', // Orange
        '#7C4DFF', // Purple
        '#B39DDB', // Light Purple
        '#4E79A7', // Steel Blue
        '#8E8CD8', // Lavender
        '#009688', // Teal
        '#E91E63', // Pink
        '#FFEB3B', // Yellow
        '#795548', // Brown
        '#607D8B', // Blue Grey
        '#9C27B0'  // Deep Purple
    ];

    const ScheduleTypesStore = {
        list: [],
        map: new Map(), // name -> object
        idMap: new Map(), // id -> object
        loadedAt: null,
        cacheKey: 'schedule_types_cache_v2',
        ttlMs: 24 * 60 * 60 * 1000, // 24 hours cache

        /**
         * 初始化：尝试从 LocalStorage 加载，然后后台刷新
         */
        async init() {
            // 1. 尝试从缓存加载（为了快速显示）
            this.loadFromCache();

            // 2. 无论缓存是否存在，都尝试从服务器获取最新数据
            try {
                await this.fetchFromServer();
            } catch (e) {
            }
        },

        /**
         * 从服务器获取数据并更新缓存
         */
        async fetchFromServer() {
            if (!window.apiUtils) {
                return;
            }

            try {
                const result = await window.apiUtils.getSilent('/admin/schedule-types');
                const types = Array.isArray(result) ? result : (result.data || []);

                if (types.length > 0) {
                    this.updateData(types);
                    this.saveToCache();
                }
            } catch (error) {
                throw error;
            }
        },

        /**
         * 更新内部数据结构
         */
        updateData(types) {
            if (!Array.isArray(types)) return;

            this.list = types;
            this.map.clear();
            this.idMap.clear();

            types.forEach((t, index) => {
                // 分配颜色（如果后端没存颜色，按顺序分配）
                // 暂时这里前端分配，后续可以在数据库加 color 字段
                const color = COLOR_POOL[index % COLOR_POOL.length];

                const typeObj = {
                    ...t,
                    color: t.color || color
                };

                this.map.set(t.name, typeObj);
                this.idMap.set(Number(t.id), typeObj);
            });

            this.loadedAt = Date.now();
        },

        /**
         * 保存到 LocalStorage
         */
        saveToCache() {
            try {
                const payload = {
                    list: this.list,
                    loadedAt: this.loadedAt
                };
                localStorage.setItem(this.cacheKey, JSON.stringify(payload));
            } catch (e) {
            }
        },

        /**
         * 从 LocalStorage 加载
         */
        loadFromCache() {
            try {
                const txt = localStorage.getItem(this.cacheKey);
                if (!txt) return false;

                const obj = JSON.parse(txt);
                if (!obj || !Array.isArray(obj.list)) return false;

                // 检查 TTL (可选，这里假设类型不经常变，过期也先用着)
                // if (Date.now() - obj.loadedAt > this.ttlMs) return false;

                this.updateData(obj.list);
                return true;
            } catch (e) {
                return false;
            }
        },

        /**
         * 获取所有类型列表
         */
        getAll() {
            return [...this.list];
        },

        /**
         * 根据 ID 获取类型对象
         */
        getById(id) {
            return this.idMap.get(Number(id));
        },

        /**
         * 根据 Name (英文标识) 获取类型对象
         */
        getByName(name) {
            return this.map.get(name);
        },

        /**
         * 获取显示名称（中文描述 > 英文标识）
         * 用于表格显示、图表标签等
         */
        getLabel(nameOrId) {
            let obj = null;
            if (typeof nameOrId === 'number' || !isNaN(Number(nameOrId))) {
                obj = this.idMap.get(Number(nameOrId));
            }
            if (!obj && typeof nameOrId === 'string') {
                obj = this.map.get(nameOrId);
            }

            if (obj) {
                // 优先显示描述，如果没有描述则显示名称
                return obj.description || obj.name;
            }

            // Fallback for legacy hardcoded values if not in DB yet
            const LEGACY_MAP = {
                'visit': '入户',
                'trial': '试教',
                'review': '评审',
                'review_record': '评审记录',
                'half_visit': '半次入户',
                'group_activity': '集体活动',
                'advisory': '咨询'
            };
            return LEGACY_MAP[nameOrId] || nameOrId;
        },

        /**
         * 获取颜色
         * 增强匹配：支持 ID、name、description 多种查找方式
         */
        getColor(nameOrId) {
            // 1. 优先按 ID 查找
            let obj = this.getById(nameOrId);
            if (obj && obj.color) return obj.color;

            // 2. 按 name 查找
            obj = this.getByName(nameOrId);
            if (obj && obj.color) return obj.color;

            // 3. 按 description 查找（遍历 list）
            const searchStr = String(nameOrId || '').trim();
            if (searchStr) {
                for (const t of this.list) {
                    if (t.description === searchStr || t.name === searchStr) {
                        return t.color || COLOR_POOL[this.list.indexOf(t) % COLOR_POOL.length];
                    }
                }
            }

            // 4. Fallback：基于字符串 hash 返回颜色，避免全灰
            if (searchStr) {
                const hash = Array.from(searchStr).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
                return COLOR_POOL[hash % COLOR_POOL.length];
            }

            return '#999999';
        }
    };

    // 暴露为全局对象
    window.ScheduleTypesStore = ScheduleTypesStore;

})(window);
