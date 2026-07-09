import * as vscode from "vscode";
import { HeyBoxClient } from "../api/client";
import { SearchItemInfo, TopicChild } from "../types";

/** 视图模式：推荐流 / 板块分类 / 收藏夹 */
type ViewMode = "recommend" | "categories" | "favorites";

const FAV_KEY = "heybox.favorites";          // 全局状态中收藏夹的存储键
const EXPANDED_KEY = "heybox.expandedTopics"; // 已展开话题的持久化键
const LAST_POST_KEY = "heybox.lastPostId";    // 上次阅读帖子的持久化键
const MAX_SEARCH_RESULTS = 200; // 搜索结果上限，防止内存无限增长

/** 从全局状态中读取收藏列表 */
function getFavs(context?: vscode.ExtensionContext): SearchItemInfo[] {
    if (!context) return [];
    return context.globalState.get<SearchItemInfo[]>(FAV_KEY, []);
}

/**
 * 切换帖子的收藏状态：已收藏则取消，未收藏则添加到列表首位
 * @returns 更新后的完整收藏列表
 */
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

export { getFavs };

/**
 * 帖子列表的 TreeView 数据提供者
 * 支持三种视图模式（推荐/板块/收藏）以及搜索模式，
 * 负责懒加载帖子数据并驱动侧边栏树的刷新。
 */
export class PostListProvider
    implements vscode.TreeDataProvider<TreeItemBase>
{
    /** 树数据变更事件发射器，触发后 VSCode 会重新调用 getChildren */
    private _onDidChangeTreeData = new vscode.EventEmitter<
        TreeItemBase | undefined | void
    >();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    /** 当前激活的视图模式 */
    private viewMode: ViewMode = "categories";

    getViewMode(): ViewMode {
        return this.viewMode;
    }

    /** 板块列表数据 */
    private topics: TopicChild[] = [];
    /** 各板块下已加载的帖子缓存，key = topic_id */
    private topicPosts: Map<number, SearchItemInfo[]> = new Map();
    /** 各板块的分页偏移量，用于加载更多 */
    private topicOffsets: Map<number, number> = new Map();
    /** 板块列表是否正在加载中（防止重复请求） */
    private loadingTopics: boolean = false;
    /** 正在加载帖子的板块 ID 集合（防止同一板块重复请求） */
    private loadingTopicsSet: Set<number> = new Set();

    /** 是否处于搜索模式 */
    private searchMode: boolean = false;
    /** 搜索结果列表 */
    private searchResults: SearchItemInfo[] = [];
    /** 当前搜索关键词 */
    private searchQuery: string = "";
    /** 搜索的当前页码（从 1 开始） */
    private searchPage: number = 0;
    /** 搜索是否正在加载中 */
    private searchLoading: boolean = false;

    /** 推荐流帖子列表 */
    private feedPosts: SearchItemInfo[] = [];
    /** 推荐流的分页偏移量 */
    private feedOffset: number = 0;
    /** 推荐流是否正在加载中 */
    private feedLoading: boolean = false;

    /** 帖子收藏数缓存，key = linkid, value = favour_count */
    private favCache: Map<number, number> = new Map();

    private ctx?: vscode.ExtensionContext;
    private treeView?: vscode.TreeView<TreeItemBase>;
    /** 已展开的话题 ID 集合，刷新后自动恢复展开状态 */
    private expandedTopics: Set<number> = new Set();

    constructor(private client: HeyBoxClient) {}

    /** 注入扩展上下文并恢复已展开话题的状态 */
    setContext(context: vscode.ExtensionContext): void {
        this.ctx = context;
        this.expandedTopics = new Set(context.globalState.get<number[]>(EXPANDED_KEY, []));
    }

    /** 绑定 TreeView 实例，用于控制面板展开等操作 */
    setTreeView(tv: vscode.TreeView<TreeItemBase>): void {
        this.treeView = tv;
    }

    /** 将当前已展开话题的 ID 列表持久化到 globalState */
    saveExpanded(): void {
        if (this.ctx) this.ctx.globalState.update(EXPANDED_KEY, [...this.expandedTopics]);
    }

    /** 记录上次阅读的帖子 ID，用于恢复上下文 */
    saveLastPost(linkid: number): void {
        if (this.ctx) this.ctx.globalState.update(LAST_POST_KEY, linkid);
    }

    /** 释放事件发射器资源 */
    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }

    /** 重置所有缓存数据并触发树刷新 */
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

    /** 退出搜索模式，清空搜索状态 */
    exitSearch(): void {
        this.searchMode = false;
        this.searchResults = [];
        this.searchQuery = "";
        this.searchPage = 0;
    }

    /** 切换视图模式并刷新树 */
    switchTo(viewMode: ViewMode): void {
        this.viewMode = viewMode;
        this.exitSearch();
        this._onDidChangeTreeData.fire();
    }

    /**
     * 执行搜索：重置搜索状态，加载第一页结果，然后刷新树
     * @param query 搜索关键词
     */
    async performSearch(query: string): Promise<void> {
        if (!query || this.searchLoading) return;
        this.searchQuery = query;
        this.searchMode = true;
        this.searchPage = 0;
        this.searchResults = [];
        await this.loadMoreSearchResults();
        this._onDidChangeTreeData.fire();
    }

    /** 加载下一页搜索结果，受 MAX_SEARCH_RESULTS 上限约束 */
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

    /**
     * 核心方法：根据当前状态返回树节点的子元素
     * - 搜索模式下委托给 getSearchChildren
     * - 根节点：根据 viewMode 返回三个 Tab + 对应内容
     * - 板块节点：懒加载该板块下的帖子列表
     */
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
                    (this.topicPosts.has(t.topic_id) || this.expandedTopics.has(t.topic_id))
                        ? vscode.TreeItemCollapsibleState.Expanded
                        : vscode.TreeItemCollapsibleState.Collapsed)));
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

    /** 获取推荐流帖子，使用 offset 分页追加 */
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

    /** 获取板块分类列表（仅加载一次） */
    private async fetchTopics(): Promise<void> {
        if (this.loadingTopics) return;
        this.loadingTopics = true;
        try {
            this.topics = (await this.client.getTopicCategories()).latest_hot_topics?.children || [];
        } catch (e) { vscode.window.showErrorMessage(`获取话题列表失败: ${(e as Error).message}`); }
        finally { this.loadingTopics = false; }
    }

    /** 懒加载指定板块下的帖子列表，支持分页追加 */
    private async fetchTopicPosts(topicId: number): Promise<void> {
        if (this.loadingTopicsSet.has(topicId)) return;
        this.loadingTopicsSet.add(topicId);
        this.expandedTopics.add(topicId);
        this.saveExpanded();
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

    /**
     * 批量获取帖子的收藏数，每批 5 个并发请求
     * 结果缓存到 favCache，用于在树项上显示收藏图标
     */
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

    /** 加载更多指定板块的帖子 */
    async loadMorePosts(topicId: number): Promise<void> {
        await this.fetchTopicPosts(topicId);
        this._onDidChangeTreeData.fire();
    }

    /** 加载更多搜索结果 */
    async loadMoreSearch(): Promise<void> {
        await this.loadMoreSearchResults();
        this._onDidChangeTreeData.fire();
    }

    /** 加载更多推荐流帖子 */
    async loadMoreFeed(): Promise<void> {
        await this.fetchFeed();
        this._onDidChangeTreeData.fire();
    }
}

/** 所有树节点的基类 */
export class TreeItemBase extends vscode.TreeItem {}

/** 搜索模式下返回板块列表的导航项 */
export class BackToTopicsItem extends TreeItemBase {
    constructor() {
        super("← 返回话题列表", vscode.TreeItemCollapsibleState.None);
        this.command = { command: "heybox.exitSearch", title: "返回话题列表" };
        this.contextValue = "backToTopics";
        this.iconPath = new vscode.ThemeIcon("arrow-left");
    }
}

/** 搜索结果头部，显示当前搜索关键词 */
export class SearchHeaderItem extends TreeItemBase {
    constructor(query: string) {
        super(query, vscode.TreeItemCollapsibleState.None);
        this.description = "搜索结果";
        this.contextValue = "searchHeader";
        this.iconPath = new vscode.ThemeIcon("search");
    }
}

/** 视图模式切换 Tab（推荐/板块/收藏），激活态显示不同图标和标记 */
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

/** 板块分类树节点，可展开查看该板块下的帖子 */
export class TopicItem extends TreeItemBase {
    constructor(public readonly topic: TopicChild, collapsibleState: vscode.TreeItemCollapsibleState) {
        const minimal = vscode.workspace.getConfiguration("heybox").get<boolean>("minimalMode", false);
        super(topic.name, collapsibleState);
        this.description = minimal ? "" : (topic.hot?.desc || "");
        this.contextValue = "topic";
        this.iconPath = new vscode.ThemeIcon("folder");
    }
}

/** 帖子树节点，显示标题、收藏数和评论数，点击打开帖子详情 */
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

/** 板块内的"加载更多"按钮，点击触发分页加载 */
export class LoadMoreTopicItem extends TreeItemBase {
    constructor(public readonly topicId: number) {
        super("加载更多...", vscode.TreeItemCollapsibleState.None);
        this.command = { command: "heybox.loadMore", title: "加载更多", arguments: [topicId] };
        this.contextValue = "loadMore";
        this.iconPath = new vscode.ThemeIcon("more-horizontal");
    }
}

/** 空状态提示项，用于在无内容时显示提示信息 */
export class TabEmptyItem extends TreeItemBase {
    constructor(msg: string) {
        super(msg, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon("info");
        this.contextValue = "empty";
    }
}

/** 搜索模式下的"加载更多"按钮 */
export class LoadMoreSearchItem extends TreeItemBase {
    constructor() {
        super("加载更多搜索结果...", vscode.TreeItemCollapsibleState.None);
        this.command = { command: "heybox.loadMoreSearch", title: "加载更多搜索结果" };
        this.contextValue = "loadMoreSearch";
        this.iconPath = new vscode.ThemeIcon("more-horizontal");
    }
}

/** 推荐流的"加载更多"按钮 */
export class LoadMoreFeedItem extends TreeItemBase {
    constructor() {
        super("加载更多推荐...", vscode.TreeItemCollapsibleState.None);
        this.command = { command: "heybox.loadMoreFeed", title: "加载更多推荐" };
        this.contextValue = "loadMoreFeed";
        this.iconPath = new vscode.ThemeIcon("more-horizontal");
    }
}

/** 加载中占位项，显示旋转图标表示正在加载 */
export class BusyItem extends TreeItemBase {
    constructor(msg: string) {
        super(msg, vscode.TreeItemCollapsibleState.None);
        this.description = "$(sync~spin)";
        this.contextValue = "busy";
    }
}