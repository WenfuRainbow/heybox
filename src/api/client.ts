import * as vscode from "vscode";
import * as https from "https";
import { generateSignature, Signature } from "./signature";
import {
    ApiResponse, PostTreeResult, SearchResult, TopicCategoryResult, SearchItemInfo,
    SignTaskListResult, MessageListResult,
} from "../types";

const API_BASE = "https://api.xiaoheihe.cn";
const REFERER = "https://www.xiaoheihe.cn/";

export class HeyBoxClient {
    private cookie: string = "";
    private deviceId: string = "";
    private heyboxId: string = "";

    constructor(private context: vscode.ExtensionContext) {}

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

    async refreshCookie(): Promise<void> {
        if (this.cookie) return;
        try { const s = await this.context.secrets.get("heybox.cookie"); if (s) this.cookie = s; } catch {}
    }

    private generateDeviceId(): string {
        let r = ""; const h = "0123456789abcdef";
        for (let i = 0; i < 32; i++) r += h[Math.floor(Math.random() * 16)];
        return r;
    }

    private getCommonParams(): Record<string, string> {
        return {
            os_type: "web", app: "heybox", client_type: "web", version: "999.0.4",
            web_version: "2.5", x_client_type: "web", x_app: "heybox_website",
            heybox_id: this.heyboxId, x_os_type: "Windows", device_info: "Chrome",
            device_id: this.deviceId,
        };
    }

    private buildUrl(path: string, extraParams?: Record<string, string>): string {
        const sig: Signature = generateSignature(path);
        const params = { ...this.getCommonParams(), hkey: sig.hkey, _time: String(sig._time), nonce: sig.nonce, ...(extraParams || {}) };
        return `${API_BASE}${path}?${Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
    }

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

    async getPostTree(linkId: string, offset: number = 0, limit: number = 0, sortFilter?: string): Promise<PostTreeResult> {
        const p: Record<string, string> = { link_id: linkId, offset: String(offset) };
        if (limit > 0) p.limit = String(limit);
        if (sortFilter) p.sort_filter = sortFilter;
        return this.get<PostTreeResult>("/bbs/app/link/tree", p);
    }

    async searchPosts(query: string, page: number = 1, limit: number = 20): Promise<SearchResult> {
        return this.get<SearchResult>("/bbs/app/api/general/search/v1/web", { q: query, search_type: "link", page: String(page), limit: String(limit) });
    }

    async getTopicFeeds(topicId: number, offset: number = 0, limit: number = 30): Promise<{ links: SearchItemInfo[]; lastval: string }> {
        return this.get<{ links: SearchItemInfo[]; lastval: string }>("/bbs/app/topic/feeds", { topic_id: String(topicId), offset: String(offset), limit: String(limit) });
    }

    async getFeed(offset: number = 0, pull: string = "0"): Promise<{ links: SearchItemInfo[] }> {
        return this.get<{ links: SearchItemInfo[] }>("/bbs/app/feeds", { offset: String(offset), pull, dw: "800" });
    }

    async getTopicCategories(): Promise<TopicCategoryResult> {
        return this.get<TopicCategoryResult>("/bbs/app/topic/categories");
    }

    private buildHeaders(): Record<string, string> {
        return {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "*/*", "Accept-Language": "zh-CN,zh;q=0.9",
            Referer: REFERER, Origin: "https://www.xiaoheihe.cn",
            Cookie: this.cookie,
        };
    }

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

    async favouritePost(linkId: string): Promise<void> {
        await this.post("/bbs/app/link/favour", { link_id: linkId }, { link_id: linkId });
    }

    async signDaily(): Promise<{ ok: boolean; message: string; state?: string }> {
        const signResp = await this.getRaw("/task/sign_v3/sign");
        const firstState = (signResp.result as any)?.state as string | undefined;
        if (firstState === "ignore") return { ok: true, message: "今日已签到", state: "ignore" };

        await new Promise(r => setTimeout(r, 800));

        const stateResp = await this.getRaw("/task/sign_v3/get_sign_state");
        const result = (stateResp.result || {}) as Record<string, any>;
        const state = typeof result.state === "string" ? result.state : "";

        if ((stateResp.status === "ok" && state === "ok") || state === "ignore") {
            const parts: string[] = [];
            if (result.sign_in_coin) parts.push(`+${result.sign_in_coin}H币`);
            if (result.sign_in_exp) parts.push(`+${result.sign_in_exp}经验`);
            if (result.sign_in_streak) parts.push(`连签${result.sign_in_streak}天`);
            return { ok: true, message: parts.length ? parts.join(" ") : "签到完成", state };
        }
        return { ok: false, message: (typeof stateResp.msg === "string" ? stateResp.msg : "") || state || "签到失败" };
    }

    async getTaskList(): Promise<SignTaskListResult> {
        return this.get<SignTaskListResult>("/task/list_v2/");
    }

    async getMessages(listType: number = 0, offset: number = 0, limit: number = 20): Promise<MessageListResult> {
        return this.get<MessageListResult>("/bbs/app/user/message", {
            list_type: String(listType),
            offset: String(offset),
            limit: String(limit),
            no_more: "false",
        });
    }

    /**
     * 设置并保存 Cookie（仅存储到 SecretStorage，不写入明文 settings）
     */
    async setCookie(cookie: string): Promise<void> {
        this.cookie = cookie;
        await this.context.secrets.store("heybox.cookie", cookie);

        // 提取 heybox_id 并更新配置
        if (!this.heyboxId && cookie) {
            const m = cookie.match(/heybox_id=(\d+)/);
            if (m) {
                this.heyboxId = m[1];
                const config = vscode.workspace.getConfiguration("heybox");
                await config.update("heyboxId", this.heyboxId, vscode.ConfigurationTarget.Global);
            }
        }
    }

    /**
     * 验证 Cookie 是否有效（格式检查）
     */
    validateCookie(cookie: string): boolean {
        if (!cookie || typeof cookie !== 'string') return false;
        const trimmed = cookie.trim();
        if (trimmed.length === 0) return false;

        return trimmed.includes('heybox_id=') ||
               trimmed.includes('x_xhh_tokenid=') ||
               trimmed.includes('user_pkey=');
    }

    /**
     * 清除已存储的 Cookie
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
     */
    getCookie(): string {
        return this.cookie;
    }

    /**
     * 获取扩展上下文
     */
    getContext(): vscode.ExtensionContext {
        return this.context;
    }
}