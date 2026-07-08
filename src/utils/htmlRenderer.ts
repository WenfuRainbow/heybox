import * as vscode from "vscode";
import { PostTreeResult, Comment } from "../types";

function getThemeOverrides(): string {
    const theme = vscode.workspace.getConfiguration("heybox").get<string>("theme", "auto");
    if (theme === "dark") {
        return `--bg:#1e1e1e;--fg:#d4d4d4;--dim:#9d9d9d;--border:#333;--badge-bg:#4d4d4d;--badge-fg:#fff;--input-bg:#3c3c3c`;
    } else if (theme === "light") {
        return `--bg:#ffffff;--fg:#1e1e1e;--dim:#616161;--border:#e0e0e0;--badge-bg:#e0e0e0;--badge-fg:#333;--input-bg:#f3f3f3`;
    }
    return "";
}

export function formatTs(ts: number): string {
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

export function escHtml(s: string): string {
    if (!s) return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

export function renderContent(text: string): string {
    if (!text) return "";
    try {
        const blocks = JSON.parse(text);
        if (Array.isArray(blocks)) {
            return blocks.map((b: { type: string; url?: string; text?: string }) => {
                if (b.type === "img" && b.url) return `<img src="${escHtml(b.url)}" alt="帖子图片" loading="lazy" />`;
                if (b.type === "text" && b.text) return `<p>${escHtml(b.text)}</p>`;
                return "";
            }).join("");
        }
    } catch { /* not JSON */ }
    return `<p>${escHtml(text)}</p>`;
}

export function renderCommentHtml(c: Comment, sub: boolean, stealth: boolean): string {
    const level = c.user.level_info?.status === 1 ? `Lv.${c.user.level_info.level}` : "";
    const replyto = c.replyuser ? `<span class="rpl">${escHtml(c.replyuser.username)}</span>` : "";
    const imgs = (c.imgs || []).map((i) => `<img class="cimg" src="${escHtml(i.url)}" alt="评论图片" loading="lazy" />`).join("");
    const avatar = (!c.user.avatar || stealth) ? "" : `<img class="cava" src="${escHtml(c.user.avatar)}" alt="${escHtml(c.user.username)} 的头像" onerror="this.style.display='none'" />`;
    return `<article class="cm${sub ? " sub" : ""}" aria-label="${escHtml(c.user.username)} 的评论">${avatar}<div class="cbd"><div class="chd">${escHtml(c.user.username)} ${level ? `<span class="clv">${level}</span>` : ""} <span class="flr">#${c.floor_num}</span> ${replyto}</div><div class="cmeta">${formatTs(c.create_at)}${c.ip_location ? ` · ${escHtml(c.ip_location)}` : ""}${!stealth ? ` · 👍${c.up}` : ""}</div><div class="ct">${escHtml(c.text || "")}</div>${imgs}</div></article>`;
}

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
        const subs = g.comment.slice(1).map((c) => renderCommentHtml(c, true, stealth)).join("");
        return `<section class="cg" aria-label="评论组">${main}${subs}</section>`;
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
    .ftr{text-align:center;font-size:12px;color:var(--dim);padding:16px 0 8px}
    .img-preview{position:fixed;z-index:9999;pointer-events:none;width:auto;height:auto;border:2px solid var(--border);border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,.4);display:none;background:var(--bg)}
    .img-preview img{width:auto;height:auto;max-width:90vw;max-height:90vh;display:block;border-radius:4px}
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

var pv=document.createElement('div');pv.className='img-preview';var pi=document.createElement('img');pv.appendChild(pi);document.body.appendChild(pv);
document.addEventListener('mouseover',function(e){var t=e.target;if(t.tagName==='IMG'&&t.closest('.body img,.cimg')){pi.src=t.src;pv.style.display='block';var x=e.clientX+20,y=e.clientY;if(x+400>innerWidth)x=e.clientX-420;if(y+300>innerHeight)y=innerHeight-320;if(y<0)y=0;pv.style.left=x+'px';pv.style.top=y+'px'}});
document.addEventListener('mouseout',function(e){if(e.target.tagName==='IMG'&&e.target.closest('.body img,.cimg'))pv.style.display='none'});
document.addEventListener('mousemove',function(e){if(pv.style.display==='block'){var x=e.clientX+20,y=e.clientY;if(x+400>innerWidth)x=e.clientX-420;if(y+300>innerHeight)y=innerHeight-320;if(y<0)y=0;pv.style.left=x+'px';pv.style.top=y+'px'}});
})();
</script>
</body></html>`;
}