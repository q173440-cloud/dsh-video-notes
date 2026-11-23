import { promises as fs } from 'fs';
import path from 'path';
const PLATFORM_SPECS = {
    bilibili: {
        keys: ['SESSDATA'],
        domains: ['bilibili.com'],
        maxAgeHours: 168
    },
    youtube: {
        keys: ['SID', 'SAPISID', '__Secure-1PSID'],
        domains: ['youtube.com'],
        maxAgeHours: 168
    }
};
export function getCookiesDir(dataDir) {
    return path.join(path.resolve(dataDir), 'cookies');
}
async function listRegularFiles(dir) {
    const names = await fs.readdir(dir).catch(() => []);
    const out = [];
    for (const name of names) {
        if (name.toLowerCase().includes(':zone.identifier'))
            continue;
        const fullPath = path.join(dir, name);
        const st = await fs.stat(fullPath).catch(() => null);
        if (st && st.isFile()) {
            out.push({ name, fullPath, mtimeMs: st.mtimeMs });
        }
    }
    return out;
}
async function readNetscapeMetadata(filePath) {
    const raw = await fs.readFile(filePath, 'utf-8');
    const domains = new Set();
    const cookieNames = new Set();
    let cookieCount = 0;
    for (const rawLine of raw.split(/\r?\n/)) {
        let line = rawLine.trim();
        if (!line)
            continue;
        if (line.toLowerCase().startsWith('#httponly_')) {
            line = line.slice('#HttpOnly_'.length);
        }
        else if (line.startsWith('#')) {
            continue;
        }
        const cols = line.split('\t');
        if (cols.length < 7)
            continue;
        // Security invariant: only inspect column 0 (domain) and column 5 (cookie name); never read or return column 6 (cookie value).
        const domain = cols[0].trim().toLowerCase().replace(/^\./, '');
        const cookieName = cols[5].trim();
        if (!domain || !cookieName)
            continue;
        cookieCount++;
        domains.add(domain);
        cookieNames.add(cookieName);
    }
    return { domains, cookieNames, cookieCount };
}
async function fileMatchesPlatformDomain(filePath, platform) {
    try {
        const { domains } = await readNetscapeMetadata(filePath);
        const allowed = PLATFORM_SPECS[platform].domains;
        for (const dom of domains) {
            if (allowed.some(d => dom === d || dom.endsWith(`.${d}`))) {
                return true;
            }
        }
        return false;
    }
    catch {
        return false;
    }
}
async function findPlatformCookiesFile(cookiesDir, platform) {
    const files = await listRegularFiles(cookiesDir);
    if (files.length === 0)
        return undefined;
    const byLower = new Map(files.map(f => [f.name.toLowerCase(), f]));
    const exactOrder = [
        `${platform}.txt`,
        `${platform}_cookies.txt`,
        `${platform}.com_cookies.txt`,
        `www.${platform}.com_cookies.txt`
    ];
    for (const candidate of exactOrder) {
        const hit = byLower.get(candidate.toLowerCase());
        if (hit)
            return hit.fullPath;
    }
    const dynamic = files
        .filter(f => {
        const lower = f.name.toLowerCase();
        return lower.endsWith('.txt') && lower.includes(platform);
    })
        .sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.name.localeCompare(b.name));
    if (dynamic.length > 0) {
        return dynamic[0].fullPath;
    }
    const otherPlatforms = ['bilibili', 'youtube'].filter(p => p !== platform);
    const byDomainCandidates = files
        .filter(f => {
        const lower = f.name.toLowerCase();
        if (!lower.endsWith('.txt'))
            return false;
        if (lower === 'cookies.txt' || lower === 'default.txt')
            return false;
        return !otherPlatforms.some(other => lower.includes(other));
    })
        .sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.name.localeCompare(b.name));
    for (const candidate of byDomainCandidates) {
        if (await fileMatchesPlatformDomain(candidate.fullPath, platform)) {
            return candidate.fullPath;
        }
    }
    return undefined;
}
/**
 * Resolve cookies file path by priority:
 * 1) explicit --cookies (throws if missing)
 * 2) <dataDir>/cookies/<platform> specific or domain-matched file
 * 3) <dataDir>/cookies/cookies.txt or default.txt
 */
export async function resolveCookiesPath(sourceType, options = {}) {
    if (options.explicitCookies && options.explicitCookies.trim()) {
        const absPath = path.resolve(options.explicitCookies.trim());
        const st = await fs.stat(absPath).catch(() => null);
        if (!st || !st.isFile()) {
            throw new Error(`Explicit cookies file not found: ${absPath}`);
        }
        return absPath;
    }
    if (!options.dataDir || sourceType === 'local') {
        return undefined;
    }
    const cookiesDir = getCookiesDir(options.dataDir);
    if (sourceType === 'bilibili' || sourceType === 'youtube') {
        const platformMatch = await findPlatformCookiesFile(cookiesDir, sourceType);
        if (platformMatch)
            return platformMatch;
    }
    const files = await listRegularFiles(cookiesDir);
    const byLower = new Map(files.map(f => [f.name.toLowerCase(), f]));
    for (const fallback of ['cookies.txt', 'default.txt']) {
        const hit = byLower.get(fallback);
        if (hit)
            return hit.fullPath;
    }
    return undefined;
}
/**
 * Inspect Netscape cookies.txt freshness and required key names without ever reading/exposing cookie values.
 */
export async function inspectCookiesFile(filePath, platform) {
    const spec = PLATFORM_SPECS[platform];
    const absPath = path.resolve(filePath);
    const st = await fs.stat(absPath);
    const { cookieNames, cookieCount } = await readNetscapeMetadata(absPath);
    const ageHours = Math.max(0, Math.round(((Date.now() - st.mtimeMs) / 3600000) * 10) / 10);
    const foundKeys = spec.keys.filter(k => cookieNames.has(k));
    const missingKeys = spec.keys.filter(k => !cookieNames.has(k));
    return {
        platform,
        exists: true,
        filePath: absPath,
        updatedAt: new Date(st.mtimeMs).toISOString(),
        ageHours,
        maxAgeHours: spec.maxAgeHours,
        possiblyExpired: ageHours > spec.maxAgeHours,
        cookieCount,
        foundKeys,
        missingKeys,
        hasRequiredKeys: foundKeys.length > 0
    };
}
export async function inspectAllCookies(dataDir) {
    const cookiesDir = getCookiesDir(dataDir);
    const platforms = {};
    for (const platform of ['bilibili', 'youtube']) {
        const spec = PLATFORM_SPECS[platform];
        const filePath = await findPlatformCookiesFile(cookiesDir, platform);
        if (filePath) {
            platforms[platform] = await inspectCookiesFile(filePath, platform);
        }
        else {
            platforms[platform] = {
                platform,
                exists: false,
                maxAgeHours: spec.maxAgeHours,
                possiblyExpired: false,
                cookieCount: 0,
                foundKeys: [],
                missingKeys: [...spec.keys],
                hasRequiredKeys: false
            };
        }
    }
    return { cookiesDir, platforms };
}
//# sourceMappingURL=cookies.js.map