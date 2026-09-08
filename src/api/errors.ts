import type { ApiResponse } from "../types";

/** 可展示给用户、同时供请求重试策略判断的 API 错误类型。 */
export type ApiErrorKind = "authentication" | "captcha" | "rate_limit" | "server" | "timeout" | "network" | "response" | "api";

export class HeyBoxApiError extends Error {
    constructor(
        public readonly kind: ApiErrorKind,
        message: string,
        public readonly retryable: boolean = false,
        public readonly status?: string,
    ) {
        super(message);
        this.name = "HeyBoxApiError";
    }
}

/** API 成功响应的最小契约；避免把 HTML 或代理错误页误当成业务数据。 */
export function unwrapApiResponse<T>(value: unknown): T {
    if (!value || typeof value !== "object") {
        throw new HeyBoxApiError("response", "服务端返回了无法识别的响应，请稍后重试");
    }

    const response = value as Partial<ApiResponse<T>>;
    if (typeof response.status !== "string") {
        throw new HeyBoxApiError("response", "服务端响应缺少状态字段，请稍后重试");
    }
    if (response.status === "ok") return response.result as T;
    throw apiErrorFromStatus(response.status, typeof response.msg === "string" ? response.msg : "");
}

/** 将小黑盒业务状态转换为明确的用户提示。 */
export function apiErrorFromStatus(statusValue: unknown, message = ""): HeyBoxApiError {
    const status = String(statusValue || "unknown").trim().toLowerCase();
    const detail = message.trim();
    if (status === "login" || status === "relogin") {
        return new HeyBoxApiError(
            "authentication",
            `登录状态已失效（${status}），Cookie 已过期，请重新扫码登录`,
            false,
            status,
        );
    }
    if (status === "show_captcha") {
        return new HeyBoxApiError(
            "captcha",
            "服务端要求人机验证（show_captcha），请在浏览器完成验证后重新扫码登录",
            false,
            status,
        );
    }
    if (status === "rate_limit" || status === "too_many_requests" || status === "429") {
        return new HeyBoxApiError("rate_limit", "请求过于频繁，已自动退避，请稍后重试", true, status);
    }
    if (status === "server_error" || status === "system_busy" || status === "service_unavailable") {
        return new HeyBoxApiError("server", "小黑盒服务暂时异常，已自动重试；请稍后再试", true, status);
    }
    return new HeyBoxApiError("api", detail || `API 请求失败：${status}`, false, status);
}

/** HTTP 层错误与业务响应统一成同一套可读错误。 */
export function apiErrorFromHttpStatus(statusCode: number): HeyBoxApiError {
    if (statusCode === 429) {
        return new HeyBoxApiError("rate_limit", "请求过于频繁，已自动退避，请稍后重试", true, "429");
    }
    if (statusCode >= 500) {
        return new HeyBoxApiError("server", `小黑盒服务暂时异常（HTTP ${statusCode}），已自动重试；请稍后再试`, true, String(statusCode));
    }
    return new HeyBoxApiError("response", `服务器拒绝了请求（HTTP ${statusCode}），请检查登录状态或稍后重试`, false, String(statusCode));
}

export function isRetryableRequestError(error: unknown): boolean {
    if (error instanceof HeyBoxApiError) return error.retryable;
    const code = typeof error === "object" && error ? String((error as { code?: unknown }).code || "") : "";
    return ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"].includes(code);
}

/** 兼容旧调用方抛出的普通 Error，并让轮询能统一停止失效会话。 */
export function isAuthenticationError(error: unknown): boolean {
    if (error instanceof HeyBoxApiError) return error.kind === "authentication";
    return error instanceof Error && (/Cookie/.test(error.message) || /登录状态.*失效/.test(error.message));
}

export function isCaptchaError(error: unknown): boolean {
    return error instanceof HeyBoxApiError
        ? error.kind === "captcha"
        : error instanceof Error && error.message.includes("show_captcha");
}
