import { HeyBoxApiError } from "./errors";
import type { MessageListResult, PostTreeResult, SearchItemInfo, SearchResult } from "../types";

type RecordValue = Record<string, unknown>;

function fail(endpoint: string, field: string): never {
    throw new HeyBoxApiError("response", `${endpoint}响应缺少或包含无效字段：${field}`);
}

function record(value: unknown, endpoint: string, field: string): RecordValue {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(endpoint, field);
    return value as RecordValue;
}

function array(value: unknown, endpoint: string, field: string): unknown[] {
    if (!Array.isArray(value)) fail(endpoint, field);
    return value;
}

function linkId(value: unknown): boolean {
    return (typeof value === "number" && Number.isFinite(value))
        || (typeof value === "string" && value.trim().length > 0);
}

/** 帖子详情会直接读取 link.user；在边界处拒绝不完整数据以避免渲染时崩溃。 */
export function validatePostTree(value: unknown): PostTreeResult {
    const endpoint = "帖子详情";
    const result = record(value, endpoint, "result");
    const link = record(result.link, endpoint, "link");
    if (!linkId(link.linkid)) fail(endpoint, "link.linkid");
    const user = record(link.user, endpoint, "link.user");
    if (typeof user.username !== "string") fail(endpoint, "link.user.username");
    if (result.comments !== undefined) array(result.comments, endpoint, "comments");
    return value as PostTreeResult;
}

export function validateSearchResult(value: unknown): SearchResult {
    const result = record(value, "搜索结果", "result");
    array(result.items, "搜索结果", "items");
    return value as SearchResult;
}

export function validateLinksResult(value: unknown, endpoint: string): { links: SearchItemInfo[] } {
    const result = record(value, endpoint, "result");
    array(result.links, endpoint, "links");
    return value as { links: SearchItemInfo[] };
}

export function validateMessageList(value: unknown): MessageListResult {
    const result = record(value, "互动消息", "result");
    array(result.messages, "互动消息", "messages");
    return value as MessageListResult;
}
