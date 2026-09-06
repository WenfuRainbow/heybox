import * as vscode from "vscode";
import { PostTreeResult, Comment } from "../types";

/**
 * 根据用户配置的主题偏好返回 CSS 变量覆盖字符串
 * "auto" 模式下返回空串，由 VSCode 主题的 CSS 变量接管
 */
function getThemeOverrides(): string {
    const theme = vscode.workspace.getConfiguration("heybox").get<string>("theme", "auto");
    if (theme === "dark") {
        return `--bg:#1e1e1e;--fg:#d4d4d4;--dim:#9d9d9d;--border:#333;--badge-bg:#4d4d4d;--badge-fg:#fff;--input-bg:#3c3c3c`;
    } else if (theme === "light") {
        return `--bg:#ffffff;--fg:#1e1e1e;--dim:#616161;--border:#e0e0e0;--badge-bg:#e0e0e0;--badge-fg:#333;--input-bg:#f3f3f3`;
    }
    return "";
}

/** 将 Unix 时间戳转换为"刚刚"、"X分钟前"等相对时间文案 */
function formatTs(ts: number): string {
    if (!ts) return "";
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;

    const now = new Date();
    const date = new Date(ts * 1000);
    const dayDiff = Math.floor(diff / 86400);

    if (dayDiff < 7) return `${dayDiff}天前`;
    if (dayDiff < 30) return `${Math.floor(dayDiff / 7)}周前`;

    const monthDiff = (now.getFullYear() - date.getFullYear()) * 12 + (now.getMonth() - date.getMonth());
    if (monthDiff < 12) return `${monthDiff}个月前`;

    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** HTML 实体转义，防止 XSS 注入 */
function escHtml(value: unknown): string {
    if (value === null || value === undefined) return "";
    const s = String(value);
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

/** 用图片文件名识别 HTML 定位图与数组末尾的缩略图副本。 */
function imageKey(url: string): string {
    try {
        const pathname = new URL(url).pathname;
        return pathname.substring(pathname.lastIndexOf("/") + 1).toLowerCase();
    } catch {
        return url.split("?")[0].substring(url.lastIndexOf("/") + 1).toLowerCase();
    }
}

function readHtmlAttribute(attrs: string, name: string): string {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = attrs.match(new RegExp(`\\b${escapedName}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`, "i"));
    return match?.[1] || match?.[2] || "";
}

/** 清洗富文本 HTML，同时恢复 data-original/data-src 中的正文定位图片。 */
function renderHtmlBlock(value: unknown, embeddedImageKeys: Set<string>): string {
    if (typeof value !== "string" || !value) return "";
    return value
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<(script|style|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
        .replace(/<([a-z][a-z0-9]*)\b([^>]*)>/gi, (_full, tag: string, attrs: string) => {
            const name = tag.toLowerCase();
            if (!["p", "br", "div", "span", "strong", "b", "em", "i", "u", "ol", "ul", "li", "blockquote", "img", "a"].includes(name)) return "";
            if (name === "br") return "<br>";
            if (name === "img") {
                const src = readHtmlAttribute(attrs, "data-original")
                    || readHtmlAttribute(attrs, "data-src")
                    || readHtmlAttribute(attrs, "src");
                if (!/^https?:\/\//i.test(src) && !/^data:image\//i.test(src)) return "";
                const key = imageKey(src);
                if (key) embeddedImageKeys.add(key);
                const alt = readHtmlAttribute(attrs, "alt") || "帖子图片";
                return `<img src="${escHtml(src)}" alt="${escHtml(alt)}" loading="lazy" />`;
            }
            if (name === "a") {
                const href = readHtmlAttribute(attrs, "href");
                return /^https?:\/\//i.test(href) ? `<a href="${escHtml(href)}">` : "";
            }
            return `<${name}>`;
        })
        .replace(/<\/([a-z][a-z0-9]*)\s*>/gi, (_full, tag: string) => {
            const name = tag.toLowerCase();
            return ["p", "div", "span", "strong", "b", "em", "i", "u", "ol", "ul", "li", "blockquote", "a"].includes(name)
                ? `</${name}>`
                : "";
        });
}

/**
 * 渲染帖子正文内容
 * 富文本 HTML 自带图片的原始位置；数组末尾重复的图片块会被过滤。
 */
function renderContent(text: string): string {
    if (!text) return "";
    try {
        const blocks = JSON.parse(text);
        if (Array.isArray(blocks)) {
            type ContentBlock = { type?: string; url?: string; text?: string; content?: string; html?: string };
            const embeddedImageKeys = new Set<string>();
            const renderedHtml = new Map<number, string>();

            (blocks as ContentBlock[]).forEach((block, index) => {
                if (String(block.type || "").toLowerCase() === "html") {
                    renderedHtml.set(index, renderHtmlBlock(block.html || block.text || block.content || "", embeddedImageKeys));
                }
            });

            return (blocks as ContentBlock[]).map((b, index) => {
                const type = String(b.type || "").toLowerCase();
                const url = b.url || (typeof b.content === "string" && /^https?:\/\//i.test(b.content) ? b.content : "");
                if (["img", "image", "picture", "pic"].includes(type) && url) {
                    return embeddedImageKeys.has(imageKey(url)) ? "" : `<img src="${escHtml(url)}" alt="帖子图片" loading="lazy" />`;
                }
                if (["text", "txt"].includes(type) && (b.text || b.content)) return `<p>${escHtml(b.text || b.content)}</p>`;
                if (type === "html") return renderedHtml.get(index) || "";
                return "";
            }).join("");
        }
    } catch { /* not JSON */ }
    return `<p>${escHtml(text)}</p>`;
}

/** 将单条评论渲染为 HTML article 元素，sub 表示是否为子评论（回复） */
function renderCommentHtml(c: Comment, sub: boolean, stealth: boolean): string {
    const level = c.user.level_info?.status === 1 ? `Lv.${c.user.level_info.level}` : "";
    const replyto = c.replyuser ? `<span class="rpl">${escHtml(c.replyuser.username)}</span>` : "";
    const imgs = (c.imgs || []).map((i) => `<img class="cimg" src="${escHtml(i.url)}" alt="评论图片" loading="lazy" />`).join("");
    const avatar = (!c.user.avatar || stealth) ? "" : `<img class="cava" src="${escHtml(c.user.avatar)}" alt="${escHtml(c.user.username)} 的头像" onerror="this.style.display='none'" />`;
    return `<article class="cm${sub ? " sub" : ""}" aria-label="${escHtml(c.user.username)} 的评论">${avatar}<div class="cbd"><div class="chd">${escHtml(c.user.username)} ${level ? `<span class="clv">${level}</span>` : ""} <span class="flr">#${c.floor_num}</span> ${replyto}</div><div class="cmeta">${formatTs(c.create_at)}${c.ip_location ? ` · ${escHtml(c.ip_location)}` : ""}${!stealth ? ` · 👍${c.up}` : ""}</div><div class="ct">${escHtml(c.text || "")}</div>${imgs}</div></article>`;
}

/**
 * 生成帖子详情的完整 HTML 页面
 *
 * 页面结构：
 *   <head>  — CSP 安全策略 + CSS 样式（基于 VSCode 主题变量）
 *   <body>
 *     .ctrl — 图片缩放滑块（通过 CSS 变量 --scale 控制图片最大宽度）
 *     <main>
 *       <article>  — 帖子标题、作者信息、话题标签、正文
 *       <section>  — 评论区：评论组（主评论 + 子评论）
 *     </main>
 *   <script> — 图片缩放逻辑 + 鼠标悬停大图预览
 *
 * @param postTree 帖子完整数据（正文 + 评论组）
 * @param stealth 隐身模式：隐藏头像、点赞数，面板标题伪装为 README.md
 * @param commentNote 评论区底部备注
 * @param foldedTips 被折叠评论的提示文案
 * @returns 完整的 HTML 字符串
 */
export function postHtml(postTree: PostTreeResult, stealth: boolean, commentNote?: string, foldedTips?: string): string {
    const link = postTree.link;
    const user = link.user;
    const level = user.level_info?.status === 1 ? `Lv.${user.level_info.level}` : "";
    const tags = (link.topics || []).map((t) => escHtml(t.name)).join(" · ");
    const commentCount = link.comment_num || 0;
    const contentHtml = renderContent(link.text || link.description || "");

    const commentGroups = postTree.comments || [];
    const commentsHtml = commentGroups.map((g) => {
        if (!g.comment || g.comment.length === 0) return "";
        const main = renderCommentHtml(g.comment[0], false, stealth);
        const root = g.comment[0];
        const replyCount = root.child_num;
        const loadedReplyCount = Math.max(g.comment.length - 1, 0);
        const subs = g.comment.slice(1).map((c) => renderCommentHtml(c, true, stealth)).join("");
        // 小黑盒接口并不总会返回回复总数字段。仍为每条主评论提供按需加载入口；
        // 有可靠计数时展示“全部 N 条回复”，否则使用不作数量承诺的“加载回复”。
        const hasMoreReplies = replyCount === undefined || loadedReplyCount < replyCount;
        const moreLabel = replyCount !== undefined
            ? `全部 ${replyCount} 条回复`
            : "加载回复";
        const more = hasMoreReplies
            ? `<button class="loadReplies" data-root="${escHtml(root.commentid)}">${moreLabel}</button>`
            : "";
        return `<section class="cg" aria-label="评论组">${main}${subs}${more}</section>`;
    }).join("");

    const themeOverrides = getThemeOverrides();
    const rootStyle = themeOverrides ? ` style="${themeOverrides}"` : "";

    return `<!DOCTYPE html>
<html lang="zh-CN"${rootStyle}>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
    :root{--bg:var(--vscode-editor-background,#1e1e1e);--fg:var(--vscode-editor-foreground,#d4d4d4);--dim:var(--vscode-descriptionForeground,#9d9d9d);--border:var(--vscode-panel-border,#333);--badge-bg:var(--vscode-badge-background,#4d4d4d);--badge-fg:var(--vscode-badge-foreground,#fff);--input-bg:var(--vscode-input-background,#3c3c3c);--font:var(--vscode-font-family);--fs:var(--vscode-font-size,13px);--scale:1}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{height:100%;overflow:hidden}
    body{font-family:var(--font);font-size:var(--fs);background:var(--bg);color:var(--fg);line-height:1.6;display:flex;flex-direction:column}
    .ctrl{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dim);padding:8px 24px;border-bottom:1px solid var(--border);background:var(--bg);flex-shrink:0}
    main{flex:1;overflow-y:auto;padding:16px 24px}
    .ctrl label{white-space:nowrap}
    .ctrl input{flex:1;max-width:160px;accent-color:var(--vscode-textLinkForeground,#3794ff);cursor:pointer}
    h1{font-size:22px;font-weight:700;margin-bottom:10px}
    .meta{font-size:12px;color:var(--dim);margin-bottom:6px}
    .tags{font-size:12px;color:var(--dim);margin-bottom:8px}
    .body{font-size:14px;margin-bottom:20px}
    .body p{margin:6px 0;white-space:pre-wrap}
    .body img,.cimg{max-width:calc(100%*var(--scale));border-radius:6px;margin:6px 0;display:block;transition:max-width .15s}
    .ch{font-size:16px;font-weight:600;padding-bottom:8px;border-bottom:1px solid var(--border);margin-bottom:14px}
    .cg{margin-bottom:14px}
    .cm{display:flex;gap:10px;padding:8px 0}
    .cm.sub{margin-left:46px}
    .cava{width:32px;height:32px;border-radius:50%;flex-shrink:0;background:var(--input-bg)}
    .cbd{flex:1;min-width:0}
    .chd{font-weight:600;font-size:13px}
    .clv{font-size:11px;color:var(--dim);font-weight:400}
    .flr{display:inline-block;background:var(--badge-bg);color:var(--badge-fg);padding:1px 6px;border-radius:3px;font-size:11px}
    .rpl{font-size:12px;color:var(--dim)}.rpl::before{content:"↳ "}
    .ct{font-size:13px;margin:4px 0;white-space:pre-wrap;word-break:break-word}
    .cmeta{font-size:11px;color:var(--dim);display:flex;gap:8px}
    .loadReplies{margin-left:46px;padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--input-bg);color:var(--fg);font:inherit;font-size:12px;cursor:pointer}
    .loadReplies:hover{background:var(--badge-bg);color:var(--badge-fg)}
    .loadReplies:focus-visible{outline:1px solid var(--vscode-focusBorder,#3794ff);outline-offset:1px}
    .loadReplies:disabled{opacity:.65;cursor:wait}
    .ftr{text-align:center;font-size:12px;color:var(--dim);padding:16px 0 8px}
    .img-preview{position:fixed;z-index:9999;pointer-events:none;overflow:hidden;border:2px solid var(--border);border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,.4);display:none;background:var(--bg)}
    .img-preview img{display:block;border-radius:4px}
</style></head>
<body>
    <div class="ctrl"><label for="s">图片</label><input type="range" id="s" min="5" max="100" value="30" aria-label="图片缩放比例"/><span id="sl" aria-live="polite">30%</span></div>
    <main>
    <article>
    <h1>${escHtml(link.title || "无标题")}</h1>
    <div class="meta">${escHtml(user.username || "匿名")} ${level} · ${formatTs(link.create_at)}${link.ip_location ? ` · ${escHtml(link.ip_location)}` : ""}</div>
    ${tags ? `<div class="tags" aria-label="话题标签">${tags}</div>` : ""}
    <div class="body" role="article">${contentHtml}</div>
    </article>
    <section aria-label="评论区">
    <h2 class="ch">💬 评论 (${commentCount})</h2>
    ${commentsHtml || (foldedTips ? `<p style="color:var(--dim);font-size:12px">评论已被折叠: ${escHtml(foldedTips)}</p>` : '<p style="color:var(--dim);font-size:12px">暂无评论</p>')}
    ${commentNote ? `<div class="ftr" style="font-style:italic">${escHtml(commentNote)}</div>` : `<div class="ftr">${commentCount} 条评论${foldedTips ? '（已折叠）' : ''}</div>`}
    </section>
    </main>
<script>
(function(){
var s=document.getElementById('s'),l=document.getElementById('sl'),r=document.documentElement;
var v=localStorage.getItem('hb_img');if(v){s.value=v;r.style.setProperty('--scale',v/100);l.textContent=v+'%'}else l.textContent='30%';
s.addEventListener('input',function(){var v=this.value;r.style.setProperty('--scale',v/100);l.textContent=v+'%';localStorage.setItem('hb_img',v)});

var main=document.querySelector('main');
var savedScrollTop=sessionStorage.getItem('hb_scroll_top');
if(main&&savedScrollTop!==null){
  requestAnimationFrame(function(){main.scrollTop=Number(savedScrollTop);sessionStorage.removeItem('hb_scroll_top')});
}

var pv=document.createElement('div');pv.className='img-preview';var pi=document.createElement('img');pv.appendChild(pi);document.body.appendChild(pv);

function showPreview(cx, cy){
  var maxW = innerWidth - cx - 20;
  var maxH = innerHeight - 20;
  pi.style.maxWidth = maxW + 'px';
  pi.style.maxHeight = maxH + 'px';
  pv.style.display = 'block';
  var x = cx + 20;
  var y = Math.min(cy, innerHeight - pv.offsetHeight - 10);
  if(y < 0) y = 0;
  pv.style.left = x + 'px';
  pv.style.top = y + 'px';
}

document.addEventListener('mouseover',function(e){var t=e.target;if(t.tagName==='IMG'&&t.closest('.body img,.cimg')){pi.src=t.src;showPreview(e.clientX, e.clientY)}});
document.addEventListener('mouseout',function(e){if(e.target.tagName==='IMG'&&e.target.closest('.body img,.cimg'))pv.style.display='none'});
document.addEventListener('mousemove',function(e){if(pv.style.display==='block')showPreview(e.clientX, e.clientY)});
document.querySelectorAll('.loadReplies').forEach(function(b){b.addEventListener('click',function(){if(main)sessionStorage.setItem('hb_scroll_top',String(main.scrollTop));b.disabled=true;b.textContent='正在加载…';acquireVsCodeApi().postMessage({command:'loadReplies',linkId:'${escHtml(String(link.linkid))}',rootId:b.getAttribute('data-root')});});});
})();
</script>
</body></html>`;
}
