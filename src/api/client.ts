/**
 * HeyBox API 客户端模块
 * 封装了与小黑盒 API 的所有交互，包括用户认证、帖子操作、签到等功能
 */

import * as vscode from "vscode";
import * as https from "https";
import { generateSignature, Signature } from "./signature";
import {
    ApiResponse, PostTreeResult, SearchResult, TopicCategoryResult, SearchItemInfo,
    MessageListResult,
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

    constructor(private context: vscode.ExtensionContext) {}

    /**
     * 加载配置信息
     * 从 VSCode 设置和 SecretStorage 中读取用户配置，包括 cookie、设备 ID 和 heybox ID
     * 如果设备 ID 不存在则自动生成并存储
     */
    async loadConfig(): Promise<void> {
        const config = vscode.workspace.getConfiguration("heybox");
        this.heyboxId = config.get<string>("heyboxId", "");
        // 每次都重新从 SecretStorage 读取，确保登出后能正确清除
        this.cookie = "";
        await this.refreshCookie();

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
     * 刷新 Cookie
     * 从 SecretStorage 中重新读取 cookie，如果已存在则跳过
     */
    async refreshCookie(): Promise<void> {
        if (this.cookie) return;
        try { const s = await this.context.secrets.get("heybox.cookie"); if (s) this.cookie = s; } catch {}
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
        return {
            os_type: "web", app: "heybox", client_type: "web", version: "999.0.4",
            web_version: "2.5", x_client_type: "web", x_app: "heybox_website",
            heybox_id: this.heyboxId, x_os_type: "Windows", device_info: "Chrome",
            device_id: this.deviceId,
        };
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
        const url = this.buildUrl(path, params, this.getQrLoginParams());
        const headers = this.buildHeaders(this.cookieHeader(cookies));
        return new Promise<AnonymousResponse<T>>((resolve, reject) => {
            const req = https.get(url, { headers }, (res) => {
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
            req.on("error", (e: NodeJS.ErrnoException) => reject(new Error(`二维码登录网络错误: ${e.message}`)));
        });
    }

    /**
     * 发送 GET 请求并返回原始响应
     * 不解析业务状态，直接返回 API 原始响应数据
     * @param path API 路径
     * @param params 查询参数
     * @returns 原始 API 响应
     */
    private async getRaw(path: string, params?: Record<string, string>): Promise<ApiResponse<unknown>> {
        if (!this.validateCookie(this.cookie)) throw new Error("请先配置 Cookie：打开设置搜索 heybox.cookie，粘贴 Cookie 值");
        const url = this.buildUrl(path, params);
        const headers = this.buildHeaders();
        return new Promise<ApiResponse<unknown>>((resolve, reject) => {
            const req = https.get(url, { headers }, (res) => {
                let data = "";
                res.on("data", (c) => (data += c));
                res.on("end", () => {
                    try { resolve(JSON.parse(data)); }
                    catch { reject(new Error(`解析响应失败: ${data.substring(0, 200)}`)); }
                });
                res.on("error", reject);
            });
            req.setTimeout(15000, () => { req.destroy(); reject(new Error("请求超时")); });
            req.on("error", (e: NodeJS.ErrnoException) => reject(new Error(`网络错误: ${e.message}`)));
        });
    }

    /**
     * 发送 GET 请求并解析业务数据
     * 自动检查 API 响应状态，处理登录过期等错误
     * @param path API 路径
     * @param params 查询参数
     * @returns 解析后的业务数据
     */
    private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
        if (!this.validateCookie(this.cookie)) throw new Error("请先配置 Cookie：打开设置搜索 heybox.cookie，粘贴 Cookie 值");
        const url = this.buildUrl(path, params);
        const headers = this.buildHeaders();
        return new Promise<T>((resolve, reject) => {
            const req = https.get(url, { headers }, (res) => {
                let data = "";
                res.on("data", (c) => (data += c));
                res.on("end", () => {
                    try {
                        const json: ApiResponse<T> = JSON.parse(data);
                        if (json.status === "ok") resolve(json.result);
                        else if (json.status === "login" || json.status === "relogin") reject(new Error("Cookie 已过期或无效，请重新从浏览器复制 Cookie"));
                        else reject(new Error(json.msg || `API error: ${json.status}`));
                    } catch { reject(new Error(`解析响应失败: ${data.substring(0, 200)}`)); }
                });
                res.on("error", reject);
            });
            req.setTimeout(15000, () => { req.destroy(); reject(new Error("请求超时，请检查网络连接")); });
            req.on("error", (e: NodeJS.ErrnoException) => {
                if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') reject(new Error("网络连接失败，请检查网络"));
                else if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') reject(new Error("连接被重置"));
                else reject(new Error(`网络错误: ${e.message}`));
            });
        });
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
        return this.get<PostTreeResult>("/bbs/app/link/tree", p);
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
     * @param page 页码，默认 1
     * @param limit 每页数量，默认 20
     * @returns 搜索结果
     */
    async searchPosts(query: string, page: number = 1, limit: number = 20): Promise<SearchResult> {
        return this.get<SearchResult>("/bbs/app/api/general/search/v1/web", { q: query, search_type: "link", page: String(page), limit: String(limit) });
    }

    /**
     * 获取话题动态
     * @param topicId 话题 ID
     * @param offset 分页偏移量，默认 0
     * @param limit 返回数量限制，默认 30
     * @returns 话题动态列表
     */
    async getTopicFeeds(topicId: number, offset: number = 0, limit: number = 30): Promise<{ links: SearchItemInfo[]; lastval: string }> {
        return this.get<{ links: SearchItemInfo[]; lastval: string }>("/bbs/app/topic/feeds", { topic_id: String(topicId), offset: String(offset), limit: String(limit) });
    }

    /**
     * 获取首页动态
     * @param offset 分页偏移量，默认 0
     * @param pull 拉取模式，默认 "0"
     * @returns 首页动态列表
     */
    async getFeed(offset: number = 0, pull: string = "0"): Promise<{ links: SearchItemInfo[] }> {
        return this.get<{ links: SearchItemInfo[] }>("/bbs/app/feeds", { offset: String(offset), pull, dw: "800" });
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
        if (!this.validateCookie(this.cookie)) throw new Error("请先配置 Cookie");
        const url = this.buildUrl(path, params);
        const headers = { ...this.buildHeaders(), "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" };
        const bodyStr = Object.entries(body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
        return new Promise<T>((resolve, reject) => {
            const req = https.request(url, { method: "POST", headers }, (res) => {
                let data = "";
                res.on("data", (c) => (data += c));
                res.on("end", () => {
                    try {
                        const json: ApiResponse<T> = JSON.parse(data);
                        if (json.status === "ok") resolve(json.result);
                        else reject(new Error(json.msg || `API error: ${json.status}`));
                    } catch { reject(new Error(`解析失败: ${data.substring(0, 200)}`)); }
                });
                res.on("error", reject);
            });
            req.setTimeout(15000, () => { req.destroy(); reject(new Error("请求超时")); });
            req.write(bodyStr);
            req.end();
        });
    }

    /**
     * 收藏帖子
     * @param linkId 帖子链接 ID
     */
    async favouritePost(linkId: string): Promise<void> {
        await this.post("/bbs/app/link/favour", { link_id: linkId }, { link_id: linkId });
    }

    /**
     * 获取用户消息列表
     * @param listType 消息类型，默认 0
     * @param offset 分页偏移量，默认 0
     * @param limit 返回数量限制，默认 20
     * @returns 消息列表数据
     */
    async getMessages(listType: number = 0, offset: number = 0, limit: number = 20): Promise<MessageListResult> {
        return this.get<MessageListResult>("/bbs/app/user/message", {
            list_type: String(listType),
            offset: String(offset),
            limit: String(limit),
            no_more: "false",
        });
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
        this.cookie = cookie;
        await this.context.secrets.store("heybox.cookie", cookie);

        // 从手动或扫码登录凭证中提取用户 ID，并覆盖可能已失效的旧账号 ID。
        const m = cookie.match(/(?:heybox_id|user_heybox_id|heyboxid)=(\d+)/);
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
        this.cookie = '';
        this.heyboxId = '';
        await this.context.secrets.delete("heybox.cookie");

        const config = vscode.workspace.getConfiguration("heybox");
        await config.update("heyboxId", "", vscode.ConfigurationTarget.Global);
    }

    /**
     * 获取当前 Cookie
     * @returns 当前保存的 cookie 字符串
     */
    getCookie(): string {
        return this.cookie;
    }

    /**
     * 获取扩展上下文
     * @returns VSCode 扩展上下文对象
     */
    getContext(): vscode.ExtensionContext {
        return this.context;
    }
}

