import * as vscode from "vscode";
import { HeyBoxClient } from "../api/client";
import { SearchItemInfo, TopicChild } from "../types";

type ViewMode = "recommend" | "categories" | "favorites";

const FAV_KEY = "heybox.favorites";
const MAX_SEARCH_RESULTS = 200; // 搜索结果上限，防止内存无限增长

function getFavs(context?: vscode.ExtensionContext): SearchItemInfo[] {
    if (!context) return [];
    return context.globalState.get<SearchItemInfo[]>(FAV_KEY, []);
}

export function toggleFav(context: vscode.ExtensionContext, post: SearchItemInfo): SearchItemInfo[] {
    const favs = getFavs(context);
    const idx = favs.findIndex((f) => f.linkid === post.linkid);
    if (idx >= 0) {
        favs.splice(idx, 1);
    } else {
        favs.unshift(post);
    }
    context.globalState.update(FAV_KEY, favs);
    return favs;
}

export { getFavs, FAV_KEY };

export class PostListProvider
    implements vscode.TreeDataProvider<TreeItemBase>
{
    private _onDidChangeTreeData = new vscode.EventEmitter<
        TreeItemBase | undefined | void
    >();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private viewMode: ViewMode = "categories";

    getViewMode(): ViewMode {
        return this.viewMode;
    }

    private topics: TopicChild[] = [];
    private topicPosts: Map<number, SearchItemInfo[]> = new Map();
    private topicOffsets: Map<number, number> = new Map();
    private loadingTopics: boolean = false;
    private loadingTopicsSet: Set<number> = new Set();

    private searchMode: boolean = false;
    private searchResults: SearchItemInfo[] = [];
    private searchQuery: string = "";
    private searchPage: number = 0;
    private searchLoading: boolean = false;

    private feedPosts: SearchItemInfo[] = [];
    private feedOffset: number = 0;
    private feedLoading: boolean = false;

    private favCache: Map<number, number> = new Map();

    constructor(private client: HeyBoxClient) {}

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }

    refresh(): void {
        this.exitSearch();
        this.topics = [];
        this.topicPosts.clear();
        this.topicOffsets.clear();
        this.feedPosts = [];
        this.feedOffset = 0;
        this.favCache.clear();
        this._onDidChangeTreeData.fire();
    }

    get isSearchMode(): boolean { return this.searchMode; }

    exitSearch(): void {
        this.searchMode = false;
        this.searchResults = [];
        this.searchQuery = "";
        this.searchPage = 0;
    }

    switchTo(viewMode: ViewMode): void {
        this.viewMode = viewMode;
        this.exitSearch();
        this._onDidChangeTreeData.fire();
    }

    async performSearch(query: string): Promise<void> {
        if (!query || this.searchLoading) return;
        this.searchQuery = query;
        this.searchMode = true;
        this.searchPage = 0;
        this.searchResults = [];
        await this.loadMoreSearchResults();
        this._onDidChangeTreeData.fire();
    }

    async loadMoreSearchResults(): Promise<void> {
        if (this.searchLoading) return;
        if (this.searchResults.length >= MAX_SEARCH_RESULTS) return;
        this.searchLoading = true;
        try {
            this.searchPage++;
            const result = await this.client.searchPosts(this.searchQuery, this.searchPage, 20);
            const newPosts = (result.items || []).map((item) => item.info).filter((info) => info && info.linkid);
            this.searchResults = this.searchResults.concat(newPosts);
            // 截断到上限
            if (this.searchResults.length > MAX_SEARCH_RESULTS) {
                this.searchResults = this.searchResults.slice(0, MAX_SEARCH_RESULTS);
            }
        } catch (e) {
            vscode.window.showErrorMessage(`搜索失败: ${(e as Error).message}`);
        } finally { this.searchLoading = false; }
    }

    getTreeItem(element: TreeItemBase): vscode.TreeItem { return element; }

    async getChildren(element?: TreeItemBase): Promise<TreeItemBase[]> {
        if (this.searchMode) return this.getSearchChildren(element);
        if (!element) {
            const tabs: TreeItemBase[] = [
                new TabItem("recommend", this.viewMode === "recommend"),
                new TabItem("categories", this.viewMode === "categories"),
                new TabItem("favorites", this.viewMode === "favorites"),
            ];
            if (this.viewMode === "recommend") {
                if (this.feedPosts.length === 0 && !this.feedLoading) await this.fetchFeed();
                tabs.push(...this.feedPosts.map((p) => new PostItem(p, vscode.TreeItemCollapsibleState.None, this.favCache)));
                tabs.push(new LoadMoreFeedItem());
            } else if (this.viewMode === "favorites") {
                const favs = getFavs(this.client.getContext());
                if (favs.length === 0) {
                    tabs.push(new TabEmptyItem("暂无收藏，右键帖子可以收藏"));
                } else {
                    tabs.push(...favs.map((p) => new PostItem(p, vscode.TreeItemCollapsibleState.None, this.favCache)));
                }
            } else {
                if (this.topics.length === 0) await this.fetchTopics();
                tabs.push(...this.topics.map((t) => new TopicItem(t,
                    this.topicPosts.has(t.topic_id) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)));
            }
            return tabs;
        }
        if (element instanceof TopicItem) {
            const tid = element.topic.topic_id;
            if (!this.topicPosts.has(tid)) await this.fetchTopicPosts(tid);
            const items: TreeItemBase[] = (this.topicPosts.get(tid) || []).map((p) => new PostItem(p, vscode.TreeItemCollapsibleState.None, this.favCache));
            items.push(new LoadMoreTopicItem(tid));
            return items;
        }
        return [];
    }

    private getSearchChildren(element?: TreeItemBase): TreeItemBase[] {
        if (!element) {
            const items: TreeItemBase[] = [new BackToTopicsItem(), new SearchHeaderItem(`搜索: ${this.searchQuery}`)];
            if (this.searchResults.length === 0 && !this.searchLoading) {
                items.push(new BusyItem("搜索中..."));
                this.loadMoreSearchResults();
            }
            items.push(...this.searchResults.map((p) => new PostItem(p, vscode.TreeItemCollapsibleState.None, this.favCache)));
            if (this.searchResults.length > 0) items.push(new LoadMoreSearchItem());
            return items;
        }
        return [];
    }

    private async fetchFeed(): Promise<void> {
        if (this.feedLoading) return;
        this.feedLoading = true;
        try {
            const result = await this.client.getFeed(this.feedOffset);
            this.feedPosts = this.feedPosts.concat((result.links || []).filter((p) => p && p.linkid));
            this.feedOffset = this.feedPosts.length;
        } catch (e) { vscode.window.showErrorMessage(`获取推荐失败: ${(e as Error).message}`); }
        finally { this.feedLoading = false; }
        this.fetchFavCounts(this.feedPosts);
    }

    private async fetchTopics(): Promise<void> {
        if (this.loadingTopics) return;
        this.loadingTopics = true;
        try {
            this.topics = (await this.client.getTopicCategories()).latest_hot_topics?.children || [];
        } catch (e) { vscode.window.showErrorMessage(`获取话题列表失败: ${(e as Error).message}`); }
        finally { this.loadingTopics = false; }
    }

    private async fetchTopicPosts(topicId: number): Promise<void> {
        if (this.loadingTopicsSet.has(topicId)) return;
        this.loadingTopicsSet.add(topicId);
        try {
            const offset = this.topicOffsets.get(topicId) || 0;
            const result = await this.client.getTopicFeeds(topicId, offset, 30);
            const newPosts = (result.links || []).filter((p) => p && p.linkid);
            this.topicPosts.set(topicId, (this.topicPosts.get(topicId) || []).concat(newPosts));
            this.topicOffsets.set(topicId, offset + newPosts.length);
        } catch (e) { vscode.window.showErrorMessage(`获取帖子列表失败: ${(e as Error).message}`); }
        finally { this.loadingTopicsSet.delete(topicId); }
        this.fetchFavCounts(this.topicPosts.get(topicId) || []);
    }

    private async fetchFavCounts(posts: SearchItemInfo[]): Promise<void> {
        const toFetch = posts.filter(p => !this.favCache.has(p.linkid));
        for (let i = 0; i < toFetch.length; i += 5) {
            const batch = toFetch.slice(i, i + 5);
            await Promise.all(batch.map(async (p) => {
                try {
                    const tree = await this.client.getPostTree(String(p.linkid), 0, 0);
                    this.favCache.set(p.linkid, tree.link.favour_count);
                } catch {}
            }));
        }
        this._onDidChangeTreeData.fire();
    }

    async loadMorePosts(topicId: number): Promise<void> {
        await this.fetchTopicPosts(topicId);
        this._onDidChangeTreeData.fire();
    }

    async loadMoreSearch(): Promise<void> {
        await this.loadMoreSearchResults();
        this._onDidChangeTreeData.fire();
    }

    async loadMoreFeed(): Promise<void> {
        await this.fetchFeed();
        this._onDidChangeTreeData.fire();
    }
}

export class TreeItemBase extends vscode.TreeItem {}

export class BackToTopicsItem extends TreeItemBase {
    constructor() {
        super("← 返回话题列表", vscode.TreeItemCollapsibleState.None);
        this.command = { command: "heybox.exitSearch", title: "返回话题列表" };
        this.contextValue = "backToTopics";
        this.iconPath = new vscode.ThemeIcon("arrow-left");
    }
}

export class SearchHeaderItem extends TreeItemBase {
    constructor(query: string) {
        super(query, vscode.TreeItemCollapsibleState.None);
        this.description = "搜索结果";
        this.contextValue = "searchHeader";
        this.iconPath = new vscode.ThemeIcon("search");
    }
}

export class TabItem extends TreeItemBase {
    constructor(mode: ViewMode, active: boolean) {
        const labels: Record<ViewMode, [string, string]> = {
            recommend: ["📌 推荐", "推荐"],
            categories: ["📁 板块", "板块"],
            favorites: ["⭐ 收藏", "收藏"],
        };
        const [activeLabel, inactiveLabel] = labels[mode];
        super(active ? activeLabel : inactiveLabel, vscode.TreeItemCollapsibleState.None);
        if (active) {
            this.iconPath = new vscode.ThemeIcon(mode === "favorites" ? "star" : mode === "recommend" ? "flame" : "folder-active");
            this.description = "● 当前";
        } else {
            this.iconPath = new vscode.ThemeIcon(mode === "favorites" ? "star-empty" : mode === "recommend" ? "flame" : "folder");
            const cmds: Record<ViewMode, string> = { recommend: "heybox.switchToRecommend", categories: "heybox.switchToCategories", favorites: "heybox.switchToFavorites" };
            this.command = { command: cmds[mode], title: "切换" };
        }
        this.contextValue = "tab";
    }
}

export class TopicItem extends TreeItemBase {
    constructor(public readonly topic: TopicChild, collapsibleState: vscode.TreeItemCollapsibleState) {
        const minimal = vscode.workspace.getConfiguration("heybox").get<boolean>("minimalMode", false);
        super(topic.name, collapsibleState);
        this.description = minimal ? "" : (topic.hot?.desc || "");
        this.contextValue = "topic";
        this.iconPath = new vscode.ThemeIcon("folder");
    }
}

export class PostItem extends TreeItemBase {
    public readonly post: SearchItemInfo;
    constructor(post: SearchItemInfo, collapsibleState: vscode.TreeItemCollapsibleState, favCache?: Map<number, number>) {
        const label = post.title || post.description?.substring(0, 40) || "无标题";
        super(label, collapsibleState);
        this.post = post;
        const fav = favCache?.get(post.linkid);
        const minimal = vscode.workspace.getConfiguration("heybox").get<boolean>("minimalMode", false);
        if (!minimal) this.description = fav !== undefined ? `⭐${fav} 💬${post.comment_num}` : `💬${post.comment_num}`;
        this.tooltip = new vscode.MarkdownString(`**${label}**\n\n${post.description?.substring(0, 100) || ""}\n\n${fav !== undefined ? '收藏: ' + fav + ' | ' : ''}评论: ${post.comment_num}\n话题: ${post.topics?.map((t) => t.name).join(", ") || "无"}`);
        this.command = { command: "heybox.openPost", title: "打开帖子", arguments: [post] };
        this.contextValue = "post";
        this.iconPath = minimal ? new vscode.ThemeIcon("file") : new vscode.ThemeIcon("comment-discussion");
    }
}

export class LoadMoreTopicItem extends TreeItemBase {
    constructor(public readonly topicId: number) {
        super("加载更多...", vscode.TreeItemCollapsibleState.None);
        this.command = { command: "heybox.loadMore", title: "加载更多", arguments: [topicId] };
        this.contextValue = "loadMore";
        this.iconPath = new vscode.ThemeIcon("more-horizontal");
    }
}

export class TabEmptyItem extends TreeItemBase {
    constructor(msg: string) {
        super(msg, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon("info");
        this.contextValue = "empty";
    }
}

export class LoadMoreSearchItem extends TreeItemBase {
    constructor() {
        super("加载更多搜索结果...", vscode.TreeItemCollapsibleState.None);
        this.command = { command: "heybox.loadMoreSearch", title: "加载更多搜索结果" };
        this.contextValue = "loadMoreSearch";
        this.iconPath = new vscode.ThemeIcon("more-horizontal");
    }
}

export class LoadMoreFeedItem extends TreeItemBase {
    constructor() {
        super("加载更多推荐...", vscode.TreeItemCollapsibleState.None);
        this.command = { command: "heybox.loadMoreFeed", title: "加载更多推荐" };
        this.contextValue = "loadMoreFeed";
        this.iconPath = new vscode.ThemeIcon("more-horizontal");
    }
}

export class BusyItem extends TreeItemBase {
    constructor(msg: string) {
        super(msg, vscode.TreeItemCollapsibleState.None);
        this.description = "$(sync~spin)";
        this.contextValue = "busy";
    }
}