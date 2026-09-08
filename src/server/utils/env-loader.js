/**
 * 环境变量加载（单一入口）
 *
 * 加载顺序（后者覆盖前者，仅在非生产环境启用 .env.local）：
 *   1. .env         —— 仓库内共享的默认值（线上由平台环境变量提供，缺失时才用）
 *   2. .env.local   —— 本机私有覆盖（git 已忽略），用于把本地开发指向本地/测试库，
 *                     避免误连生产库、也避免改动 .env 被误提交
 *
 * 为什么要独立成文件：db.js / app.js / 各 service 在模块加载时就会读 process.env，
 * 谁先被 require 谁就决定配置。统一在一个入口里按序加载，保证任何入口（app.js、
 * db.js、脚本）拿到的都是同一套值。
 */
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '../../..');

let loaded = false;

function loadEnv() {
    if (loaded) return { root: ROOT, loadedFiles: [] };
    loaded = true;

    const loadedFiles = [];
    const files = ['.env'];
    // 生产环境只认平台注入的真实环境变量，绝不允许仓库内的 .env.local 覆盖
    // （否则一次误提交/误打包就能把 DATABASE_URL 指到别处）。
    if (process.env.NODE_ENV !== 'production') files.push('.env.local');

    for (const file of files) {
        const full = path.join(ROOT, file);
        if (!fs.existsSync(full)) continue;
        // 第一个文件不覆盖已有环境变量（保持 dotenv 默认语义：真实 shell 变量优先），
        // 后续文件显式 override，实现「.env.local 覆盖 .env」。
        dotenv.config({ path: full, override: loadedFiles.length > 0 });
        loadedFiles.push(file);
    }

    return { root: ROOT, loadedFiles };
}

module.exports = { loadEnv, ROOT };
