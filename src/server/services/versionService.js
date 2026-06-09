/**
 * Version metadata service.
 * Prefer GitHub repository metadata, then fall back to the local Git checkout.
 */

const { execFileSync } = require('child_process');
const https = require('https');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '../../..');
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedMeta = null;
let cachedAt = 0;

function runGit(args) {
    try {
        return execFileSync('git', args, {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 1500
        }).trim();
    } catch (error) {
        return '';
    }
}

function normalizeGitHubRepo(value) {
    if (!value) return '';
    const text = String(value).trim();
    if (/^[^/\s]+\/[^/\s]+$/.test(text)) return text;

    const httpsMatch = text.match(/github\.com[:/]([^/\s]+)\/([^/\s.]+)(?:\.git)?/i);
    if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;

    return '';
}

function getGitHubRepo() {
    return normalizeGitHubRepo(process.env.GITHUB_REPOSITORY) ||
        normalizeGitHubRepo(
            process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
                ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
                : ''
        ) ||
        normalizeGitHubRepo(runGit(['config', '--get', 'remote.origin.url']));
}

function requestJson(url, headers = {}, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'classflow-version-badge',
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

function getLocalGitMeta(repo) {
    const commitSha = process.env.VERCEL_GIT_COMMIT_SHA || runGit(['log', '-1', '--format=%H']);
    const shortSha = commitSha ? commitSha.slice(0, 7) : runGit(['log', '-1', '--format=%h']);
    const updatedAt = runGit(['log', '-1', '--format=%cI']) || null;

    return {
        updatedAt,
        source: updatedAt ? 'git' : 'unknown',
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

    const repo = getGitHubRepo();
    let meta = null;

    try {
        meta = await getGitHubMeta(repo);
    } catch (error) {
        meta = null;
    }

    if (!meta) {
        meta = getLocalGitMeta(repo);
    } else {
        const localMeta = getLocalGitMeta(repo);
        meta.commitSha = localMeta.commitSha;
        meta.shortSha = localMeta.shortSha;
    }

    cachedMeta = {
        name: process.env.npm_package_name || 'classflow',
        version: process.env.npm_package_version || '1.0.0',
        ...meta
    };
    cachedAt = Date.now();

    return cachedMeta;
}

module.exports = {
    getVersionMeta
};
