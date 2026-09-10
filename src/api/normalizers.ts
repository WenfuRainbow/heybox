import {
    CommunityBannerResult, CommunitySummary, FavouriteFolder, SearchItemInfo,
    SearchSuggestion, SearchWelcomeResult, UserPermission,
} from "../types";

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function firstValue(record: JsonObject, keys: string[]): unknown {
    for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
    return undefined;
}

function asArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    const record = objectValue(value);
    if (!record) return [];
    return asArray(firstValue(record, ["items", "list", "data", "children", "topics", "links", "folders"]));
}

function boolValue(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    return ["1", "true", "yes", "allow", "allowed"].includes(String(value ?? "").toLowerCase());
}

function community(value: unknown, followed: boolean): CommunitySummary | undefined {
    const outer = objectValue(value);
    const record = objectValue(outer?.topic) || objectValue(outer?.info) || outer;
    if (!record) return undefined;
    const id = Number(firstValue(record, ["topic_id", "topicid", "id"]));
    const name = String(firstValue(record, ["name", "title", "topic_name"]) ?? "").trim();
    if (!Number.isFinite(id) || id <= 0 || !name) return undefined;
    return {
        topic_id: id,
        name,
        pic_url: String(firstValue(record, ["small_pic_url", "pic_url", "icon", "avatar"]) ?? "") || undefined,
        description: String(firstValue(record, ["description", "desc", "subtitle"]) ?? "") || undefined,
        followed,
    };
}

function keyedArrays(raw: unknown, keys: string[]): unknown[] {
    if (Array.isArray(raw)) return raw;
    const root = objectValue(raw);
    if (!root) return [];
    for (const key of keys) {
        const values = asArray(root[key]);
        if (values.length) return values;
    }
    for (const container of ["result", "data", "banner", "topic_banner"]) {
        const nested = objectValue(root[container]);
        if (nested) {
            const values = keyedArrays(nested, keys);
            if (values.length) return values;
        }
    }
    return [];
}

export function normalizeCommunityBanner(raw: unknown): CommunityBannerResult {
    const followed = keyedArrays(raw, ["followed", "follow_topics", "follow_topic", "follow_list", "my_topics"])
        .map((item) => community(item, true)).filter((item): item is CommunitySummary => !!item);
    const popular = keyedArrays(raw, ["popular", "hot_topics", "hot_topic", "recommend_topics", "recommend", "topics"])
        .map((item) => community(item, false)).filter((item): item is CommunitySummary => !!item);
    return { followed: uniqueBy(followed, (item) => String(item.topic_id)), popular: uniqueBy(popular, (item) => String(item.topic_id)) };
}

function suggestion(value: unknown, index: number): SearchSuggestion | undefined {
    if (typeof value === "string") return value.trim() ? { text: value.trim(), rank: index + 1 } : undefined;
    const record = objectValue(value);
    if (!record) return undefined;
    const text = String(firstValue(record, ["text", "keyword", "word", "title", "name", "q"]) ?? "").trim();
    if (!text) return undefined;
    const rawRank = Number(firstValue(record, ["rank", "index", "sort"]));
    return {
        text,
        rank: Number.isFinite(rawRank) ? rawRank : index + 1,
        hot: String(firstValue(record, ["hot", "hot_value", "desc", "heat"]) ?? "") || undefined,
    };
}

export function normalizeSearchWelcome(raw: unknown): SearchWelcomeResult {
    const hot = keyedArrays(raw, ["hot", "hot_search", "hot_searches", "hot_words", "trending", "rank_list"])
        .map(suggestion).filter((item): item is SearchSuggestion => !!item);
    const suggestions = keyedArrays(raw, ["suggestions", "suggest", "recommend", "recommend_words", "default_words"])
        .map(suggestion).filter((item): item is SearchSuggestion => !!item);
    return { hot: uniqueBy(hot, (item) => item.text), suggestions: uniqueBy(suggestions, (item) => item.text) };
}

export function normalizeFavouriteFolders(raw: unknown): FavouriteFolder[] {
    const values = keyedArrays(raw, ["folders", "folder_list", "list", "items"]);
    const folders: FavouriteFolder[] = [];
    for (const value of values) {
        const outer = objectValue(value);
        const record = objectValue(outer?.folder) || outer;
        if (!record) continue;
        const id = String(firstValue(record, ["folder_id", "folderid", "id"]) ?? "").trim();
        const name = String(firstValue(record, ["name", "folder_name", "title"]) ?? "").trim();
        if (!id || !name) continue;
        const count = Number(firstValue(record, ["count", "link_count", "total"]));
        folders.push({
            folder_id: id,
            name,
            count: Number.isFinite(count) ? count : undefined,
            is_default: boolValue(firstValue(record, ["is_default", "default", "default_folder"])),
        });
    }
    return uniqueBy(folders, (item) => item.folder_id);
}

export function normalizePermission(raw: unknown): UserPermission {
    const root = objectValue(raw) || {};
    const record = objectValue(root.permission) || objectValue(root.permissions) || root;
    const allowed = (...keys: string[]) => boolValue(firstValue(record, keys));
    return {
        can_comment: allowed("can_comment", "comment", "allow_comment", "comment_permission"),
        can_delete: allowed("can_delete", "delete", "allow_delete", "delete_permission"),
        can_award: allowed("can_award", "award", "can_reward", "reward", "allow_award"),
    };
}

function post(value: unknown): SearchItemInfo | undefined {
    const outer = objectValue(value);
    const record = objectValue(outer?.info) || objectValue(outer?.link) || outer;
    if (!record) return undefined;
    const linkid = Number(firstValue(record, ["linkid", "link_id", "id"]));
    if (!Number.isFinite(linkid) || linkid <= 0) return undefined;
    return { ...record, linkid } as unknown as SearchItemInfo;
}

/** 兼容 links、items(info) 和收藏接口的 items(link) 三种帖子列表包装。 */
export function normalizePostList(raw: unknown): SearchItemInfo[] {
    const values = keyedArrays(raw, ["links", "items", "list", "data"]);
    return uniqueBy(values.map(post).filter((item): item is SearchItemInfo => !!item), (item) => String(item.linkid));
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        const value = key(item);
        if (seen.has(value)) return false;
        seen.add(value);
        return true;
    });
}
