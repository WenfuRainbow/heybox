/** 服务端已读状态归一化结果；未知状态不能默认视为未读。 */
export type ReadState = "unread" | "read" | "unknown";

export interface ReadStateFields {
    is_read?: string | number | boolean;
    has_read?: string | number | boolean;
    is_unread?: string | number | boolean;
    unread?: string | number | boolean;
    read_status?: string | number | boolean;
}

function valueOf(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
}

function booleanState(value: unknown): boolean | undefined {
    const valueText = valueOf(value);
    if (["1", "true", "yes", "unread"].includes(valueText)) return true;
    if (["0", "false", "no", "read"].includes(valueText)) return false;
    return undefined;
}

/**
 * 服务端同时使用正向（is_unread）和反向（is_read）字段。
 * 只有可识别的值才具有确定含义；格式错误或冲突的未知值保持 unknown，
 * 避免错误地显示未读标记。
 */
export function getReadState(message: ReadStateFields): ReadState {
    for (const field of [message.is_unread, message.unread]) {
        if (field === undefined) continue;
        const state = booleanState(field);
        if (state !== undefined) return state ? "unread" : "read";
    }
    for (const field of [message.is_read, message.has_read]) {
        if (field === undefined) continue;
        const state = booleanState(field);
        if (state !== undefined) return state ? "read" : "unread";
    }
    if (message.read_status !== undefined) {
        const text = valueOf(message.read_status);
        if (text === "unread") return "unread";
        if (text === "read") return "read";
        const state = booleanState(message.read_status);
        if (state !== undefined) return state ? "read" : "unread";
    }
    return "unknown";
}

export function isUnread(message: ReadStateFields): boolean {
    return getReadState(message) === "unread";
}

/** 统一常见的布尔、数字和字符串分页字段，不对未知值猜测。 */
export function hasNextPage(value: unknown): boolean | undefined {
    const state = booleanState(value);
    return state;
}
