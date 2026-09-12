import assert from "node:assert/strict";
import test from "node:test";
import { validatePostTree } from "../contracts";
import { HeyBoxApiError } from "../errors";

const validTree = {
    link: { linkid: 42, user: { username: "示例用户" } },
    comments: [],
    has_more_floors: 0,
};

test("帖子详情契约接受渲染所需字段", () => {
    assert.equal(validatePostTree(validTree).link.linkid, 42);
});

test("帖子详情缺少作者信息时在 API 边界失败", () => {
    assert.throws(
        () => validatePostTree({ link: { linkid: 42 }, comments: [] }),
        (error: unknown) => error instanceof HeyBoxApiError && error.kind === "response" && /link.user/.test(error.message),
    );
});
