import assert from "node:assert/strict";
import test from "node:test";
import {
    normalizeCommunityBanner, normalizeFavouriteFolders, normalizePermission,
    normalizePostList, normalizeSearchWelcome,
} from "../normalizers";

test("社区横幅兼容嵌套 topic，并去重", () => {
    const result = normalizeCommunityBanner({
        follow_topics: [{ topic: { topic_id: 1, name: "已关注" } }, { topic_id: 1, name: "重复" }],
        hot_topics: [{ topic_id: 2, name: "热门", small_pic_url: "https://example.invalid/2.png" }],
    });
    assert.deepEqual(result.followed.map((item) => item.topic_id), [1]);
    assert.equal(result.popular[0].name, "热门");
});

test("搜索欢迎页统一字符串与对象建议", () => {
    const result = normalizeSearchWelcome({ hot_search: ["词一", { keyword: "词二", hot_value: "12万" }] });
    assert.deepEqual(result.hot.map((item) => item.text), ["词一", "词二"]);
    assert.equal(result.hot[1].hot, "12万");
});

test("收藏夹、权限和帖子包装被转换为稳定模型", () => {
    assert.deepEqual(normalizeFavouriteFolders({ folder_list: [
        { folder_id: 8, folder_name: "稍后读", link_count: 3, is_default: 1 },
    ] }), [{ folder_id: "8", name: "稍后读", count: 3, is_default: true }]);
    assert.deepEqual(normalizePermission({ permissions: { comment: 1, delete: 0, reward: true } }), {
        can_comment: true, can_delete: false, can_award: true,
    });
    assert.deepEqual(normalizePostList({ items: [
        { info: { linkid: 11, title: "A" } },
        { link: { link_id: 12, title: "B" } },
        { info: { linkid: 11, title: "重复" } },
    ] }).map((item) => Number(item.linkid)), [11, 12]);
});
