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

    /**
     * 构建完整的 API URL
     * 将路径、签名和额外参数组合成完整的请求 URL
     * @param path API 路径
     * @param extraParams 额外的查询参数
     * @returns 完整的 URL 字符串
     */
    private buildUrl(path: string, extraParams?: Record<string, string>): string {
        const sig: Signature = generateSignature(path);
        const params = { ...this.getCommonParams(), hkey: sig.hkey, _time: String(sig._time), nonce: sig.nonce, ...(extraParams || {}) };
        return `${API_BASE}${path}?${Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
    }

    /**
     * 构建 HTTP 请求头
     * 包含浏览器模拟信息、Cookie 和必要的请求头
     * @returns 请求头对象
     */
    private buildHeaders(): Record<string, string> {
        return {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "*/*", "Accept-Language": "zh-CN,zh;q=0.9",
            Referer: REFERER, Origin: "https://www.xiaoheihe.cn",
            Cookie: this.cookie,
        };
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

    /**
     * 设置并保存 Cookie（仅存储到 SecretStorage，不写入明文 settings）
     * 同时从 cookie 中提取 heybox_id 并更新配置
     * @param cookie 要保存的 cookie 字符串
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
     * 检查 cookie 是否包含必要的认证字段
     * @param cookie 要验证的 cookie 字符串
     * @returns 是否有效
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
