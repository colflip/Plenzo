/**
 * Version metadata service.
 * Prefer GitHub repository metadata, then fall back to the local Git checkout.
 */

const { execFile } = require('child_process');
const https = require('https');
const path = require('path');

let cachedMeta = null;
let cachedAt = 0;

const REPO_ROOT = path.join(__dirname, '../../..');
const CACHE_TTL_MS = 5 * 60 * 1000;

// GitHub 元数据只用于展示「仓库最近更新时间」，与 shortSha 无关（shortSha 走本地 git）。
// 但它在网络不通时会白等 2.5s 超时——实测本机断网时首个 dashboard 请求因此慢 1932ms。
// 两道闸：1) 非部署环境（本地 dev）根本不发这个请求；2) 失败后冷却，避免每 5 分钟重付一次。
const isDeployedRuntime = Boolean(process.env.VERCEL || process.env.RENDER);
const GITHUB_FAIL_COOLDOWN_MS = 5 * 60 * 1000;
let githubFailedAt = 0;

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

async function getGitHubRepo() {
    return normalizeGitHubRepo(process.env.GITHUB_REPOSITORY) ||
        normalizeGitHubRepo(
            process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
                ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
                : ''
        ) ||
        normalizeGitHubRepo(await runGit(['config', '--get', 'remote.origin.url']));
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
 *   Vercel  →  Render  →  本地 git  →  构建时间戳
 * 这样 Vercel / Render / 本地 dev / docker 均能量化出稳定版本号。
 */
function resolveCommitSha() {
    const fromEnv =
        process.env.VERCEL_GIT_COMMIT_SHA ||
        process.env.RENDER_GIT_COMMIT ||
        process.env.RENDER_GIT_COMMIT_SHA ||
        process.env.RENDER_DEPLOY_ID;
    if (fromEnv) return fromEnv;
    return null;
}

function resolveBuildTimestamp() {
    const raw = process.env.BUILD_TIMESTAMP || process.env.BUILD_TIME;
    if (raw) return String(raw);
    return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

async function getLocalGitMeta(repo) {
    const envSha = resolveCommitSha();
    const commitSha = envSha || await runGit(['log', '-1', '--format=%H']);
    let shortSha = commitSha ? commitSha.slice(0, 7) : await runGit(['log', '-1', '--format=%h']);
    // 兜底：无任何 git/环境变量可用时，用构建时间戳保证版本号非空且每次构建不同。
    if (!shortSha) shortSha = `b${resolveBuildTimestamp().slice(-7)}`;
    const updatedAt = await runGit(['log', '-1', '--format=%cI']) || null;

    return {
        updatedAt,
        source: updatedAt ? 'git' : 'build',
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

    // 仅部署环境（Vercel/Render）才查 GitHub：本地 dev 的 shortSha 来自本地 git，
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
    } else {
        const localMeta = await getLocalGitMeta(repo);
        meta.commitSha = localMeta.commitSha;
        meta.shortSha = localMeta.shortSha;
    }

    cachedMeta = {
        name: process.env.npm_package_name || 'plenzo',
        version: process.env.npm_package_version || '1.0.0',
        ...meta
    };
    cachedAt = Date.now();

    return cachedMeta;
}

module.exports = {
    getVersionMeta
};
