import { parseFragment } from "parse5";

interface ParsedNode {
    nodeName: string;
    tagName?: string;
    value?: string;
    attrs?: Array<{ name: string; value: string }>;
    childNodes?: ParsedNode[];
}

const CONTENT_TAGS = new Set(["p", "br", "div", "span", "strong", "b", "em", "i", "u", "ol", "ul", "li", "blockquote", "img", "a"]);
const DISCARD_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "form", "template"]);

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function attribute(node: ParsedNode, name: string): string {
    return node.attrs?.find((item) => item.name.toLowerCase() === name)?.value || "";
}

function isImageUrl(value: string): boolean {
    return /^https?:\/\//i.test(value) || /^data:image\/(?:png|jpe?g|gif|webp);/i.test(value);
}

function isHttpUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
}

function renderNodes(nodes: ParsedNode[], embeddedImageKeys: Set<string>, imageKey: (url: string) => string): string {
    return nodes.map((node) => {
        if (node.nodeName === "#text") return escapeHtml(node.value || "");
        if (node.nodeName === "#comment") return "";

        const tag = node.tagName?.toLowerCase();
        if (!tag) return "";
        if (DISCARD_WITH_CONTENT.has(tag)) return "";

        const children = renderNodes(node.childNodes || [], embeddedImageKeys, imageKey);
        if (!CONTENT_TAGS.has(tag)) return children;
        if (tag === "br") return "<br>";
        if (tag === "img") {
            const src = attribute(node, "data-original") || attribute(node, "data-src") || attribute(node, "src");
            if (!isImageUrl(src)) return "";
            const key = imageKey(src);
            if (key) embeddedImageKeys.add(key);
            return `<img src="${escapeHtml(src)}" alt="${escapeHtml(attribute(node, "alt") || "帖子图片")}" loading="lazy" />`;
        }
        if (tag === "a") {
            const href = attribute(node, "href");
            return isHttpUrl(href)
                ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${children}</a>`
                : children;
        }
        return `<${tag}>${children}</${tag}>`;
    }).join("");
}

/** 使用 HTML 解析器构建受限输出，而非通过正则修改不可信 HTML。 */
export function sanitizeRichTextHtml(value: unknown, embeddedImageKeys: Set<string>, imageKey: (url: string) => string): string {
    if (typeof value !== "string" || !value) return "";
    const fragment = parseFragment(value) as unknown as { childNodes: ParsedNode[] };
    return renderNodes(fragment.childNodes || [], embeddedImageKeys, imageKey);
}
