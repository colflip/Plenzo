/**
 * 版本元数据服务
 * @description 优先读 GitHub 仓库元数据，读不到时回退本地 Git 检出；结果带 TTL 缓存，
 *              并据此判定当前运行环境（vercel / render / cloudzyro）。
 * @module services/version-service
 */

const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

let cachedMeta = null;
let cachedAt = 0;

const REPO_ROOT = path.join(__dirname, '../../..');
const CACHE_TTL_MS = 5 * 60 * 1000;

// GitHub 元数据只用于展示「仓库最近更新时间」与版本兜底；短超时 + 失败冷却，
// 避免网络不通时每个请求都白等 2.5s（实测本机断网曾因此慢 1932ms）。
//
// 部署判定必须用 NODE_ENV=production，不能看 VERCEL/RENDER 注入变量：
// redeploy-vercel.js 走 POST /v13/deployments 重建部署（非 Git 集成），
// 实测线上 process.env.VERCEL 为空（2026-11-16 线上 envDebug 实证），
// 用它做闸门会让整条 GitHub 链路被跳过。本地开发（development）不发外网请求。
const isDeployedRuntime = process.env.NODE_ENV === 'production';
const GITHUB_FAIL_COOLDOWN_MS = 5 * 60 * 1000;
let githubFailedAt = 0;

/**
 * 识别当前运行环境（哪个源在服务这个请求），只用于展示。
 * 优先读显式的 DEPLOY_PLATFORM（vercel/render/cloudzyro）——API 部署的 Vercel
 * 实测不注入 VERCEL 变量（2026-11-16 线上实证），平台自带的标识不可靠；
 * 再退到平台注入的 VERCEL/RENDER/CLOUDZYRO。
 * 都读不出来返回 null，让徽章省略该段——绝不默认 'local'：没注入平台变量的
 * 部署曾被全部误标成本地。'local' 只给**真正的本地开发**：有 .git 检出、且不是
 * production 模式。
 */
function resolveRuntime() {
    const explicit = String(process.env.DEPLOY_PLATFORM || '').trim().toLowerCase();
    if (explicit) return explicit;
    if (process.env.VERCEL) return 'vercel';
    if (process.env.RENDER) return 'render';
    if (process.env.CLOUDZYRO) return 'cloudzyro';
    if (process.env.NODE_ENV !== 'production' && fs.existsSync(path.join(REPO_ROOT, '.git'))) {
        return 'local';
    }
    return null;
}

/**
 * 异步执行 git 命令，避免阻塞事件循环
 */
async function runGit(args) {
    return new Promise((resolve) => {
        execFile('git', args, {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 1500
        }, (error, stdout) => {
            resolve(error ? '' : (stdout || '').trim());
        });
    });
}

function normalizeGitHubRepo(value) {
    if (!value) return '';
    const text = String(value).trim();

    // 优先从 github.com URL / SSH 地址提取 owner/repo（去掉 .git 后缀）
    // 例如 git@github.com:colflip/Plenzo.git、https://github.com/colflip/Plenzo
    const ghMatch = text.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
    if (ghMatch) return `${ghMatch[1]}/${ghMatch[2]}`;

    // 回退：纯 owner/repo 形式（排除含协议/主机/SSH 的字符串）
    if (/^[^/\s:@]+\/[^/\s:@]+$/.test(text)) return text.replace(/\.git$/, '');

    return '';
}

const DEFAULT_REPO = 'colflip/Plenzo';

async function getGitHubRepo() {
    return normalizeGitHubRepo(process.env.GITHUB_REPOSITORY) ||
        normalizeGitHubRepo(
            process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
                ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
                : ''
        ) ||
        normalizeGitHubRepo(await runGit(['config', '--get', 'remote.origin.url'])) ||
        // API/CLI 部署（非 Git 触发）时平台不注入 repo 变量，部署产物里也没有 .git。
        // 仓库就这一个，直接兜底，别让 repo 解析为空把整条 GitHub 链路废掉。
        DEFAULT_REPO;
}

function requestJson(url, headers = {}, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'plenzo-version-badge',
                'Accept': 'application/vnd.github+json',
                ...headers
            },
            timeout: timeoutMs
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                body += chunk;
            });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`GitHub API returned ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('GitHub API request timed out'));
        });
        req.on('error', reject);
    });
}

async function getGitHubMeta(repo) {
    if (!repo) return null;
    const headers = {};
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;

    const data = await requestJson(`https://api.github.com/repos/${repo}`, headers);
    if (!data || !data.updated_at) return null;

    return {
        updatedAt: data.updated_at,
        source: 'github',
        repo,
        repoUrl: data.html_url || `https://github.com/${repo}`
    };
}

/**
 * 解析部署版本号（shortSha），按部署平台依次兜底：
 *   Vercel → Render → GitHub API（仓库最新 commit）→ 本地 git。
 * 取不到就返回 null —— 徽章据此省略版本段。绝不能用构建时间戳伪造：
 * 没 .git 的部署（cloudzyro）曾因此显示假版本号 b6041008。
 */
async function resolveCommitSha(repo) {
    const fromEnv =
        process.env.VERCEL_GIT_COMMIT_SHA ||
        process.env.RENDER_GIT_COMMIT ||
        process.env.RENDER_GIT_COMMIT_SHA ||
        process.env.RENDER_DEPLOY_ID;
    if (fromEnv) return fromEnv;
    return await runGit(['log', '-1', '--format=%H']);
}

async function getGitHubHeadSha(repo) {
    if (!repo) return '';
    const headers = {};
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        const data = await requestJson(`https://api.github.com/repos/${repo}/commits/HEAD`, headers);
        return (data && data.sha) ? String(data.sha) : '';
    } catch (error) {
        githubFailedAt = Date.now();
        return '';
    }
}

async function getLocalGitMeta(repo) {
    const commitSha = await resolveCommitSha(repo);
    const shortSha = commitSha ? commitSha.slice(0, 7) : '';
    const updatedAt = shortSha ? await runGit(['log', '-1', '--format=%cI']) : null;

    return {
        updatedAt,
        source: updatedAt ? 'git' : 'none',
        repo,
        repoUrl: repo ? `https://github.com/${repo}` : '',
        commitSha: commitSha || '',
        shortSha: shortSha || ''
    };
}

async function getVersionMeta() {
    if (cachedMeta && Date.now() - cachedAt < CACHE_TTL_MS) {
        return cachedMeta;
    }

    const repo = await getGitHubRepo();
    let meta = null;

    // 仅部署环境（Vercel/Render/cloudzyro）才查 GitHub：本地 dev 的 shortSha 来自本地 git，
    // 查 GitHub 只会增加一个必然超时的外网往返。
    const githubAllowed = isDeployedRuntime && (Date.now() - githubFailedAt > GITHUB_FAIL_COOLDOWN_MS);
    if (githubAllowed) {
        try {
            meta = await getGitHubMeta(repo);
        } catch (error) {
            meta = null;
            githubFailedAt = Date.now();
        }
    }

    if (!meta) {
        meta = await getLocalGitMeta(repo);
        // 部署环境没有 .git（如 cloudzyro 只上传运行产物）时，再从 GitHub API 兜底取
        // 仓库最新 commit —— 宁可空着也不能伪造版本号（曾显示过假版本 b6041008）。
        if (!meta.shortSha && isDeployedRuntime) {
            const sha = await getGitHubHeadSha(repo);
            if (sha) {
                meta.commitSha = sha;
                meta.shortSha = sha.slice(0, 7);
                meta.source = 'github';
            }
        }
    } else {
        const localMeta = await getLocalGitMeta(repo);
        meta.commitSha = localMeta.commitSha;
        meta.shortSha = localMeta.shortSha;
        // GitHub 元数据成功但本地 git/env 都给不出 sha（API 部署产物无 .git）时，
        // 同样用仓库 HEAD 补齐 —— 否则徽章有日期没版本号。
        if (!meta.shortSha && isDeployedRuntime) {
            const sha = await getGitHubHeadSha(repo);
            if (sha) {
                meta.commitSha = sha;
                meta.shortSha = sha.slice(0, 7);
            }
        }
    }

    cachedMeta = {
        name: process.env.npm_package_name || 'plenzo',
        version: process.env.npm_package_version || '1.0.0',
        runtime: resolveRuntime(),
        ...meta
    };
    cachedAt = Date.now();

    return cachedMeta;
}

module.exports = {
    getVersionMeta
};
