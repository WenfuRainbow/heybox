import * as vscode from "vscode";
import { HeyBoxClient } from "../api/client";
import { DiscountMessageItem, MessageItem, OfficialMessageItem, SearchItemInfo, TopicChild } from "../types";

/** 视图模式：推荐流 / 板块分类 / 云端收藏 / 消息中心 */
type ViewMode = "recommend" | "categories" | "favorites" | "messages";
type MessageSection = "comment" | "award" | "follow" | "mention" | "official" | "discount";

interface MessageEntry {
    id: string;
    title: string;
    detail: string;
    timestamp?: number;
    linkId?: string;
    unread?: boolean;
}

interface MessagePageState {
    entries: MessageEntry[];
    offset: number;
    cursor: string;
    hasMore: boolean;
    loading: boolean;
    error?: string;
}

const EXPANDED_KEY = "heybox.expandedTopics"; // 已展开话题的持久化键
const LAST_POST_KEY = "heybox.lastPostId";    // 上次阅读帖子的持久化键
const MAX_SEARCH_RESULTS = 200; // 搜索结果上限，防止内存无限增长

/**
 * 帖子列表的 TreeView 数据提供者
 * 支持推荐、板块、云端收藏、消息中心以及搜索模式，
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
    /** 搜索的当前偏移量；与网页版 /search/v1 的 offset 参数一致。 */
    private searchOffset: number = 0;
    /** 搜索接口是否仍有下一页。 */
    private searchHasMore: boolean = true;
    /** 搜索是否正在加载中 */
    private searchLoading: boolean = false;
    /** 搜索请求失败信息；空结果与请求失败需要分别呈现。 */
    private searchError: string | undefined;

    /** 推荐流帖子列表 */
    private feedPosts: SearchItemInfo[] = [];
    /** 推荐流的分页偏移量 */
    private feedOffset: number = 0;
    /** 推荐流是否正在加载中 */
    private feedLoading: boolean = false;
    /** 推荐流是否还有下一页。 */
    private feedHasMore: boolean = true;
    private feedError: string | undefined;
    /** 每个板块是否还有下一页。 */
    private topicHasMore: Map<number, boolean> = new Map();

    /** 帖子收藏数缓存，key = linkid, value = favour_count */
    private favCache: Map<number, number> = new Map();

    /** 服务端默认收藏夹，首次进入收藏页时按需读取。 */
    private favouritePosts: SearchItemInfo[] = [];
    private favouriteOffset = 0;
    private favouritesLoaded = false;
    private favouritesHasMore = true;
    private favouritesLoading = false;
    private favouritesError: string | undefined;
    /** 最近一次服务端收藏夹读取到的状态；本地缓存绝不作为展示依据。 */
    private readonly serverFavouriteIds = new Set<number>();
    private favouritesStateComplete = false;
    private favouritesSync?: Promise<void>;
    private topicsError: string | undefined;
    private readonly topicErrors = new Map<number, string>();

    /** 消息中心的六个分页流，避免切换分类时重复请求。 */
    private readonly messagePages = new Map<MessageSection, MessagePageState>();

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

    /** 重置缓存并触发树刷新；搜索状态下保留关键词并重新搜索。 */
    refresh(): void {
        if (this.searchMode) {
            this.searchResults = [];
            this.searchOffset = 0;
            this.searchHasMore = true;
            this.searchError = undefined;
            void this.loadMoreSearchResults();
            this._onDidChangeTreeData.fire();
            return;
        }
        this.topics = [];
        this.topicPosts.clear();
        this.topicOffsets.clear();
        this.topicHasMore.clear();
        this.feedPosts = [];
        this.feedOffset = 0;
        this.feedHasMore = true;
        this.feedError = undefined;
        this.topicsError = undefined;
        this.topicErrors.clear();
        this.favCache.clear();
        this.favouritePosts = [];
        this.favouriteOffset = 0;
        this.favouritesLoaded = false;
        this.favouritesHasMore = true;
        this.favouritesError = undefined;
        this.serverFavouriteIds.clear();
        this.favouritesStateComplete = false;
        this.messagePages.clear();
        this._onDidChangeTreeData.fire();
    }

    get isSearchMode(): boolean { return this.searchMode; }
    getSearchQuery(): string { return this.searchQuery; }

    /** 退出搜索模式，清空搜索状态 */
    exitSearch(): void {
        this.searchMode = false;
        this.searchResults = [];
        this.searchQuery = "";
        this.searchOffset = 0;
        this.searchHasMore = true;
        this.searchError = undefined;
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
        this.searchOffset = 0;
        this.searchHasMore = true;
        this.searchResults = [];
        this.searchError = undefined;
        await this.loadMoreSearchResults();
        this._onDidChangeTreeData.fire();
    }

    /** 加载下一页搜索结果，受 MAX_SEARCH_RESULTS 上限约束 */
    async loadMoreSearchResults(): Promise<void> {
        if (this.searchLoading) return;
        if (!this.searchHasMore) return;
        if (this.searchResults.length >= MAX_SEARCH_RESULTS) return;
        this.searchLoading = true;
        try {
            const pageSize = 30;
            const result = await this.client.searchPosts(this.searchQuery, this.searchOffset, pageSize);
            const newPosts = (result.items || []).map((item) => item.info).filter((info) => info && info.linkid);
            // API 有时会把同一 linkid 以 number / string 两种形式返回；同时同一页本身也可能重复。
            // 使用字符串主键并在筛选过程中立即登记，确保跨页和页内都只保留一条。
            const known = new Set(this.searchResults.map((post) => String(post.linkid)));
            const added = newPosts.filter((post) => {
                const key = String(post.linkid);
                if (known.has(key)) return false;
                known.add(key);
                return true;
            });
            this.searchResults = this.searchResults.concat(added);
            this.searchOffset += pageSize;
            // 防御服务端游标异常：只要整页没有新帖子，就不再显示加载更多入口。
            this.searchHasMore = (result.raw_item_count ?? newPosts.length) > 0 && added.length > 0;
            // 截断到上限
            if (this.searchResults.length > MAX_SEARCH_RESULTS) {
                this.searchResults = this.searchResults.slice(0, MAX_SEARCH_RESULTS);
                this.searchHasMore = false;
            }
        } catch (e) {
            this.searchError = (e as Error).message || "未知错误";
            this.searchHasMore = false;
        } finally { this.searchLoading = false; }
    }

    getTreeItem(element: TreeItemBase): vscode.TreeItem { return element; }

    /**
     * 核心方法：根据当前状态返回树节点的子元素
     * - 搜索模式下委托给 getSearchChildren
     * - 根节点：根据 viewMode 返回四个 Tab + 对应内容
     * - 板块节点：懒加载该板块下的帖子列表
     */
    async getChildren(element?: TreeItemBase): Promise<TreeItemBase[]> {
        if (this.searchMode) return this.getSearchChildren(element);
        if (!element) {
            // 原生 TreeView 不适合模拟四个横向标签。只保留一个模式入口，
            // 让实际内容紧跟在下面，给窄侧边栏留出更多垂直空间。
            const tabs: TreeItemBase[] = [new ModeSelectorItem(this.viewMode)];
            if (this.viewMode === "recommend") {
                if (this.feedPosts.length === 0 && !this.feedLoading && !this.feedError) await this.fetchFeed();
                tabs.push(...this.feedPosts.map((p) => new PostItem(p, vscode.TreeItemCollapsibleState.None, this.favCache, this.isServerFavourite(p))));
                if (this.feedLoading) tabs.push(new BusyItem("正在加载推荐..."));
                else if (this.feedError) tabs.push(new RetryItem(`加载推荐失败：${this.feedError}`));
                else if (this.feedHasMore) tabs.push(new LoadMoreFeedItem());
                else if (this.feedPosts.length === 0) tabs.push(new TabEmptyItem("暂无推荐帖子"));
            } else if (this.viewMode === "favorites") {
                if (!this.favouritesLoaded && !this.favouritesLoading && !this.favouritesError) await this.fetchFavourites();
                if (this.favouritePosts.length === 0) {
                    tabs.push(this.favouritesError ? new RetryItem(`加载收藏失败：${this.favouritesError}`) : new TabEmptyItem("暂无云端收藏"));
                } else {
                    tabs.push(...this.favouritePosts.map((p) => new PostItem(p, vscode.TreeItemCollapsibleState.None, this.favCache, true)));
                    if (this.favouritesHasMore) tabs.push(new LoadMoreFavouritesItem());
                }
            } else if (this.viewMode === "messages") {
                tabs.push(...MESSAGE_SECTIONS.map((section) => new MessageSectionItem(section)));
            } else {
                if (this.topics.length === 0 && !this.topicsError) await this.fetchTopics();
                if (this.topicsError) tabs.push(new RetryItem(`加载板块失败：${this.topicsError}`));
                else tabs.push(...this.topics.map((t) => new TopicItem(t,
                    (this.topicPosts.has(t.topic_id) || this.expandedTopics.has(t.topic_id))
                        ? vscode.TreeItemCollapsibleState.Expanded
                        : vscode.TreeItemCollapsibleState.Collapsed)));
            }
            return tabs;
        }
        if (element instanceof TopicItem) {
            const tid = element.topic.topic_id;
            if (!this.topicPosts.has(tid) && !this.topicErrors.has(tid)) await this.fetchTopicPosts(tid);
            const items: TreeItemBase[] = (this.topicPosts.get(tid) || []).map((p) => new PostItem(p, vscode.TreeItemCollapsibleState.None, this.favCache, this.isServerFavourite(p)));
            if (this.loadingTopicsSet.has(tid)) items.push(new BusyItem("正在加载帖子..."));
            else if (this.topicErrors.has(tid)) items.push(new RetryItem(`加载帖子失败：${this.topicErrors.get(tid)}`));
            else if (this.topicHasMore.get(tid) !== false) items.push(new LoadMoreTopicItem(tid));
            else if (items.length === 0) items.push(new TabEmptyItem("暂无帖子"));
            return items;
        }
        if (element instanceof MessageSectionItem) {
            const state = this.messagePages.get(element.section);
            if (!state || (!state.loading && state.entries.length === 0 && state.hasMore)) {
                await this.fetchMessagePage(element.section);
            }
            const current = this.messagePages.get(element.section);
            if (!current || current.entries.length === 0) {
                return [current?.error ? new RetryItem(`加载消息失败：${current.error}`) : new TabEmptyItem("暂无消息")];
            }
            const items: TreeItemBase[] = current.entries.map((entry) => new MessageEntryItem(entry));
            if (current.hasMore) items.push(new LoadMoreMessagesItem(element.section));
            return items;
        }
        return [];
    }

    private getSearchChildren(element?: TreeItemBase): TreeItemBase[] {
        if (!element) {
            const items: TreeItemBase[] = [new BackToTopicsItem(), new SearchHeaderItem(`搜索: ${this.searchQuery}`)];
            if (this.searchLoading) items.push(new BusyItem("搜索中..."));
            else if (this.searchError) items.push(new TabEmptyItem(`搜索失败：${this.searchError}`));
            else if (this.searchResults.length === 0) items.push(new TabEmptyItem("没有找到相关帖子"));
            items.push(...this.searchResults.map((p) => new PostItem(p, vscode.TreeItemCollapsibleState.None, this.favCache, this.isServerFavourite(p))));
            if (this.searchResults.length > 0 && this.searchHasMore) items.push(new LoadMoreSearchItem());
            return items;
        }
        return [];
    }

    /** 获取推荐流帖子，使用 offset 分页追加 */
    private async fetchFeed(): Promise<void> {
        if (this.feedLoading || !this.feedHasMore) return;
        this.feedLoading = true;
        try {
            const result = await this.client.getFeed(this.feedOffset);
            const page = (result.links || []).filter((p) => p && p.linkid);
            const known = new Set(this.feedPosts.map((post) => String(post.linkid)));
            const added = page.filter((post) => {
                const id = String(post.linkid);
                if (known.has(id)) return false;
                known.add(id);
                return true;
            });
            this.feedPosts.push(...added);
            this.feedOffset += page.length;
            this.feedHasMore = page.length > 0 && added.length > 0;
        } catch (e) { this.feedError = (e as Error).message || "未知错误"; }
        finally { this.feedLoading = false; }
        this.fetchFavCounts(this.feedPosts);
    }

    /** 获取板块分类列表（仅加载一次） */
    private async fetchTopics(): Promise<void> {
        if (this.loadingTopics) return;
        this.loadingTopics = true;
        try {
            this.topics = (await this.client.getTopicCategories()).latest_hot_topics?.children || [];
        } catch (e) { this.topicsError = (e as Error).message || "未知错误"; }
        finally { this.loadingTopics = false; }
    }

    /** 懒加载指定板块下的帖子列表，支持分页追加 */
    private async fetchTopicPosts(topicId: number): Promise<void> {
        if (this.loadingTopicsSet.has(topicId) || this.topicHasMore.get(topicId) === false) return;
        this.loadingTopicsSet.add(topicId);
        this.expandedTopics.add(topicId);
        this.saveExpanded();
        try {
            const offset = this.topicOffsets.get(topicId) || 0;
            const result = await this.client.getTopicFeeds(topicId, offset, 30);
            const page = (result.links || []).filter((p) => p && p.linkid);
            const existing = this.topicPosts.get(topicId) || [];
            const known = new Set(existing.map((post) => String(post.linkid)));
            const added = page.filter((post) => {
                const id = String(post.linkid);
                if (known.has(id)) return false;
                known.add(id);
                return true;
            });
            this.topicPosts.set(topicId, existing.concat(added));
            this.topicOffsets.set(topicId, offset + page.length);
            this.topicHasMore.set(topicId, page.length > 0 && added.length > 0 && page.length >= 30);
        } catch (e) { this.topicErrors.set(topicId, (e as Error).message || "未知错误"); }
        finally { this.loadingTopicsSet.delete(topicId); }
        this.fetchFavCounts(this.topicPosts.get(topicId) || []);
    }

    /** 分页读取云端默认收藏夹；网络失败时保留旧版本地缓存作为离线兜底。 */
    private async fetchFavourites(): Promise<void> {
        if (this.favouritesLoading || !this.favouritesHasMore) return;
        this.favouritesLoading = true;
        try {
            const page = await this.client.getFavouriteLinks(this.favouriteOffset, 30);
            const known = new Set(this.favouritePosts.map((post) => post.linkid));
            const added = page.links.filter((post) => !known.has(post.linkid));
            this.favouritePosts.push(...added);
            for (const post of added) this.serverFavouriteIds.add(post.linkid);
            this.favouriteOffset += page.links.length;
            this.favouritesHasMore = page.hasMore && added.length > 0;
            this.favouritesLoaded = true;
            this.fetchFavCounts(added);
        } catch (e) {
            this.favouritesError = (e as Error).message || "未知错误";
        } finally {
            this.favouritesLoading = false;
        }
    }

    private async fetchMessagePage(section: MessageSection): Promise<void> {
        const state = this.messagePages.get(section) || {
            entries: [], offset: 0, cursor: "", hasMore: true, loading: false,
        };
        if (state.loading || !state.hasMore) return;
        state.loading = true;
        this.messagePages.set(section, state);
        try {
            let entries: MessageEntry[] = [];
            let cursor = state.cursor;
            if (section === "official") {
                const result = await this.client.getOfficialMessages(state.offset, 20, state.cursor);
                const messages = result.messages || [];
                entries = messages.map((message, index) => this.toOfficialEntry(message, index));
                cursor = String(result.lastval ?? messages.at(-1)?.timestamp ?? "");
            } else if (section === "discount") {
                const result = await this.client.getDiscountMessages(state.offset, state.cursor);
                const messages = result.msg_list || [];
                entries = messages.map((message, index) => this.toDiscountEntry(message, index));
                cursor = String(result.last_timestamp ?? "");
            } else {
                const result = await this.client.getInteractionMessages(section, state.offset, 20);
                entries = (result.messages || []).map((message, index) => this.toInteractionEntry(section, message, index));
            }
            const known = new Set(state.entries.map((entry) => entry.id));
            const added = entries.filter((entry) => !known.has(entry.id));
            state.entries.push(...added);
            state.offset += entries.length;
            state.cursor = cursor;
            state.hasMore = entries.length === 20 && added.length > 0;
        } catch (e) {
            state.error = (e as Error).message || "未知错误";
            state.hasMore = false;
        } finally {
            state.loading = false;
            this.messagePages.set(section, state);
            this._onDidChangeTreeData.fire();
        }
    }

    private toInteractionEntry(section: MessageSection, message: MessageItem, index: number): MessageEntry {
        const user = message.user_as?.length
            ? `${message.user_as.map((item) => item.nickname || item.username).filter(Boolean).join("、")}等`
            : message.user_a?.nickname || message.user_a?.username || "小黑盒用户";
        const text = String(message.text || message.comment_a_text || "新消息").replace(/\s+/g, " ").trim();
        const linkId = String(message.link?.linkid || message.link_id || message.linkid || "");
        const stamp = Number(message.timestamp || message.create_at || 0) || undefined;
        return {
            id: String(message.message_id || `${section}-${stamp || ""}-${index}-${text}`),
            title: `${user}: ${text || MESSAGE_SECTION_LABELS[section]}`,
            detail: this.formatTime(stamp),
            timestamp: stamp,
            linkId: linkId || undefined,
            unread: this.isUnread(message),
        };
    }

    private toOfficialEntry(message: OfficialMessageItem, index: number): MessageEntry {
        const stamp = Number(message.timestamp || 0) || undefined;
        const title = String(message.title || message.text || "官方消息").replace(/\s+/g, " ").trim();
        const sender = String(message.sender_name || "小黑盒官方");
        return {
            id: String(message.message_id || `official-${stamp || ""}-${index}-${title}`),
            title: `${sender}: ${title}`,
            detail: this.formatTime(stamp),
            timestamp: stamp,
            unread: this.isUnread(message),
        };
    }

    private toDiscountEntry(message: DiscountMessageItem, index: number): MessageEntry {
        const stamp = Number(message.timestamp || 0) || undefined;
        const games = (message.game_list || []).map((game) => game.name).filter(Boolean).join("、");
        const summary = String(message.description || games || "游戏优惠").replace(/\s+/g, " ").trim();
        return {
            id: `discount-${stamp || ""}-${index}-${summary}`,
            title: summary,
            detail: message.datetime || this.formatTime(stamp),
            timestamp: stamp,
            unread: this.isUnread(message),
        };
    }

    /** 接口字段命名不统一；只在明确表示未读时加标识，避免误标历史消息。 */
    private isUnread(message: {
        is_read?: string | number | boolean;
        has_read?: string | number | boolean;
        is_unread?: string | number | boolean;
        unread?: string | number | boolean;
        read_status?: string | number | boolean;
    }): boolean {
        const value = (input: unknown) => String(input ?? "").trim().toLowerCase();
        const isUnread = (input: unknown) => ["1", "true", "yes", "unread"].includes(value(input));
        const isRead = (input: unknown) => ["0", "false", "no", "read"].includes(value(input));
        if (message.is_unread !== undefined) return isUnread(message.is_unread);
        if (message.unread !== undefined) return isUnread(message.unread);
        if (message.is_read !== undefined) return !isRead(message.is_read);
        if (message.has_read !== undefined) return !isRead(message.has_read);
        if (message.read_status !== undefined) return !isRead(message.read_status);
        return false;
    }

    private formatTime(timestamp?: number): string {
        if (!timestamp) return "";
        const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
        return new Date(milliseconds).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    }

    /** 使用列表接口已有的收藏数，避免为列表展示额外请求帖子详情接口。 */
    private async fetchFavCounts(posts: SearchItemInfo[]): Promise<void> {
        for (const post of posts) {
            if (typeof post.favour_count === "number") {
                this.favCache.set(post.linkid, post.favour_count);
            }
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

    /** 加载更多云端收藏。 */
    async loadMoreFavourites(): Promise<void> {
        await this.fetchFavourites();
        this._onDidChangeTreeData.fire();
    }

    /** 加载指定消息分类的下一页。 */
    async loadMoreMessages(section: MessageSection): Promise<void> {
        await this.fetchMessagePage(section);
        this._onDidChangeTreeData.fire();
    }

    /** 收藏操作完成后丢弃服务端缓存并重新读取。 */
    async refreshFavourites(): Promise<void> {
        this.favouritePosts = [];
        this.favouriteOffset = 0;
        this.favouritesLoaded = false;
        this.favouritesHasMore = true;
        this.serverFavouriteIds.clear();
        this.favouritesStateComplete = false;
        if (this.viewMode === "favorites") await this.fetchFavourites();
        this._onDidChangeTreeData.fire();
    }

    /**
     * 在收藏操作前后读取服务端收藏夹，避免把过期本地缓存当作真实状态。
     * 设定页数上限，防止异常账户导致无界请求。
     */
    async synchroniseFavouriteState(): Promise<void> {
        if (this.favouritesSync) return this.favouritesSync;
        this.favouritesSync = (async () => {
            const ids = new Set<number>();
            let offset = 0;
            let hasMore = true;
            for (let page = 0; page < 50 && hasMore; page++) {
                const result = await this.client.getFavouriteLinks(offset, 50);
                for (const post of result.links) ids.add(post.linkid);
                offset += result.links.length;
                hasMore = result.hasMore && result.links.length > 0;
            }
            this.serverFavouriteIds.clear();
            ids.forEach((id) => this.serverFavouriteIds.add(id));
            this.favouritesStateComplete = !hasMore;
            this._onDidChangeTreeData.fire();
        })();
        try { await this.favouritesSync; }
        finally { this.favouritesSync = undefined; }
    }

    /** 收藏入口调用此方法获取服务端状态；无法读到状态时宁可中止也不猜测。 */
    async isFavouritedOnServer(linkId: number): Promise<boolean> {
        if (!this.favouritesStateComplete) await this.synchroniseFavouriteState();
        if (!this.favouritesStateComplete) throw new Error("收藏列表未能完整加载，无法确认服务端收藏状态");
        return this.serverFavouriteIds.has(linkId);
    }

    private isServerFavourite(post: SearchItemInfo): boolean {
        return this.serverFavouriteIds.has(post.linkid);
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

/** 一个紧凑的模式选择入口，避免四个固定导航节点占满列表首屏。 */
export class ModeSelectorItem extends TreeItemBase {
    constructor(mode: ViewMode) {
        const labels: Record<ViewMode, string> = {
            recommend: "推荐",
            categories: "板块",
            favorites: "收藏",
            messages: "消息",
        };
        super(labels[mode], vscode.TreeItemCollapsibleState.None);
        this.description = "切换";
        this.tooltip = `当前列表：${labels[mode]}。点击切换。`;
        this.command = { command: "heybox.selectMode", title: "选择列表模式" };
        this.contextValue = "modeSelector";
        this.iconPath = new vscode.ThemeIcon(mode === "favorites" ? "star" : mode === "messages" ? "bell" : mode === "recommend" ? "flame" : "folder");
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
    constructor(post: SearchItemInfo, collapsibleState: vscode.TreeItemCollapsibleState, favCache?: Map<number, number>, favourited = false) {
        const label = post.title || post.description?.substring(0, 40) || "无标题";
        super(label, collapsibleState);
        this.post = post;
        const fav = favCache?.get(post.linkid);
        const minimal = vscode.workspace.getConfiguration("heybox").get<boolean>("minimalMode", false);
        if (!minimal) this.description = fav !== undefined ? `⭐${fav} 💬${post.comment_num}` : `💬${post.comment_num}`;
        this.tooltip = new vscode.MarkdownString(`**${label}**\n\n${post.description?.substring(0, 100) || ""}\n\n${favourited ? "已收藏 | " : ""}${fav !== undefined ? '收藏: ' + fav + ' | ' : ''}评论: ${post.comment_num}\n话题: ${post.topics?.map((t) => t.name).join(", ") || "无"}`);
        this.command = { command: "heybox.openPost", title: "打开帖子", arguments: [post] };
        this.contextValue = "post";
        this.iconPath = minimal ? new vscode.ThemeIcon("file") : new vscode.ThemeIcon(favourited ? "star-full" : "comment-discussion");
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

/** 区域内失败反馈；点击只刷新当前原生视图，不再依赖通知弹窗。 */
export class RetryItem extends TreeItemBase {
    constructor(message: string) {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.command = { command: "heybox.refreshList", title: "重试加载" };
        this.contextValue = "retry";
        this.iconPath = new vscode.ThemeIcon("refresh");
        this.tooltip = "点击重试";
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

/** 收藏页的分页入口。 */
export class LoadMoreFavouritesItem extends TreeItemBase {
    constructor() {
        super("加载更多收藏...", vscode.TreeItemCollapsibleState.None);
        this.command = { command: "heybox.loadMoreFavourites", title: "加载更多收藏" };
        this.contextValue = "loadMoreFavourites";
        this.iconPath = new vscode.ThemeIcon("more-horizontal");
    }
}

const MESSAGE_SECTIONS: MessageSection[] = ["comment", "award", "follow", "mention", "official", "discount"];
const MESSAGE_SECTION_LABELS: Record<MessageSection, string> = {
    comment: "评论与回复",
    award: "获赞",
    follow: "关注",
    mention: "@我",
    official: "官方消息",
    discount: "游戏优惠",
};

/** 消息中心中可按需展开的一类消息。 */
export class MessageSectionItem extends TreeItemBase {
    constructor(public readonly section: MessageSection) {
        super(MESSAGE_SECTION_LABELS[section], vscode.TreeItemCollapsibleState.Collapsed);
        this.description = section === "discount" ? "已关注游戏" : "";
        this.contextValue = "messageSection";
        this.iconPath = new vscode.ThemeIcon(section === "official" ? "megaphone" : section === "discount" ? "tag" : "bell");
    }
}

/** 单条只读消息；互动消息可直接跳转关联帖子。 */
export class MessageEntryItem extends TreeItemBase {
    constructor(entry: MessageEntry) {
        super(entry.title, vscode.TreeItemCollapsibleState.None);
        this.description = entry.unread ? `● 未读${entry.detail ? ` · ${entry.detail}` : ""}` : entry.detail;
        this.tooltip = entry.unread ? `${entry.title}\n未读${entry.detail ? ` · ${entry.detail}` : ""}` : (entry.detail ? `${entry.title}\n${entry.detail}` : entry.title);
        this.contextValue = "message";
        this.iconPath = new vscode.ThemeIcon(entry.unread ? "mail-unread" : "mail");
        if (entry.linkId) {
            this.command = {
                command: "heybox.openPost",
                title: "打开关联帖子",
                arguments: [{ linkid: Number(entry.linkId) }],
            };
        }
    }
}

/** 消息分类的分页入口。 */
export class LoadMoreMessagesItem extends TreeItemBase {
    constructor(section: MessageSection) {
        super("加载更多消息...", vscode.TreeItemCollapsibleState.None);
        this.command = { command: "heybox.loadMoreMessages", title: "加载更多消息", arguments: [section] };
        this.contextValue = "loadMoreMessages";
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
