/**
 * HeyBox API 客户端模块
 * 封装了与小黑盒 API 的所有交互，包括用户认证和帖子操作等功能
 */

import * as vscode from "vscode";
import * as https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { generateSignature, Signature } from "./signature";
import { HeyBoxApiError, apiErrorFromHttpStatus, unwrapApiResponse } from "./errors";
import { validateLinksResult, validateMessageList, validatePostTree, validateSearchResult } from "./contracts";
import { RequestCoordinator, isSensitiveApiPath } from "./requestPolicy";
import { BrowserNetworkClient, findBrowserExecutablePath } from "./browserClient";
import {
    ApiResponse, PostTreeResult, SearchResult, SearchItem, TopicCategoryResult, SearchItemInfo,
    MessageListResult, FavouriteLinksResult, OfficialMessageResult, DiscountMessageResult,
} from "../types";

const API_BASE = "https://api.xiaoheihe.cn";
const REFERER = "https://www.xiaoheihe.cn/";

export type QrLoginState = "waiting" | "scanned" | "success" | "expired" | "failed";

/** 仅保存在扩展进程内的扫码会话，绝不发送给 Webview。 */
export interface QrLoginSession {
    qrContent: string;
    expiresAt: number;
    pollParams: Record<string, string>;
    cookies: Record<string, string>;
}

export interface QrLoginStatus {
    state: QrLoginState;
    message: string;
    remainingSeconds: number;
    /** 仅 state === success 时存在，调用者应立即存入 SecretStorage。 */
    cookie?: string;
    nickname?: string;
}

interface AnonymousResponse<T> {
    payload: ApiResponse<T>;
    cookies: Record<string, string>;
}

/**
 * HeyBox API 客户端类
 * 提供与小黑盒服务器通信的方法，处理认证、请求签名和数据解析
 */
export class HeyBoxClient {
    private cookie: string = "";
    private deviceId: string = "";
    private heyboxId: string = "";
    private webVersion: string = "";
    private proxyAgent?: https.Agent;
    private proxyError: string = "";
    private proxyLabel: string = "直连";
    private proxyValue: string = "";
    private browserMode: "auto" | "node" | "browser" = "auto";
    private browserPath: string = "";
    private browserNetwork?: BrowserNetworkClient;
    private readonly requestCoordinator = new RequestCoordinator();
    /** 认证变更时递增；旧会话的迟到响应不得跨越这一边界。 */
    private sessionGeneration = 0;

    constructor(private context: vscode.ExtensionContext) {}

    /**
     * 加载配置信息
     * 从 VSCode 设置和 SecretStorage 中读取用户配置，包括 cookie、设备 ID 和 heybox ID
     * 如果设备 ID 不存在则自动生成并存储
     */
    async loadConfig(): Promise<void> {
        const previousCookie = this.cookie;
        const config = vscode.workspace.getConfiguration("heybox");
        this.heyboxId = config.get<string>("heyboxId", "");
        this.webVersion = config.get<string>("webVersion", "").trim();
        this.browserMode = config.get<"auto" | "node" | "browser">("browserMode", "auto");
        this.browserPath = config.get<string>("browserPath", "").trim();
        this.configureProxy(config.get<string>("proxy", ""));
        // 每次都重新从 SecretStorage 读取，确保登出后能正确清除。
        // heybox.cookie 曾是公开设置项；仅在安全存储为空时迁移一次，随后
        // 清空明文设置，避免凭证长期留在 settings.json 中。
        this.cookie = "";
        await this.refreshCookie();
        const configuredCookie = config.get<string>("cookie", "").trim();
        const migrationBlocked = this.context.globalState.get<boolean>("heybox.legacyCookieMigrationBlocked", false);
        if (!this.cookie && !migrationBlocked && configuredCookie && this.validateCookie(configuredCookie)) {
            this.cookie = configuredCookie;
            try {
                await this.context.secrets.store("heybox.cookie", configuredCookie);
                await this.clearLegacyCookieSettings(config);
                await this.context.globalState.update("heybox.legacyCookieMigrationBlocked", true);
            } catch {
                // SecretStorage 不可用时仍可在本次会话使用兼容设置值。
            }
        }

        if (previousCookie !== this.cookie) this.sessionGeneration++;

        const storedDeviceId = this.context.globalState.get<string>("deviceId");
        const configDeviceId = config.get<string>("deviceId", "");
        if (configDeviceId) { this.deviceId = configDeviceId; }
        else if (storedDeviceId) { this.deviceId = storedDeviceId; }
        else { this.deviceId = this.generateDeviceId(); this.context.globalState.update("deviceId", this.deviceId); }

        if (!this.heyboxId && this.cookie) {
            const m = this.cookie.match(/heybox_id=(\d+)/);
            if (m) this.heyboxId = m[1];
        }
    }

    /**
     * 旧 Cookie 可能位于 Global、Workspace 或 WorkspaceFolder 配置层。
     * 必须清除每个存在值的层级：只清除 Global 会让工作区配置在退出后
     * 静默恢复登录态。
     */
    private async clearLegacyCookieSettings(config = vscode.workspace.getConfiguration("heybox")): Promise<void> {
        // 兼容最小化的 ExtensionContext 测试替身。
        if (typeof config.inspect !== "function") return;
        const inspected = config.inspect<string>("cookie");
        if (!inspected) return;
        const targets: Array<[string | undefined, vscode.ConfigurationTarget]> = [
            [inspected.globalValue, vscode.ConfigurationTarget.Global],
            [inspected.workspaceValue, vscode.ConfigurationTarget.Workspace],
            [inspected.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
        ];
        await Promise.allSettled(targets
            .filter(([value]) => typeof value === "string" && value.trim().length > 0)
            .map(([, target]) => config.update("cookie", "", target)));
    }

    /**
     * 刷新 Cookie
     * 从 SecretStorage 中重新读取 cookie，如果已存在则跳过
     */
    async refreshCookie(): Promise<void> {
        if (this.cookie) return;
        try {
            const storedCookie = await this.context.secrets.get("heybox.cookie");
            if (storedCookie) this.cookie = storedCookie;
        } catch {
            // SecretStorage 不可用时保持未登录状态，交由界面提示用户登录。
        }
    }

    /** 配置可选的 HTTP/HTTPS 代理；留空时保持直连。 */
    private configureProxy(value: string): void {
        const proxy = value.trim();
        this.proxyValue = proxy;
        this.proxyAgent = undefined;
        this.proxyError = "";
        this.proxyLabel = "直连";
        this.browserNetwork?.configure({ proxy, browserPath: this.browserPath });
        if (!proxy) return;

        try {
            const url = new URL(proxy);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
                throw new Error("仅支持 http:// 或 https:// 地址");
            }
            this.proxyAgent = new HttpsProxyAgent(url);
            this.proxyLabel = `代理 ${url.protocol}//${url.host}`;
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.proxyError = `代理地址无效：${detail}`;
        }
    }

    private getProxyAgent(): https.Agent | undefined {
        if (this.proxyError) throw new Error(this.proxyError);
        return this.proxyAgent;
    }

    /** 将底层网络错误转换成可区分、可操作的提示。 */
    private networkErrorMessage(error: NodeJS.ErrnoException): string {
        const connection = this.proxyAgent ? `${this.proxyLabel}连接` : "直连";
        switch (error.code) {
            case "ENOTFOUND":
            case "EAI_AGAIN":
                return `${connection}无法解析小黑盒服务器地址，请检查 DNS 或代理设置`;
            case "ECONNREFUSED":
                return `${connection}被拒绝，请检查网络或代理设置`;
            case "ECONNRESET":
                return `${connection}被远端服务器或网络设备重置`;
            case "ETIMEDOUT":
                return `${connection}超时，请检查网络或代理设置`;
            default:
                return `${connection}失败${error.code ? ` (${error.code})` : ""}: ${error.message}`;
        }
    }

    /**
     * 生成随机设备 ID
     * 创建一个 32 位的十六进制字符串作为设备标识符
     * @returns 32 位随机十六进制字符串
     */
    private generateDeviceId(): string {
        let r = ""; const h = "0123456789abcdef";
        for (let i = 0; i < 32; i++) r += h[Math.floor(Math.random() * 16)];
        return r;
    }

    /**
     * 获取公共请求参数
     * 返回所有 API 请求都需要的通用参数，包括客户端信息和设备标识
     * @returns 包含公共参数的对象
     */
    private getCommonParams(): Record<string, string> {
        const params: Record<string, string> = {
            os_type: "web", app: "heybox", client_type: "web", version: "999.0.4",
            x_client_type: "web", x_app: "heybox_website",
            heybox_id: this.heyboxId, x_os_type: "Windows", device_info: "Chrome",
            device_id: this.deviceId,
        };
        // 由设置提供兼容版本；留空时让服务端按客户端能力协商。
        if (this.webVersion) params.web_version = this.webVersion;
        return params;
    }

    /** 二维码登录采用网页端匿名客户端参数，且不携带已有登录会话。 */
    private getQrLoginParams(): Record<string, string> {
        return {
            ...this.getCommonParams(),
            app: "web",
            heybox_id: "",
            _notip: "true",
        };
    }

    /**
     * 构建完整的 API URL
     * 将路径、签名和额外参数组合成完整的请求 URL
     * @param path API 路径
     * @param extraParams 额外的查询参数
     * @returns 完整的 URL 字符串
     */
    private buildUrl(path: string, extraParams?: Record<string, string>, commonParams = this.getCommonParams()): string {
        const sig: Signature = generateSignature(path);
        const params = { ...commonParams, hkey: sig.hkey, _time: String(sig._time), nonce: sig.nonce, ...(extraParams || {}) };
        return `${API_BASE}${path}?${Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
    }

    /**
     * 构建 HTTP 请求头
     * 包含浏览器模拟信息、Cookie 和必要的请求头
     * @returns 请求头对象
     */
    private buildHeaders(cookie = this.cookie): Record<string, string> {
        return {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "*/*", "Accept-Language": "zh-CN,zh;q=0.9",
            Referer: REFERER, Origin: "https://www.xiaoheihe.cn",
            Cookie: cookie,
        };
    }

    /** 从响应 Set-Cookie 中提取 name=value；属性永不持久化或展示。 */
    private responseCookies(res: import("http").IncomingMessage): Record<string, string> {
        const raw = res.headers["set-cookie"];
        const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
        const result: Record<string, string> = {};
        for (const cookie of cookies) {
            const match = /^\s*([^=;\s]+)=([^;]*)/.exec(cookie);
            if (match) result[match[1]] = match[2];
        }
        return result;
    }

    private cookieHeader(cookies: Record<string, string>): string {
        return Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ");
    }

    private mergeLoginFields(cookies: Record<string, string>, value: unknown): { nickname: string; userId: string } {
        const result = value && typeof value === "object" ? value as Record<string, unknown> : {};
        const nested = [result, result.user, result.account, result.profile]
            .filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
        const first = (...keys: string[]): string => {
            for (const source of nested) {
                for (const key of keys) {
                    const candidate = source[key];
                    if (candidate !== undefined && candidate !== null && String(candidate)) return String(candidate);
                }
            }
            return "";
        };
        const userId = first("heybox_id", "user_heybox_id", "heyboxid", "userid", "user_id", "uid", "id");
        const pkey = first("pkey", "user_pkey", "key");
        const token = first("x_xhh_tokenid");
        if (userId && !cookies.heybox_id) cookies.heybox_id = userId;
        if (pkey && !cookies.pkey && !cookies.user_pkey) cookies.pkey = pkey;
        if (token && !cookies.x_xhh_tokenid) cookies.x_xhh_tokenid = token;
        return { userId, nickname: first("nickname", "username", "name") };
    }

    /** 执行不需要登录态的请求，并把 Set-Cookie 保留给二维码会话。 */
    private async anonymousGet<T>(path: string, params: Record<string, string>, cookies: Record<string, string>): Promise<AnonymousResponse<T>> {
        if (this.shouldUseBrowserTransport()) {
            return this.anonymousGetViaBrowser<T>(path, params, cookies);
        }
        const url = this.buildUrl(path, params, this.getQrLoginParams());
        const headers = this.buildHeaders(this.cookieHeader(cookies));
        return new Promise<AnonymousResponse<T>>((resolve, reject) => {
            const req = https.get(url, { headers, agent: this.getProxyAgent() }, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        const payload: ApiResponse<T> = JSON.parse(data);
                        resolve({ payload, cookies: this.responseCookies(res) });
                    } catch {
                        reject(new Error(`解析二维码登录响应失败: ${data.substring(0, 200)}`));
                    }
                });
                res.on("error", reject);
            });
            req.setTimeout(15000, () => { req.destroy(); reject(new Error("二维码登录请求超时，请检查网络")); });
            req.on("error", (e: NodeJS.ErrnoException) => reject(new Error(`二维码登录${this.networkErrorMessage(e)}`)));
        });
    }

    private async anonymousGetViaBrowser<T>(path: string, params: Record<string, string>, cookies: Record<string, string>): Promise<AnonymousResponse<T>> {
        const url = this.buildUrl(path, params, this.getQrLoginParams());
        const headers = this.buildHeaders(this.cookieHeader(cookies));
        const result = await this.getBrowserNetwork().request({
            method: "GET",
            url,
            headers,
            cookie: this.cookieHeader(cookies),
            anonymous: true,
        });
        if ((result.status || 200) >= 400) {
            throw new Error(`二维码登录请求失败(HTTP ${result.status})`);
        }
        let payload: ApiResponse<T>;
        try {
            payload = JSON.parse(result.body);
        } catch {
            throw new Error(`解析二维码登录响应失败: ${result.body.substring(0, 200)}`);
        }
        return { payload, cookies: result.cookies };
    }

    /**
     * 发送 GET 请求并返回原始响应
     * 不解析业务状态，直接返回 API 原始响应数据
     * @param path API 路径
     * @param params 查询参数
     * @returns 原始 API 响应
     */
    private async getRaw(path: string, params?: Record<string, string>): Promise<ApiResponse<unknown>> {
        this.requireCookie();
        return this.request<ApiResponse<unknown>>("GET", path, params, undefined, (payload) => {
            if (!payload || typeof payload !== "object") {
                throw new HeyBoxApiError("response", "服务端返回了无法识别的响应，请稍后重试");
            }
            return payload as ApiResponse<unknown>;
        });
    }

    /**
     * 发送 GET 请求并解析业务数据
     * 自动检查 API 响应状态，处理登录过期等错误
     * @param path API 路径
     * @param params 查询参数
     * @returns 解析后的业务数据
     */
    private async get<T>(path: string, params?: Record<string, string>, validate?: (result: unknown) => T): Promise<T> {
        this.requireCookie();
        return this.request<T>("GET", path, params, undefined, (payload) => {
            const result = unwrapApiResponse<unknown>(payload);
            return validate ? validate(result) : result as T;
        });
    }

    private requireCookie(): void {
        if (!this.validateCookie(this.cookie)) {
            throw new HeyBoxApiError("authentication", "请先配置 Cookie：打开设置搜索 heybox.cookie，或使用扫码登录");
        }
    }

    /**
     * 所有已登录 API 的统一入口：相同请求合并、敏感接口限流、临时错误指数退避。
     * key 不包含签名，确保用户连续点击和轮询重叠时会共享同一个请求。
     */
    private async request<T>(
        method: "GET" | "POST",
        path: string,
        params: Record<string, string> | undefined,
        body: Record<string, string> | undefined,
        parse: (payload: unknown) => T,
    ): Promise<T> {
        this.requireCookie();
        const cookie = this.cookie;
        const generation = this.sessionGeneration;
        const key = `${generation}:${this.requestKey(method, path, params, body)}`;
        try {
            // GET 是只读且可安全重试；POST 的幂等性未由服务端契约保证，
            // 因此只执行一次，调用者可重新发起明确的用户操作。
            return await this.requestCoordinator.execute(key, isSensitiveApiPath(path), async () => {
                const payload = await this.requestJson(method, path, params, body, cookie);
                if (generation !== this.sessionGeneration || cookie !== this.cookie) {
                    throw new HeyBoxApiError("authentication", "登录状态已变更，请重新执行操作");
                }
                return parse(payload);
            }, method === "GET");
        } catch (error) {
            if (error instanceof HeyBoxApiError) throw error;
            if (this.shouldUseBrowserTransport()) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new HeyBoxApiError("network", `浏览器请求失败: ${detail}`, true);
            }
            const networkError = error as NodeJS.ErrnoException;
            throw new HeyBoxApiError("network", this.networkErrorMessage(networkError));
        }
    }

    private requestKey(
        method: "GET" | "POST",
        path: string,
        params?: Record<string, string>,
        body?: Record<string, string>,
    ): string {
        const encode = (value?: Record<string, string>) => Object.entries(value || {})
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${key}=${item}`).join("&");
        return `${method} ${path}?${encode(params)}#${encode(body)}`;
    }

    /** 单次 HTTPS 请求；重试、并发和去重由 request() 的协调器处理。 */
    private requestJson(
        method: "GET" | "POST",
        path: string,
        params?: Record<string, string>,
        body?: Record<string, string>,
        cookie = this.cookie,
    ): Promise<unknown> {
        if (this.shouldUseBrowserTransport()) {
            return this.requestJsonViaBrowser(method, path, params, body, cookie);
        }
        return new Promise<unknown>((resolve, reject) => {
            let settled = false;
            const fail = (error: unknown) => {
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            };
            const succeed = (value: unknown) => {
                if (!settled) {
                    settled = true;
                    resolve(value);
                }
            };
            try {
                const url = this.buildUrl(path, params);
                const headers = {
                    ...this.buildHeaders(cookie),
                    ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" } : {}),
                };
                const onResponse = (res: import("http").IncomingMessage) => {
                    let data = "";
                    res.on("data", (chunk) => { data += chunk; });
                    res.on("end", () => {
                        if ((res.statusCode || 200) >= 400) {
                            fail(apiErrorFromHttpStatus(res.statusCode || 500));
                            return;
                        }
                        try {
                            succeed(JSON.parse(data));
                        } catch {
                            fail(new HeyBoxApiError("response", `解析响应失败: ${data.substring(0, 200)}`));
                        }
                    });
                    res.on("error", fail);
                };
                const request = method === "GET"
                    ? https.get(url, { headers, agent: this.getProxyAgent() }, onResponse)
                    : https.request(url, { method, headers, agent: this.getProxyAgent() }, onResponse);
                request.setTimeout(15_000, () => {
                    request.destroy();
                    fail(new HeyBoxApiError("timeout", `${this.proxyAgent ? this.proxyLabel : "直连"}请求超时，请检查网络或代理设置`, true));
                });
                request.on("error", fail);
                if (method === "POST") {
                    const bodyString = Object.entries(body || {})
                        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
                    request.write(bodyString);
                    request.end();
                }
            } catch (error) {
                fail(error);
            }
        });
    }

    private async requestJsonViaBrowser(
        method: "GET" | "POST",
        path: string,
        params?: Record<string, string>,
        body?: Record<string, string>,
        cookie = this.cookie,
    ): Promise<unknown> {
        const headers: Record<string, string> = {
            ...this.buildHeaders(cookie),
            ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" } : {}),
        };
        const result = await this.getBrowserNetwork().request({
            method,
            url: this.buildUrl(path, params),
            headers,
            cookie,
            body: method === "POST" ? this.encodeFormBody(body || {}) : undefined,
        });
        if ((result.status || 200) >= 400) {
            throw apiErrorFromHttpStatus(result.status);
        }
        try {
            return JSON.parse(result.body);
        } catch {
            throw new HeyBoxApiError("response", `解析响应失败: ${result.body.substring(0, 200)}`);
        }
    }

    private encodeFormBody(body: Record<string, string>): string {
        return Object.entries(body)
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
            .join("&");
    }

    private shouldUseBrowserTransport(): boolean {
        if (this.browserMode === "browser") return true;
        if (this.browserMode === "node") return false;
        return Boolean(this.browserPath || findBrowserExecutablePath());
    }

    private getBrowserNetwork(): BrowserNetworkClient {
        if (!this.browserNetwork) this.browserNetwork = new BrowserNetworkClient();
        this.browserNetwork.configure({ proxy: this.proxyValue, browserPath: this.browserPath });
        return this.browserNetwork;
    }

    /**
     * 获取帖子树（帖子详情和回复）
     * @param linkId 帖子链接 ID
     * @param offset 分页偏移量，默认 0
     * @param limit 返回数量限制，默认 0（无限制）
     * @param sortFilter 排序筛选条件
     * @returns 帖子树数据
     */
    async getPostTree(linkId: string, offset: number = 0, limit: number = 0, sortFilter?: string): Promise<PostTreeResult> {
        const p: Record<string, string> = { link_id: linkId, offset: String(offset) };
        p.limit = limit > 0 ? String(limit) : "100";
        if (sortFilter) p.sort_filter = sortFilter;
        return this.get<PostTreeResult>("/bbs/app/link/tree", p, validatePostTree);
    }

    /**
     * 将帖子正文中的展示图 URL 换成小黑盒返回的原图 URL。
     * 接口的 imgs 字段在不同版本中可能是 URL 字符串或 JSON 字符串，统一解析为首个 HTTPS 地址。
     */
    async getOriginalImageUrl(imageUrl: string): Promise<string> {
        const result = await this.get<unknown>("/bbs/app/api/original/image", { url: imageUrl });
        const originalUrl = findImageUrl(result);
        if (!originalUrl) throw new Error("服务端未返回可用的原图地址");
        return originalUrl;
    }

    /** 获取某条主评论下的子评论（回复），支持使用上一页最后一条评论 ID 分页。 */
    async getSubComments(rootCommentId: string, lastval: string = ""): Promise<{ comments: import("../types").Comment[]; lastval: string }> {
        const result = await this.get<any>("/bbs/app/comment/sub/comments", {
            root_comment_id: rootCommentId,
            lastval,
        });
        const comments = Array.isArray(result?.comments)
            ? result.comments
            : Array.isArray(result?.comment) ? result.comment : [];
        return {
            comments,
            lastval: String(result?.lastval ?? comments.at(-1)?.commentid ?? ""),
        };
    }

    /**
     * 搜索帖子
     * @param query 搜索关键词
     * @param offset 偏移量，网页端每页递增 30
     * @param limit 每页数量，默认 20
     * @returns 搜索结果
     */
    async searchPosts(query: string, offset: number = 0, limit: number = 30): Promise<SearchResult> {
        // 当前网页版使用 /v1 + offset 分页；旧 /v1/web 的 page 参数会在后续页重复返回首屏结果。
        const result = await this.get<{ items?: Array<SearchItem | { type?: string; info?: SearchItemInfo }>; bottom_tips?: string }>(
            "/bbs/app/api/general/search/v1",
            {
                q: query,
                search_type: "link",
                is_pull_down: "0",
                offset: String(offset),
                limit: String(limit),
                dw: "800",
            }, validateSearchResult,
        );
        const rawItems = result.items || [];
        const items = rawItems
            .filter((item): item is SearchItem | { type?: string; info: SearchItemInfo } =>
                !!item?.info && (!("type" in item) || !item.type || item.type === "link"),
            )
            .map((item) => ({ info: item.info }));
        return {
            items,
            bottom_tips: result.bottom_tips || "",
            raw_item_count: rawItems.length,
        };
    }

    /**
     * 获取话题动态
     * @param topicId 话题 ID
     * @param offset 分页偏移量，默认 0
     * @param limit 返回数量限制，默认 30
     * @returns 话题动态列表
     */
    async getTopicFeeds(topicId: number, offset: number = 0, limit: number = 30): Promise<{ links: SearchItemInfo[]; lastval: string }> {
        return this.get<{ links: SearchItemInfo[]; lastval: string }>("/bbs/app/topic/feeds", { topic_id: String(topicId), offset: String(offset), limit: String(limit) }, (result) => validateLinksResult(result, "话题动态") as { links: SearchItemInfo[]; lastval: string });
    }

    /**
     * 获取首页动态
     * @param offset 分页偏移量，默认 0
     * @param pull 拉取模式，默认 "0"
     * @returns 首页动态列表
     */
    async getFeed(offset: number = 0, pull: string = "0"): Promise<{ links: SearchItemInfo[] }> {
        return this.get<{ links: SearchItemInfo[] }>("/bbs/app/feeds", { offset: String(offset), pull, dw: "800" }, (result) => validateLinksResult(result, "推荐动态"));
    }

    /**
     * 获取话题分类列表
     * @returns 话题分类数据
     */
    async getTopicCategories(): Promise<TopicCategoryResult> {
        return this.get<TopicCategoryResult>("/bbs/app/topic/categories");
    }

    /**
     * 发送 POST 请求
     * 自动构建请求体和签名，处理响应解析
     * @param path API 路径
     * @param body POST 请求体
     * @param params 额外的查询参数
     * @returns 解析后的业务数据
     */
    async post<T>(path: string, body: Record<string, string>, params?: Record<string, string>): Promise<T> {
        this.requireCookie();
        // unwrapApiResponse 同时识别 login、relogin 与 show_captcha，避免 POST 被误报为普通 API 错误。
        return this.request<T>("POST", path, params, body, unwrapApiResponse<T>);
    }

    /**
     * 收藏帖子
     * @param linkId 帖子链接 ID
     */
    async favouritePost(linkId: string): Promise<void> {
        await this.post("/bbs/app/link/favour", { link_id: linkId }, { link_id: linkId });
    }

    /** 获取评论或获赞消息；保留给现有调用方使用。 */
    async getMessages(listType: number = 0, offset: number = 0, limit: number = 20): Promise<MessageListResult> {
        return this.get<MessageListResult>("/bbs/app/user/message", {
            list_type: String(listType),
            offset: String(offset),
            limit: String(limit),
            no_more: "false",
        }, validateMessageList);
    }

    /** 获取网页消息中心的一类互动消息（评论、获赞、关注、@我）。 */
    async getInteractionMessages(
        kind: "comment" | "award" | "follow" | "mention",
        offset: number = 0,
        limit: number = 20,
    ): Promise<MessageListResult> {
        const params: Record<string, string> = {
            offset: String(offset),
            limit: String(limit),
            no_more: "false",
        };
        if (kind === "comment") params.list_type = "0";
        else if (kind === "award") params.list_type = "1";
        else if (kind === "follow") params.message_type = "4";
        else params.message_type = "16";
        return this.get<MessageListResult>("/bbs/app/user/message", params, validateMessageList);
    }

    /** 获取服务端默认收藏夹的帖子列表，不依赖本地缓存。 */
    async getFavouriteLinks(offset: number = 0, limit: number = 30): Promise<{ links: SearchItemInfo[]; hasMore: boolean }> {
        const result = await this.get<FavouriteLinksResult>("/bbs/app/profile/fav/folder/v2/links", {
            enable_new_style_collect: "1",
            dw: "800",
            offset: String(offset),
            limit: String(limit),
        });
        const links = (result.links || [])
            .filter((item) => String(item?.is_deleted || "0") !== "1" && item?.link?.linkid)
            .map((item) => item.link!)
            .filter((item, index, all) => all.findIndex((candidate) => candidate.linkid === item.linkid) === index);
        const flag = result.has_next;
        const hasMore = flag === "1" || flag === 1 || flag === true;
        return { links, hasMore };
    }

    /** 获取官方公告、活动及开发者动态；subEntry 缺省时读取官方消息主列表。 */
    async getOfficialMessages(offset: number = 0, limit: number = 20, lastval: string = "", subEntry?: string): Promise<OfficialMessageResult> {
        const params: Record<string, string> = { offset: String(offset), limit: String(limit), lastval };
        if (subEntry) params.sub_entry = subEntry;
        return this.get<OfficialMessageResult>("/bbs/notify/official_msg_v2/list", params);
    }

    /** 获取已关注游戏的优惠消息；只读且使用网页端游标分页。 */
    async getDiscountMessages(offset: number = 0, lastTimestamp: string = ""): Promise<DiscountMessageResult> {
        const params: Record<string, string> = { message_type: "8", offset: String(offset) };
        if (lastTimestamp) params.last_timestamp = lastTimestamp;
        return this.get<DiscountMessageResult>("/bbs/app/user/discount_message_v2", params);
    }

    /** 创建二维码登录会话。二维码内容只用于本地渲染，凭证始终留在扩展进程内。 */
    async startQrLogin(): Promise<QrLoginSession> {
        const response = await this.anonymousGet<{ qr_url?: unknown; qrcode?: unknown; url?: unknown; expire?: unknown; expires_in?: unknown }>(
            "/account/get_qrcode_url/", {}, {}
        );
        if (response.payload.status !== "ok") {
            throw new Error(response.payload.msg || `获取二维码失败: ${response.payload.status}`);
        }
        const result = response.payload.result || {};
        const qrContent = String(result.qr_url || result.qrcode || result.url || "");
        if (!qrContent) throw new Error("二维码响应缺少二维码地址");

        let pollParams: Record<string, string> = {};
        try {
            pollParams = Object.fromEntries(new URL(qrContent).searchParams.entries());
        } catch {
            throw new Error("二维码地址格式无效");
        }
        if (Object.keys(pollParams).length === 0) throw new Error("二维码响应缺少轮询参数");

        const rawExpiry = Number(result.expire ?? result.expires_in ?? 120);
        const ttlSeconds = Number.isFinite(rawExpiry)
            ? Math.max(10, Math.min(rawExpiry > 10_000_000_000 ? (rawExpiry - Date.now()) / 1000 : rawExpiry, 600))
            : 120;
        return {
            qrContent,
            expiresAt: Date.now() + ttlSeconds * 1000,
            pollParams,
            cookies: { ...response.cookies },
        };
    }

    /** 查询扫码状态；成功时返回可直接保存的完整 Cookie Header。 */
    async pollQrLogin(session: QrLoginSession): Promise<QrLoginStatus> {
        const remainingSeconds = Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000));
        if (remainingSeconds === 0) return { state: "expired", message: "二维码已过期", remainingSeconds: 0 };

        const response = await this.anonymousGet<Record<string, unknown>>(
            "/account/qr_state/", session.pollParams, session.cookies
        );
        Object.assign(session.cookies, response.cookies);
        const result = response.payload.result && typeof response.payload.result === "object"
            ? response.payload.result as Record<string, unknown>
            : {};
        const message = String(result.error_msg || result.message || result.msg || response.payload.msg || "");
        const marker = String(result.error || result.err || result.state || result.status || "").trim().toLowerCase();

        if (marker === "ok" || marker === "success" || marker === "confirmed" || marker === "2") {
            const identity = this.mergeLoginFields(session.cookies, result);
            const cookie = this.cookieHeader(session.cookies);
            if (!this.validateCookie(cookie)) {
                return { state: "failed", message: "登录成功响应未包含可用凭证，请重新扫码", remainingSeconds };
            }
            return { state: "success", message: "登录成功", remainingSeconds, cookie, nickname: identity.nickname };
        }
        if (["scanned", "ready", "confirm", "1"].includes(marker)) {
            return { state: "scanned", message: message || "已扫码，请在手机上确认登录", remainingSeconds };
        }
        if (["expired", "timeout", "3"].includes(marker) || /过期|失效|超时/i.test(message)) {
            return { state: "expired", message: message || "二维码已过期", remainingSeconds: 0 };
        }
        if (["failed", "error", "-1"].includes(marker)) {
            return { state: "failed", message: message || "扫码登录失败", remainingSeconds };
        }
        return { state: "waiting", message: message || "请使用小黑盒 App 扫码", remainingSeconds };
    }

    /**
     * 设置并保存 Cookie（仅存储到 SecretStorage，不写入明文 settings）
     * 同时从 cookie 中提取 heybox_id 并更新配置
     * @param cookie 要保存的 cookie 字符串
     */
    async setCookie(cookie: string): Promise<void> {
        const nextCookie = cookie.trim();
        if (!this.validateCookie(nextCookie)) throw new Error("Cookie 格式无效");
        const changed = this.cookie !== nextCookie;
        this.cookie = nextCookie;
        if (changed) this.sessionGeneration++;
        await this.context.secrets.store("heybox.cookie", nextCookie);

        // 从手动或扫码登录凭证中提取用户 ID，并覆盖可能已失效的旧账号 ID。
        const m = nextCookie.match(/(?:heybox_id|user_heybox_id|heyboxid)=(\d+)/);
        if (m) {
            this.heyboxId = m[1];
            const config = vscode.workspace.getConfiguration("heybox");
            await config.update("heyboxId", this.heyboxId, vscode.ConfigurationTarget.Global);
        }
    }

    /**
     * 验证 Cookie 是否有效（格式检查）
     * 检查 cookie 是否包含必要的认证字段
     * @param cookie 要验证的 cookie 字符串
     * @returns 是否有效
     */
    validateCookie(cookie: string): boolean {
        if (!cookie || typeof cookie !== 'string') return false;
        const trimmed = cookie.trim();
        if (trimmed.length === 0) return false;

        return trimmed.includes('heybox_id=') ||
               trimmed.includes('user_heybox_id=') ||
               trimmed.includes('x_xhh_tokenid=') ||
               trimmed.includes('pkey=') ||
               trimmed.includes('user_pkey=');
    }

    /**
     * 清除已存储的 Cookie
     * 同时清除内存中的 cookie 和 SecretStorage 中的存储，并重置 heybox_id
     */
    async clearCookie(): Promise<void> {
        const hadCookie = !!this.cookie;
        this.cookie = '';
        this.heyboxId = '';
        const config = vscode.workspace.getConfiguration("heybox");
        if (hadCookie) this.sessionGeneration++;
        // 关闭隔离浏览器而不只是删除 Cookie，同时阻止退出前在途页面被
        // 后续会话复用。
        await this.browserNetwork?.dispose();
        this.browserNetwork = undefined;
        // 即使某个设置层无法重写（例如只读工作区），这个持久化屏障也会
        // 阻止它在下次激活时被重新视为新凭证。
        await this.context.globalState.update("heybox.legacyCookieMigrationBlocked", true);
        await this.context.secrets.delete("heybox.cookie");
        await this.clearLegacyCookieSettings(config);
        await config.update("heyboxId", "", vscode.ConfigurationTarget.Global);
    }

    /**
     * 获取当前 Cookie
     * @returns 当前保存的 cookie 字符串
     */
    getCookie(): string {
        return this.cookie;
    }

    getSessionGeneration(): number {
        return this.sessionGeneration;
    }

    /** 释放浏览器进程等资源；扩展停用时调用。 */
    dispose(): void {
        void this.browserNetwork?.dispose();
        this.browserNetwork = undefined;
    }

    /**
     * 获取扩展上下文
     * @returns VSCode 扩展上下文对象
     */
    getContext(): vscode.ExtensionContext {
        return this.context;
    }
}

/** 从原图接口的多种响应形态中提取第一个 HTTPS 图片地址。 */
function findImageUrl(value: unknown): string {
    if (typeof value === "string") {
        const text = value.trim();
        if (/^https:\/\//i.test(text)) return text;
        try { return findImageUrl(JSON.parse(text)); } catch { return ""; }
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const url = findImageUrl(item);
            if (url) return url;
        }
        return "";
    }
    if (!value || typeof value !== "object") return "";
    const fields = value as Record<string, unknown>;
    for (const key of ["imgs", "original", "url", "img", "image"]) {
        const url = findImageUrl(fields[key]);
        if (url) return url;
    }
    return "";
}

