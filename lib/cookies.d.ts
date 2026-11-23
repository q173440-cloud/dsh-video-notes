import { VideoSourceType } from './types.js';
export type CookiePlatform = 'bilibili' | 'youtube';
export interface CookieInspection {
    platform: CookiePlatform;
    exists: boolean;
    filePath?: string;
    updatedAt?: string;
    ageHours?: number;
    maxAgeHours: number;
    possiblyExpired: boolean;
    cookieCount: number;
    foundKeys: string[];
    missingKeys: string[];
    hasRequiredKeys: boolean;
}
export declare function getCookiesDir(dataDir: string): string;
/**
 * Resolve cookies file path by priority:
 * 1) explicit --cookies (throws if missing)
 * 2) <dataDir>/cookies/<platform> specific or domain-matched file
 * 3) <dataDir>/cookies/cookies.txt or default.txt
 */
export declare function resolveCookiesPath(sourceType: VideoSourceType, options?: {
    explicitCookies?: string;
    dataDir?: string;
}): Promise<string | undefined>;
/**
 * Inspect Netscape cookies.txt freshness and required key names without ever reading/exposing cookie values.
 */
export declare function inspectCookiesFile(filePath: string, platform: CookiePlatform): Promise<CookieInspection>;
export declare function inspectAllCookies(dataDir: string): Promise<{
    cookiesDir: string;
    platforms: Record<CookiePlatform, CookieInspection>;
}>;
//# sourceMappingURL=cookies.d.ts.map