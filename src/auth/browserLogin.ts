/**
 * 浏览器半自动登录
 *
 * 通过 playwright-core 启动系统已安装的有头 Edge/Chrome，打开小黑盒真实登录页，
 * 用户在浏览器中手动完成登录（密码/短信/扫码均可）。不依赖任何页面 DOM 结构，
 * 不自动填表。
 *
 * 流程（避免高频自动请求触发风控频控）：
 * 1. 轮询浏览器 Cookie，message 接口轻量探活确认已登录；
 * 2. 自动加载真实首页并打开一个真实帖子页面，让站点自身的请求在真实浏览器执行；
 *    若页面出现人机验证（滑块/点选），由用户完成——人工浏览是解除风控的可靠方式
 *    （等同手动粘贴 Cookie 前在真实浏览器中的正常浏览）；
 * 3. 用户在弹窗中确认"能正常打开帖子"后，插件抓取最新 Cookie，做一次最终轻量校验
 *    并写入 SecretStorage。
 */
import * as vscode from "vscode";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { HeyBoxClient } from "../api/client";

const LOGIN_URL = "https://login.xiaoheihe.cn/";
/** 登录成功后加载的真实首页：让站点完成登录引导并种下与真实浏览会话一致的 Cookie */
const HOME_URL = "https://www.xiaoheihe.cn/home";
/** 帖子详情页 URL 前缀：在浏览器中真实打开，让站点自己的请求在真实浏览器环境执行 */
const POST_URL = "https://www.xiaoheihe.cn/app/bbs/link/";
const POLL_INTERVAL_MS = 1000;
/** 两次服务端探活的最小间隔，避免对 API 轰炸 */
const MIN_PROBE_INTERVAL_MS = 3000;
/** 首次探活通过后等待补发 Set-Cookie 的沉降窗口 */
const SETTLE_MS = 2500;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** 人工确认阶段的最大轮数（每轮由用户点击触发，不自动空转） */
const MAX_CONFIRM_ROUNDS = 4;

export type BrowserLoginResult = "success" | "cancelled" | "timeout" | "error";

interface RawCookie {
    name: string;
    value: string;
    domain: string;
}

/** 当前进行中的登录会话（单飞护栏 + 外部取消句柄） */
let activeFinish: ((result: BrowserLoginResult) => void) | undefined;

/**
 * 外部取消进行中的浏览器登录（进度条取消按钮 / deactivate 清理用）
 * 仅在等待用户登录（阶段一）期间生效
 */
export function cancelActiveBrowserLogin(): void {
    if (activeFinish) activeFinish("cancelled");
}

/**
 * 将浏览器 cookie 列表格式化为请求头使用的 "name=value; ..." 字符串
 * 过滤非 xiaoheihe.cn 域；同名 cookie 去重，优先保留全站域 .xiaoheihe.cn 的值
 */
export function formatCookies(cookies: RawCookie[]): string {
    const byName = new Map<string, RawCookie>();
    for (const c of cookies) {
        if (!c.domain || !c.domain.endsWith("xiaoheihe.cn")) continue;
        const prev = byName.get(c.name);
        if (!prev || (c.domain === ".xiaoheihe.cn" && prev.domain !== ".xiaoheihe.cn")) {
            byName.set(c.name, c);
        }
    }
    return Array.from(byName.values()).map(c => `${c.name}=${c.value}`).join("; ");
}

/**
 * 启动系统已安装的有头浏览器，优先 Edge，回退 Chrome
 */
async function launchBrowser(): Promise<Browser> {
    const { chromium } = await import("playwright-core");
    const failures: string[] = [];
    for (const channel of ["msedge", "chrome"]) {
        try {
            return await chromium.launch({ channel, headless: false });
        } catch (e) {
            failures.push(`${channel}: ${(e as Error).message}`);
        }
    }
    throw new Error(`未找到可用的 Edge / Chrome 浏览器（${failures.join("；")}）`);
}

/**
 * 打开真实浏览器登录页进行半自动登录
 *
 * @returns success 登录成功且 Cookie 已存入 SecretStorage；
 *          cancelled 用户取消或关闭了浏览器；timeout 超时；error 启动失败等
 */
export async function loginWithBrowser(client: HeyBoxClient): Promise<BrowserLoginResult> {
    if (activeFinish) {
        vscode.window.showWarningMessage("已有浏览器登录窗口进行中，请先完成或取消。");
        return "error";
    }

    let browser: Browser;
    try {
        browser = await launchBrowser();
    } catch (e) {
        vscode.window.showErrorMessage(`浏览器登录失败：${(e as Error).message}。可改用「手动粘贴 Cookie」。`);
        return "error";
    }

    const browserContext = await browser.newContext({ locale: "zh-CN" });
    const page = await browserContext.newPage();
    await page.goto(LOGIN_URL).catch(() => { /* 打开失败不中断，用户可在窗口中手动导航 */ });

    // ── 阶段一：等待用户登录（轻量 message 探活确认，不碰帖子详情接口）──
    const phase1 = await vscode.window.withProgress<BrowserLoginResult>(
        {
            location: vscode.ProgressLocation.Notification,
            title: "HeyBox：请在浏览器中登录小黑盒（登录后请一并完成页面出现的人机验证）",
            cancellable: true,
        },
        (progress, token) => waitForLogin(browser, browserContext, page, client, progress, token),
    );
    if (phase1 !== "success") {
        await browserContext.close().catch(() => { });
        await browser.close().catch(() => { });
        return phase1;
    }

    // ── 阶段二：人工浏览确认 + 抓取（全程无自动高频请求）──
    try {
        const result = await confirmAndCapture(browser, browserContext, client);
        return result;
    } finally {
        await browserContext.close().catch(() => { /* 可能已被用户关闭 */ });
        await browser.close().catch(() => { /* 可能已被用户关闭 */ });
    }
}

/**
 * 轮询浏览器 Cookie，等待用户完成登录（阶段一）。
 *
 * 注意（实测）：
 * - 登录页对未登录访客也会种下 x_xhh_tokenid（设备令牌），不能拿它当登录标志；
 *   可靠候选门槛是 heybox_id（用户 ID，仅登录后写入），且需经服务端确认——
 *   匿名会话带 heybox_id 参数请求 message 接口会被服务端以 relogin 拒绝。
 * - 此处只做 message 轻量探活。帖子详情接口（link/tree）的风控交由阶段二的
 *   人工浏览确认处理：自动高频请求反而会触发服务端"尝试太频繁"频控。
 */
function waitForLogin(
    browser: Browser,
    browserContext: BrowserContext,
    page: Page,
    client: HeyBoxClient,
    progress: vscode.Progress<{ message?: string }>,
    token: vscode.CancellationToken,
): Promise<BrowserLoginResult> {
    return new Promise<BrowserLoginResult>((resolve) => {
        let settled = false;
        let probing = false;
        let lastProbeAt = 0;
        let lastProbed = "";
        let bootstrapped = false;
        let pollTimer: ReturnType<typeof setInterval> | undefined;
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (result: BrowserLoginResult) => {
            if (settled) return;
            settled = true;
            activeFinish = undefined;
            if (pollTimer) clearInterval(pollTimer);
            if (timeoutTimer) clearTimeout(timeoutTimer);
            resolve(result);
        };

        activeFinish = finish;
        token.onCancellationRequested(() => finish("cancelled"));
        browser.on("disconnected", () => finish("cancelled"));
        timeoutTimer = setTimeout(() => finish("timeout"), LOGIN_TIMEOUT_MS);

        pollTimer = setInterval(() => {
            if (settled || probing) return;
            void checkOnce();
        }, POLL_INTERVAL_MS);

        const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

        async function checkOnce(): Promise<void> {
            probing = true;
            try {
                let cookies: RawCookie[];
                try {
                    cookies = await browserContext.cookies();
                } catch { return; /* 上下文已关闭或临时错误，下一轮重试 */ }

                const cookieStr = formatCookies(cookies);
                // 门槛：必须出现 heybox_id（用户 ID）。匿名访客只有 x_xhh_tokenid，
                // 不会进入探活流程——浏览器窗口保持打开等待用户真正登录。
                if (!cookieStr || !/(?:^|;\s*)heybox_id=\d+/.test(cookieStr)) return;

                const now = Date.now();
                if (cookieStr === lastProbed || now - lastProbeAt < MIN_PROBE_INTERVAL_MS) return;
                lastProbeAt = now;
                lastProbed = cookieStr;

                progress.report({ message: "正在确认登录状态…" });
                // 服务端不认可的候选（半套登录态、过期 token）一律继续等待
                if (!(await client.verifyCookie(cookieStr))) return;
                if (settled) return;

                bootstrapped = true;
                // 登录成功：加载真实首页，让站点完成登录引导并补发与真实会话一致的 Cookie
                progress.report({ message: "已确认登录，正在加载小黑盒首页…" });
                await page.goto(HOME_URL).catch(() => { /* 首页加载失败不中断 */ });
                // 沉降窗口：让首页的 API 流量与补发的 Set-Cookie 完成
                await sleep(SETTLE_MS);
                if (settled) return;

                // 自动打开一个真实帖子页面，引导用户确认/完成人机验证
                progress.report({ message: "正在打开真实帖子页面…" });
                const cookieNow = formatCookies(await browserContext.cookies().catch(() => []));
                const linkId = await client.probeLinkId(cookieNow);
                if (linkId) {
                    await page.goto(`${POST_URL}${linkId}`).catch(() => { /* 打开失败不中断 */ });
                    await sleep(SETTLE_MS);
                }
                finish("success");
            } finally {
                probing = false;
            }
        }
    });
}

/**
 * 阶段二：人工浏览确认后抓取并保存 Cookie。
 *
 * 循环由用户点击驱动（每轮一次弹窗 + 一次最终轻量校验），不自动空转，
 * 避免触发服务端频控。浏览器窗口保持打开，用户可随时完成人机验证或浏览更多帖子。
 */
async function confirmAndCapture(
    browser: Browser,
    browserContext: BrowserContext,
    client: HeyBoxClient,
): Promise<BrowserLoginResult> {
    // 浏览器被关闭时立即中止，避免弹窗悬挂
    const closed = new Promise<boolean>((resolve) => {
        browser.once("disconnected", () => resolve(true));
        browserContext.once("close", () => resolve(true));
    });

    for (let round = 0; round < MAX_CONFIRM_ROUNDS; round++) {
        const hint = round === 0
            ? "已登录小黑盒并打开了一个帖子页面：请确认帖子内容能正常显示；若页面出现人机验证（滑块/点选），请完成它。确认无误后点击下方按钮完成登录。"
            : "帖子详情接口仍被风控拦截：请在浏览器中再打开几个帖子浏览，或完成页面出现的人机验证，然后再次点击获取。";
        const pick = await Promise.race([
            vscode.window.showInformationMessage(hint, { modal: true }, "已能正常打开帖子，获取 Cookie", "取消"),
            closed.then(() => undefined),
        ]);
        if (pick === undefined) return "cancelled"; // 用户取消或浏览器已关闭
        if (pick === "取消") return "cancelled";

        const cookieStr = formatCookies(await browserContext.cookies().catch(() => []));
        if (!cookieStr || !/(?:^|;\s*)heybox_id=\d+/.test(cookieStr)) {
            vscode.window.showWarningMessage("未能获取登录 Cookie，请确认浏览器窗口仍处于登录状态后重试。");
            return "cancelled";
        }

        // 最终轻量校验（单次）：确保保存的会话能真正打开帖子详情
        if (await client.canOpenPost(cookieStr)) {
            await client.setCookie(cookieStr);
            return "success";
        }
    }

    vscode.window.showWarningMessage(
        "多次尝试后帖子详情仍被风控拦截（可能是账号/网络触发了频率限制）。建议稍后重试，或改用「手动粘贴 Cookie」登录。",
    );
    return "error";
}

