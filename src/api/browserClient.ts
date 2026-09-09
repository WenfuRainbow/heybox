import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import puppeteer, { Browser, BrowserContext, Page } from "puppeteer-core";

const API_BASE = "https://api.xiaoheihe.cn";
const BOOTSTRAP_PATH = "/bbs/app/topic/categories";
const REQUEST_TIMEOUT_MS = 30_000;

export interface BrowserNetworkOptions {
    proxy?: string;
    browserPath?: string;
}

export interface BrowserRequestOptions extends BrowserNetworkOptions {
    method: "GET" | "POST";
    url: string;
    headers: Record<string, string>;
    body?: string;
    cookie?: string;
    anonymous?: boolean;
}

export interface BrowserHttpResult {
    status: number;
    body: string;
    cookies: Record<string, string>;
}

interface BrowserFetchPayload {
    method: "GET" | "POST";
    url: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
}

/** 在浏览器页面内执行 fetch，避免小黑盒对 Node TLS 指纹做连接级风控。 */
async function fetchInBrowser(payload: BrowserFetchPayload): Promise<{ status: number; body: string }> {
    const g: any = globalThis;
    const controller = new g.AbortController();
    const timer = setTimeout(() => controller.abort(), payload.timeoutMs);
    try {
        const response = await g.fetch(payload.url, {
            method: payload.method,
            headers: payload.headers || {},
            body: payload.method === "POST" ? payload.body : undefined,
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
        });
        const body = await response.text();
        return { status: Number(response.status), body };
    } finally {
        clearTimeout(timer);
    }
}

function cookieEntries(cookieHeader: string): Array<{ name: string; value: string }> {
    const result: Array<{ name: string; value: string }> = [];
    for (const part of cookieHeader.split(";")) {
        const eq = part.indexOf("=");
        if (eq <= 0) continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (name) result.push({ name, value });
    }
    return result;
}

async function applyCookies(page: Page, cookieHeader: string): Promise<void> {
    const cookies = cookieEntries(cookieHeader).map(({ name, value }) => ({
        name,
        value,
        url: `${API_BASE}/`,
        secure: true,
        httpOnly: true,
    }));
    if (cookies.length > 0) await page.setCookie(...cookies);
}

async function cookiesAfterRequest(context: BrowserContext): Promise<Record<string, string>> {
    const cookies = await context.cookies();
    const result: Record<string, string> = {};
    for (const cookie of cookies) result[cookie.name] = cookie.value;
    return result;
}

export function findBrowserExecutablePaths(): string[] {
    if (process.platform === "win32") {
        const candidates = [
            process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
            process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
            process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
            process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
            process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
            process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
        ].filter((value): value is string => typeof value === "string" && fs.existsSync(value));
        return candidates;
    }

    if (process.platform === "darwin") {
        const candidates = [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ];
        return candidates.filter((candidate) => fs.existsSync(candidate));
    }

    const found: string[] = [];
    for (const name of ["microsoft-edge", "microsoft-edge-stable", "google-chrome", "chromium", "chromium-browser"]) {
        const result = spawnSync("which", [name], { encoding: "utf8" });
        if (result.status === 0) {
            const value = result.stdout.trim().split(/\r?\n/)[0];
            if (value && !found.includes(value)) found.push(value);
        }
    }
    return found;
}

export function findBrowserExecutablePath(): string | undefined {
    return findBrowserExecutablePaths()[0];
}

function isTrustedBrowserExecutablePath(value: string): boolean {
    const allowed = new Set([
        "msedge.exe",
        "chrome.exe",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "microsoft-edge-stable",
        "google-chrome",
        "microsoft edge",
        "google chrome",
    ]);
    return allowed.has(path.basename(value).toLowerCase());
}

function launchErrorDetail(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const meaningful = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("TROUBLESHOOTING:"));
    return meaningful.slice(0, 8).join(" | ") || "无详细错误信息";
}

/**
 * 浏览器网络客户端。
 *
 * 复用本机 Edge/Chrome，把 API 页面停在 api.xiaoheihe.cn 域名上，再通过页面内
 * fetch 发起同源请求。这样流量来自真实浏览器内核，可绕过小黑盒对 Node TLS 指纹的拦截。
 */
export class BrowserNetworkClient {
    private browser?: Browser;
    private authPage?: Page;
    private launchPromise?: Promise<Browser>;
    private lastAuthCookie = "";
    private proxy = "";
    private browserPath = "";

    configure(options: BrowserNetworkOptions): void {
        const proxy = options.proxy?.trim() || "";
        const browserPath = options.browserPath?.trim() || "";
        if (proxy === this.proxy && browserPath === this.browserPath) return;
        this.proxy = proxy;
        this.browserPath = browserPath;
        void this.dispose();
    }

    async request(options: BrowserRequestOptions): Promise<BrowserHttpResult> {
        const browser = await this.ensureBrowser();
        if (options.anonymous) return this.requestAnonymous(browser, options);
        const page = await this.getAuthPage(browser);
        const cookieHeader = options.cookie ?? "";
        await this.syncCookies(page, cookieHeader);

        const result = await page.evaluate(fetchInBrowser, {
            method: options.method,
            url: options.url,
            headers: this.pickFetchHeaders(options.headers),
            body: options.method === "POST" ? options.body : undefined,
            timeoutMs: REQUEST_TIMEOUT_MS,
        });

        return { ...result, cookies: {} };
    }

    private async requestAnonymous(browser: Browser, options: BrowserRequestOptions): Promise<BrowserHttpResult> {
        const context = await browser.createBrowserContext();
        const page = await context.newPage();
        try {
            await this.loadBootstrap(page);
            const cookieHeader = options.cookie ?? "";
            if (cookieHeader.trim()) await applyCookies(page, cookieHeader);

            const result = await page.evaluate(fetchInBrowser, {
                method: options.method,
                url: options.url,
                headers: this.pickFetchHeaders(options.headers),
                body: options.method === "POST" ? options.body : undefined,
                timeoutMs: REQUEST_TIMEOUT_MS,
            });
            return { ...result, cookies: await cookiesAfterRequest(context) };
        } finally {
            await context.close().catch(() => undefined);
        }
    }

    async dispose(): Promise<void> {
        const browser = this.browser;
        const launchPromise = this.launchPromise;
        this.browser = undefined;
        this.launchPromise = undefined;
        this.authPage = undefined;
        this.lastAuthCookie = "";
        if (launchPromise) {
            launchPromise.then((value) => value.close()).catch(() => undefined);
        } else if (browser?.connected) {
            await browser.close().catch(() => undefined);
        }
    }

    private async ensureBrowser(): Promise<Browser> {
        if (this.browser?.connected) return this.browser;
        if (this.launchPromise) return this.launchPromise;

        const explicitPath = this.browserPath;
        const explicitAllowed = explicitPath ? isTrustedBrowserExecutablePath(explicitPath) : false;
        const candidates = explicitPath
            ? (explicitAllowed ? [explicitPath] : [])
            : findBrowserExecutablePaths();
        if (candidates.length === 0) {
            throw new Error(explicitPath
                ? "heybox.browserPath 仅支持 Edge/Chrome 可执行文件路径"
                : "未找到 Edge/Chrome；请在 heybox.browserPath 中指定浏览器路径");
        }

        const args = [
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-default-apps",
            "--disable-sync",
            "--metrics-recording-only",
            "--mute-audio",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-blink-features=AutomationControlled",
            ...(this.proxy ? [`--proxy-server=${this.proxy}`] : []),
        ];
        this.launchPromise = this.launchBrowserCandidate(candidates, args).catch((error) => {
            this.launchPromise = undefined;
            throw error;
        });

        const browser = await this.launchPromise;
        this.browser = browser;
        this.launchPromise = undefined;
        browser.once("disconnected", () => {
            if (this.browser === browser) {
                this.browser = undefined;
                this.authPage = undefined;
            }
        });
        return browser;
    }

    private async launchBrowserCandidate(candidates: string[], args: string[]): Promise<Browser> {
        const errors: string[] = [];
        for (const executablePath of candidates) {
            try {
                return await puppeteer.launch({
                    executablePath,
                    headless: true,
                    args,
                    ignoreDefaultArgs: ["--enable-automation"],
                });
            } catch (error) {
                const detail = launchErrorDetail(error);
                if (!errors.includes(detail)) errors.push(`${path.basename(executablePath)}: ${detail}`);
            }
        }
        throw new Error(`浏览器启动失败：${errors.join("；")}`);
    }

    private async getAuthPage(browser: Browser): Promise<Page> {
        if (this.authPage && !this.authPage.isClosed()) return this.authPage;
        const page = await browser.newPage();
        await this.loadBootstrap(page);
        this.authPage = page;
        this.lastAuthCookie = "";
        return page;
    }

    private async loadBootstrap(page: Page): Promise<void> {
        page.setDefaultTimeout(30_000);
        const response = await page.goto(`${API_BASE}${BOOTSTRAP_PATH}`, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
        });
        if (!response || response.status() >= 400) {
            throw new Error(`浏览器初始化请求失败(HTTP ${response?.status() ?? "无响应"})`);
        }
    }

    private pickFetchHeaders(headers: Record<string, string>): Record<string, string> {
        const allowed = new Set(["accept", "accept-language", "content-type"]);
        const result: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
            if (allowed.has(key.toLowerCase())) result[key] = value;
        }
        return result;
    }

    private async syncCookies(page: Page, cookieHeader: string): Promise<void> {
        if (this.lastAuthCookie === cookieHeader) return;
        const context = page.browserContext();
        const existing = await context.cookies();
        if (existing.length > 0) await context.deleteCookie(...existing);
        if (cookieHeader.trim()) await applyCookies(page, cookieHeader);
        this.lastAuthCookie = cookieHeader;
    }
}
