import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeRichTextHtml } from "../sanitizeRichText";

const imageKey = (url: string) => new URL(url).pathname.split("/").at(-1) || "";

test("富文本解析器会删除脚本、事件属性和危险链接", () => {
    const keys = new Set<string>();
    const result = sanitizeRichTextHtml('<p onclick="alert(1)">安全<script>alert(1)</script><img src="https://cdn.example/a.png" onerror="alert(1)"><a href="javascript:alert(1)">链接</a></p>', keys, imageKey);
    assert.equal(result, '<p>安全<img src="https://cdn.example/a.png" alt="帖子图片" loading="lazy" />链接</p>');
    assert.deepEqual([...keys], ["a.png"]);
});
