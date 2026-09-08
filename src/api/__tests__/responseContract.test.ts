import assert from "node:assert/strict";
import test from "node:test";
import { HeyBoxApiError, unwrapApiResponse } from "../errors";
import { apiResponseFixtures } from "./fixtures/apiResponses.fixture";

test("成功响应的本地 fixture 符合 API 契约", () => {
    const result = unwrapApiResponse<{ links: Array<{ linkid: number; title: string }> }>(apiResponseFixtures.success);
    assert.deepEqual(result, apiResponseFixtures.success.result);
});

for (const [name, fixture, kind] of [
    ["login", apiResponseFixtures.login, "authentication"],
    ["relogin", apiResponseFixtures.relogin, "authentication"],
    ["show_captcha", apiResponseFixtures.captcha, "captcha"],
] as const) {
    test(`${name} 响应会产生明确的登录/验证提示`, () => {
        assert.throws(
            () => unwrapApiResponse(fixture),
            (error: unknown) => {
                if (!(error instanceof HeyBoxApiError) || error.kind !== kind) return false;
                assert.match(error.message, kind === "authentication" ? /Cookie.*重新扫码登录/ : /人机验证.*show_captcha/);
                return true;
            },
        );
    });
}

test("服务繁忙响应标记为可退避重试", () => {
    assert.throws(
        () => unwrapApiResponse(apiResponseFixtures.serverBusy),
        (error: unknown) => error instanceof HeyBoxApiError && error.kind === "server" && error.retryable,
    );
});

test("非 API JSON 不会被当作有效响应", () => {
    assert.throws(() => unwrapApiResponse({ message: "gateway page" }), HeyBoxApiError);
});
