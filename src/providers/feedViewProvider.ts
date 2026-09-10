import * as vscode from "vscode";
import { HeyBoxClient } from "../api/client";
import { CommunitySummary, FavouriteFolder, MessageItem, SearchItemInfo, SearchSuggestion } from "../types";

type FeedSection = "recommend" | "communities" | "favorites" | "messages";
type ContentMode = FeedSection | "history" | "search" | "author" | "topic";

/** 默认富内容列表。隐身或简约模式由 package.json 的 when 条件切回原生 TreeView。 */
export class FeedViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    static readonly viewType = "heybox.feed";

    private view?: vscode.WebviewView;
    private section: FeedSection = "recommend";
    private mode: ContentMode = "recommend";
    private posts: SearchItemInfo[] = [];
    private offset = 0;
    private hasMore = true;
    private loading = false;
    private communities: { followed: CommunitySummary[]; popular: CommunitySummary[] } = { followed: [], popular: [] };
    private folders: FavouriteFolder[] = [];
    private folderId?: string;
    private suggestions: SearchSuggestion[] = [];
    private heading = "推荐";
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly client: HeyBoxClient,
        private readonly context: vscode.ExtensionContext,
        private readonly openPost: (post: SearchItemInfo) => Promise<void>,
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true };
        this.disposables.push(view.webview.onDidReceiveMessage((message) => void this.handleMessage(message)));
        void this.switchSection("recommend");
    }

    async refresh(): Promise<void> {
        const section = this.section;
        this.reset(section, sectionLabel(section));
        await this.loadCurrent();
    }

    dispose(): void {
        for (const disposable of this.disposables) disposable.dispose();
    }

    private reset(mode: ContentMode, heading: string): void {
        this.mode = mode;
        this.heading = heading;
        this.posts = [];
        this.offset = 0;
        this.hasMore = true;
        this.folderId = undefined;
    }

    private async switchSection(section: FeedSection): Promise<void> {
        this.section = section;
        this.reset(section, sectionLabel(section));
        await this.loadCurrent();
    }

    private async loadCurrent(): Promise<void> {
        if (this.loading || !this.hasMore) return;
        this.loading = true;
        this.render();
        try {
            if (this.mode === "recommend") {
                const result = await this.client.getFeed(this.offset);
                this.appendPosts(result.links || []);
                this.hasMore = (result.links || []).length > 0;
            } else if (this.mode === "communities") {
                this.communities = await this.client.getCommunityBanner();
                this.hasMore = false;
            } else if (this.mode === "favorites") {
                if (!this.folders.length) this.folders = await this.client.getFavouriteFolders();
                if (!this.folderId) this.folderId = this.folders.find((folder) => folder.is_default)?.folder_id || this.folders[0]?.folder_id;
                const result = await this.client.getFavouriteLinks(this.offset, 30, this.folderId);
                this.appendPosts(result.links);
                this.hasMore = result.hasMore;
            } else if (this.mode === "messages") {
                const result = await this.client.getInteractionMessages("comment", this.offset, 30);
                this.posts = (result.messages || []).map(messagePost).filter((post): post is SearchItemInfo => !!post);
                this.hasMore = false;
            }
        } catch (error) {
            this.hasMore = false;
            vscode.window.showErrorMessage(`加载${this.heading}失败: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.loading = false;
            this.render();
        }
    }

    private appendPosts(incoming: SearchItemInfo[]): void {
        const known = new Set(this.posts.map((post) => String(post.linkid)));
        const added = incoming.filter((post) => {
            if (!post?.linkid || known.has(String(post.linkid))) return false;
            known.add(String(post.linkid));
            return true;
        });
        this.posts.push(...added);
        this.offset += incoming.length;
        if (!added.length) this.hasMore = false;
    }

    private async handleMessage(message: any): Promise<void> {
        if (!message || typeof message.command !== "string") return;
        if (message.command === "navigate" && ["recommend", "communities", "favorites", "messages"].includes(message.section)) {
            await this.switchSection(message.section as FeedSection);
        } else if (message.command === "loadMore") {
            await this.loadCurrent();
        } else if (message.command === "refresh") {
            await this.refresh();
        } else if (message.command === "openPost") {
            const post = this.posts.find((item) => String(item.linkid) === String(message.linkId));
            if (post) await this.openPost(post);
        } else if (message.command === "openTopic") {
            const topicId = Number(message.topicId);
            const topic = [...this.communities.followed, ...this.communities.popular].find((item) => item.topic_id === topicId);
            this.reset("topic", topic?.name || "社区帖子");
            await this.loadTopic(topicId);
        } else if (message.command === "chooseFolder") {
            this.reset("favorites", "收藏");
            this.section = "favorites";
            this.folderId = String(message.folderId || "");
            await this.loadFavouriteFolder();
        } else if (message.command === "history") {
            this.showHistory();
        } else if (message.command === "search") {
            await this.search(String(message.query || "").trim());
        } else if (message.command === "searchWelcome") {
            await this.showSearchWelcome();
        } else if (message.command === "openAuthor") {
            await this.loadAuthor(String(message.userId || ""), String(message.name || "作者"));
        }
    }

    private async loadTopic(topicId: number): Promise<void> {
        this.loading = true;
        this.render();
        try {
            const result = await this.client.getTopicFeeds(topicId, 0, 30);
            this.posts = result.links || [];
            this.offset = this.posts.length;
            this.hasMore = false;
        } catch (error) {
            vscode.window.showErrorMessage(`加载社区失败: ${error instanceof Error ? error.message : String(error)}`);
        } finally { this.loading = false; this.render(); }
    }

    private async loadFavouriteFolder(): Promise<void> {
        this.loading = true;
        this.render();
        try {
            const result = await this.client.getFavouriteLinks(0, 30, this.folderId);
            this.posts = result.links;
            this.offset = this.posts.length;
            this.hasMore = result.hasMore;
        } catch (error) {
            vscode.window.showErrorMessage(`加载收藏夹失败: ${error instanceof Error ? error.message : String(error)}`);
        } finally { this.loading = false; this.render(); }
    }

    private showHistory(): void {
        const separator = "\x00";
        this.mode = "history";
        this.heading = "浏览历史";
        this.posts = this.context.globalState.get<string[]>("history", []).map((entry) => {
            const at = entry.lastIndexOf(separator);
            return {
                linkid: Number(at >= 0 ? entry.substring(at + 1) : entry),
                title: at >= 0 ? entry.substring(0, at) : "历史帖子",
                description: "", userid: 0, link_type: 0, link_tag: 0, is_web: 0,
                comment_num: 0, create_at: 0, modify_at: 0, share_url: "", up: 0, down: 0,
                topics: [], has_video: 0,
            };
        }).filter((post) => Number.isFinite(post.linkid) && post.linkid > 0);
        this.hasMore = false;
        this.render();
    }

    private async showSearchWelcome(): Promise<void> {
        this.mode = "search";
        this.heading = "搜索";
        this.posts = [];
        this.hasMore = false;
        this.loading = true;
        this.render();
        try {
            const welcome = await this.client.getSearchWelcome();
            this.suggestions = [...welcome.hot, ...welcome.suggestions].filter((item, index, all) => all.findIndex((value) => value.text === item.text) === index);
        } catch (error) {
            vscode.window.showErrorMessage(`加载搜索首页失败: ${error instanceof Error ? error.message : String(error)}`);
        } finally { this.loading = false; this.render(); }
    }

    private async search(query: string): Promise<void> {
        if (!query) { await this.showSearchWelcome(); return; }
        this.mode = "search";
        this.heading = `搜索：${query}`;
        this.posts = [];
        this.hasMore = false;
        this.loading = true;
        this.render();
        try {
            const result = await this.client.searchPosts(query, 0, 30);
            this.posts = result.items.map((item) => item.info);
        } catch (error) {
            vscode.window.showErrorMessage(`搜索失败: ${error instanceof Error ? error.message : String(error)}`);
        } finally { this.loading = false; this.render(); }
    }

    private async loadAuthor(userId: string, name: string): Promise<void> {
        if (!userId) return;
        this.reset("author", `${name}的帖子`);
        this.loading = true;
        this.render();
        try {
            this.posts = await this.client.getUserLinks(userId, 0, 30);
            this.hasMore = false;
        } catch (error) {
            vscode.window.showErrorMessage(`加载作者帖子失败: ${error instanceof Error ? error.message : String(error)}`);
        } finally { this.loading = false; this.render(); }
    }

    private render(): void {
        if (!this.view) return;
        const communityHtml = this.mode === "communities" ? renderCommunities(this.communities) : "";
        const folderHtml = this.section === "favorites" && this.folders.length
            ? `<div class="folders">${this.folders.map((folder) => `<button data-folder="${esc(folder.folder_id)}" class="chip${folder.folder_id === this.folderId ? " active" : ""}">${esc(folder.name)}${folder.count === undefined ? "" : ` · ${folder.count}`}</button>`).join("")}</div>` : "";
        const suggestions = this.mode === "search" && this.suggestions.length && !this.posts.length
            ? `<section class="suggestions"><h2>热搜与建议</h2><div>${this.suggestions.map((item) => `<button class="chip" data-query="${esc(item.text)}">${item.rank ? `${item.rank}. ` : ""}${esc(item.text)}${item.hot ? ` · ${esc(item.hot)}` : ""}</button>`).join("")}</div></section>` : "";
        const cards = this.posts.map(renderCard).join("");
        const empty = !this.loading && !cards && !communityHtml && !suggestions ? `<div class="empty">暂无内容</div>` : "";
        const more = this.hasMore ? `<button id="loadMore" class="more" ${this.loading ? "disabled" : ""}>${this.loading ? "加载中…" : "加载更多"}</button><div id="sentinel"></div>` : "";
        this.view.webview.html = pageHtml(this.section, this.heading, folderHtml + communityHtml + suggestions + `<div class="cards">${cards}</div>` + empty + more, this.loading);
    }
}

function sectionLabel(section: FeedSection): string {
    return ({ recommend: "推荐", communities: "社区", favorites: "收藏", messages: "消息" } as const)[section];
}

function messagePost(message: MessageItem): SearchItemInfo | undefined {
    const id = Number(message.link?.linkid || message.link_id || message.linkid);
    if (!Number.isFinite(id) || id <= 0) return undefined;
    return {
        linkid: id, userid: Number(message.user_a?.heybox_id || 0),
        title: message.link?.title || message.link_title || message.text || "互动消息",
        description: message.comment_a_text || message.text || "", link_type: 0, link_tag: 0, is_web: 0,
        comment_num: 0, create_at: message.create_at || message.timestamp || 0, modify_at: 0,
        share_url: "", up: 0, down: 0, topics: [], has_video: 0,
        user: message.user_a ? { userid: Number(message.user_a.heybox_id || 0), username: message.user_a.nickname || message.user_a.username, avatar: message.user_a.avatar } : undefined,
    };
}

function renderCommunities(groups: { followed: CommunitySummary[]; popular: CommunitySummary[] }): string {
    const group = (title: string, items: CommunitySummary[]) => `<section class="community"><h2>${title}</h2><div class="community-grid">${items.map((topic) => `<button class="community-card" data-topic="${topic.topic_id}">${safeImage(topic.pic_url, topic.name)}<span><strong>${esc(topic.name)}</strong>${topic.description ? `<small>${esc(topic.description)}</small>` : ""}</span></button>`).join("") || '<span class="dim">暂无社区</span>'}</div></section>`;
    return group("已关注社区", groups.followed) + group("热门社区", groups.popular);
}

function renderCard(post: SearchItemInfo): string {
    const title = post.title || post.description || "无标题";
    const author = post.user?.username || "";
    const userId = post.user?.userid || post.userid;
    const image = postImageUrl(post);
    return `<article class="card" data-post="${post.linkid}">${image ? `<img class="cover" src="${esc(image)}" alt="" loading="lazy">` : ""}<div class="card-body"><button class="title">${esc(title)}</button><div class="meta">${author ? `<button class="author" data-user="${esc(userId)}" data-name="${esc(author)}">${esc(author)}</button> · ` : ""}${relativeTime(post.create_at)}</div>${post.description ? `<p>${esc(post.description).substring(0, 220)}</p>` : ""}<div class="stats"><span>赞 ${post.up || 0}</span><span>评论 ${post.comment_num || 0}</span><span>收藏 ${post.favour_count || 0}</span></div></div></article>`;
}

function postImageUrl(post: SearchItemInfo): string | undefined {
    const candidates = [...(post.pics || []), ...(post.imgs || [])];
    for (const item of candidates) {
        const url = typeof item === "string" ? item : item?.url;
        if (/^https:\/\//i.test(url || "")) return url;
    }
    return undefined;
}

function safeImage(url: string | undefined, alt: string): string {
    return url && /^https:\/\//i.test(url) ? `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy">` : `<span class="community-icon">#</span>`;
}

function relativeTime(timestamp: number): string {
    if (!timestamp) return "";
    const date = new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
}

function esc(value: unknown): string {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function pageHtml(section: FeedSection, heading: string, content: string, loading: boolean): string {
    const nav = (["recommend", "communities", "favorites", "messages"] as FeedSection[]).map((item) => `<button data-nav="${item}" class="nav${item === section ? " active" : ""}">${sectionLabel(item)}</button>`).join("");
    return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';"><style>
*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:13px/1.5 var(--vscode-font-family)}header{position:sticky;top:0;z-index:2;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);padding:8px 10px}.navs{display:grid;grid-template-columns:repeat(4,1fr);gap:3px}.nav,.toolbar button,.chip,.more,.community-card,.title,.author{border:0;color:inherit;font:inherit;cursor:pointer}.nav{background:transparent;padding:7px 2px;border-bottom:2px solid transparent}.nav.active{color:var(--vscode-textLink-foreground);border-color:var(--vscode-textLink-foreground);font-weight:600}.toolbar{display:flex;gap:6px;margin-top:8px}.toolbar form{display:flex;flex:1}.toolbar input{min-width:0;flex:1;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:5px 7px}.toolbar button{background:var(--vscode-button-secondaryBackground);padding:5px 8px}.toolbar button:hover,.chip:hover,.more:hover{background:var(--vscode-button-secondaryHoverBackground)}main{max-width:820px;margin:auto;padding:10px}h1{font-size:16px;margin:2px 0 10px}h2{font-size:13px;margin:12px 0 7px}.cards{display:grid;gap:9px}.card{display:flex;overflow:hidden;border:1px solid var(--vscode-panel-border);border-radius:7px;background:var(--vscode-editor-background)}.cover{width:32%;max-width:220px;object-fit:cover;min-height:112px}.card-body{min-width:0;flex:1;padding:11px}.title{display:block;text-align:left;width:100%;padding:0;background:transparent;font-size:15px;font-weight:650}.title:hover{color:var(--vscode-textLink-foreground)}.meta,.dim{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px}.author{padding:0;background:transparent;color:var(--vscode-textLink-foreground)}p{color:var(--vscode-descriptionForeground);margin:7px 0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.stats{display:flex;gap:13px;color:var(--vscode-descriptionForeground);font-size:11px}.folders,.suggestions>div{display:flex;gap:6px;overflow-x:auto;margin-bottom:9px}.chip{flex:none;border:1px solid var(--vscode-panel-border);border-radius:99px;background:var(--vscode-editor-background);padding:4px 9px}.chip.active{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}.community-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:7px}.community-card{display:flex;align-items:center;gap:8px;text-align:left;border:1px solid var(--vscode-panel-border);border-radius:6px;background:var(--vscode-editor-background);padding:8px}.community-card img,.community-icon{width:34px;height:34px;border-radius:7px;object-fit:cover;display:grid;place-items:center;background:var(--vscode-badge-background)}.community-card small{display:block;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}.more{display:block;width:100%;margin:12px 0;padding:8px;border-radius:5px;background:var(--vscode-button-secondaryBackground)}.empty{text-align:center;color:var(--vscode-descriptionForeground);padding:35px 0}.loading{height:2px;background:var(--vscode-progressBar-background);animation:pulse 1s infinite}@keyframes pulse{50%{opacity:.25}}@media(max-width:420px){main{padding:7px}.card{border-radius:5px}.card-body{padding:8px}.cover{width:34%;min-height:96px}.title{font-size:13px}p{-webkit-line-clamp:2}.community-grid{grid-template-columns:1fr 1fr}}
</style></head><body><header><nav class="navs">${nav}</nav><div class="toolbar"><form id="search"><input id="query" placeholder="搜索帖子" aria-label="搜索帖子"><button>搜索</button></form><button id="searchWelcome" title="热搜">热搜</button><button id="history" title="浏览历史">历史</button><button id="refresh" title="刷新">↻</button></div></header>${loading ? '<div class="loading"></div>' : ""}<main><h1>${esc(heading)}</h1>${content}</main><script>
const vscode=acquireVsCodeApi();const send=(command,data={})=>vscode.postMessage({command,...data});
document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>send('navigate',{section:b.dataset.nav}));
document.querySelectorAll('[data-post]').forEach(b=>b.onclick=e=>{if(e.target.closest('.author'))return;send('openPost',{linkId:b.dataset.post})});
document.querySelectorAll('[data-topic]').forEach(b=>b.onclick=()=>send('openTopic',{topicId:b.dataset.topic}));
document.querySelectorAll('[data-folder]').forEach(b=>b.onclick=()=>send('chooseFolder',{folderId:b.dataset.folder}));
document.querySelectorAll('[data-query]').forEach(b=>b.onclick=()=>send('search',{query:b.dataset.query}));
document.querySelectorAll('.author').forEach(b=>b.onclick=e=>{e.stopPropagation();send('openAuthor',{userId:b.dataset.user,name:b.dataset.name})});
document.getElementById('search').onsubmit=e=>{e.preventDefault();send('search',{query:document.getElementById('query').value})};
document.getElementById('searchWelcome').onclick=()=>send('searchWelcome');document.getElementById('history').onclick=()=>send('history');document.getElementById('refresh').onclick=()=>send('refresh');
const more=document.getElementById('loadMore');if(more)more.onclick=()=>send('loadMore');const sentinel=document.getElementById('sentinel');if(sentinel&&'IntersectionObserver'in window){const io=new IntersectionObserver(es=>{if(es.some(e=>e.isIntersecting)&&more&&!more.disabled){more.disabled=true;send('loadMore')}},{rootMargin:'220px'});io.observe(sentinel)}
</script></body></html>`;
}
