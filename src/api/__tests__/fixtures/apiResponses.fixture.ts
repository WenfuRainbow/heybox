/**
 * 已脱敏的 API 响应样本：仅保留契约所需字段，绝不包含 Cookie、用户 ID、昵称或真实帖子内容。
 * 测试必须只使用此类本地 fixture，不能访问线上账号。
 */
export const apiResponseFixtures = {
    success: {
        status: "ok",
        msg: "",
        result: { links: [{ linkid: 101, title: "示例帖子" }] },
    },
    login: { status: "login", msg: "", result: null },
    relogin: { status: "relogin", msg: "", result: null },
    captcha: { status: "show_captcha", msg: "verification required", result: null },
    serverBusy: { status: "system_busy", msg: "", result: null },
} as const;
