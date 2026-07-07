import * as vscode from "vscode";
import * as https from "https";
import { generateSignature, Signature } from "./signature";
import {
    ApiResponse, PostTreeResult, SearchResult, TopicCategoryResult, SearchItemInfo,
} from "../types";

const API_BASE = "https://api.xiaoheihe.cn";
const REFERER = "https://www.xiaoheihe.cn/";

export class HeyBoxClient {
    private cookie: string = "";
    private deviceId: string = "";
    private heyboxId: string = "";

    constructor(private context: vscode.ExtensionContext) { this.loadConfig(); }

    loadConfig(): void {
        const config = vscode.workspace.getConfiguration("heybox");
        this.cookie = config.get<string>("cookie", "");
        this.heyboxId = config.get<string>("heyboxId", "");
        if (this.cookie) { try { this.context.secrets.store("heybox.cookie", this.cookie); } catch {} }
        this.refreshCookie();

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

    private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
        if (!this.cookie) throw new Error("请先配置 Cookie：打开设置搜索 heybox.cookie，粘贴 Cookie 值");
        const url = this.buildUrl(path, params);
        const headers: Record<string, string> = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "*/*", "Accept-Language": "zh-CN,zh;q=0.9",
            Referer: REFERER, Origin: "https://www.xiaoheihe.cn",
            Cookie: this.cookie,
        };
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
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Accept: "*/*", "Accept-Language": "zh-CN,zh;q=0.9",
            Referer: REFERER, Origin: "https://www.xiaoheihe.cn",
            Cookie: this.cookie,
        };
    }

    async post<T>(path: string, body: Record<string, string>, params?: Record<string, string>): Promise<T> {
        if (!this.cookie) throw new Error("请先配置 Cookie");
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
}