/**
 * 小黑盒 VSCode 扩展入口
 *
 * 提供以下功能：
 * - 帖子列表浏览与搜索
 * - 帖子详情查看（侧边栏 / 面板）
 * - 消息通知
 * - 消息轮询提醒
 * - 收藏管理
 * - Cookie 登录管理
 * - 隐身模式
 */
import * as vscode from "vscode";
import * as crypto from "crypto";
import { HeyBoxClient } from "./api/client";
import { isAuthenticationError, isCaptchaError } from "./api/errors";
import { PostListProvider } from "./providers/postListProvider";
import { PostDetailViewProvider } from "./providers/postDetailProvider";
import { SearchItemInfo, PostTreeResult } from "./types";
import { postHtml } from "./utils/htmlRenderer";
import { getReadState } from "./utils/messageState";

let postDetailProvider: PostDetailViewProvider | undefined;
let postListProvider: PostListProvider | undefined;
let activeClient: HeyBoxClient | undefined;
let currentPanel: vscode.WebviewPanel | undefined;
let currentPanelPost: PostTreeResult | undefined;
let currentPanelFoldedTips = "";
let originalImagePanel: vscode.WebviewPanel | undefined;
/** 浏览历史最大条数 */
const MAX_HISTORY = 50;
const READING_HISTORY_KEY = "heybox.readingHistory";
const READ_POSITION_KEY = "heybox.readPositions";
const NOTIFICATION_ENABLED_KEY = "heybox.notificationsEnabled";
const NOTIFICATION_SECTIONS_KEY = "heybox.notificationSections";
/** 消息轮询定时器 */
let pollTimer: ReturnType<typeof setInterval> | undefined;
/** 已读消息 ID 集合，用于去重 */
let lastSeenIds = new Set<string>();
/** 只有最后一次打开帖子的异步响应可以更新详情视图。 */
let postRequestGeneration = 0;
/** 防止定时器与手动触发的通知检查重入。 */
let pollInFlight = false;
/** 登录/退出切换后，用于丢弃旧账号的迟到通知结果。 */
let accountGeneration = 0;
/** 每次启停提醒都会换代，避免关闭后的迟到请求重新点亮状态栏。 */
let pollSessionGeneration = 0;
/** 当前会话的帖子导航栈；历史列表本身持久化在 globalState。 */
let navigationEntries: string[] = [];
let navigationIndex = -1;
/** 避免收藏按钮和树右键在同一次写入期间重复提交。 */
const favouriteInFlight = new Set<string>();

interface ReadingHistoryEntry {
    id: string;
    title: string;
    readAt: number;
}

/** 轮询时统一处理的只读通知条目。 */
interface PolledNotification {
    id: string;
    title: string;
    detail: string;
    linkId?: string;
    timestamp?: number;
    readState: "unread" | "read" | "unknown";
    section: NotificationSection;
}

type NotificationSection = "comment" | "award" | "follow" | "mention" | "official" | "discount";
const NOTIFICATION_SECTION_LABELS: Record<NotificationSection, string> = {
    comment: "评论与回复", award: "获赞", follow: "关注", mention: "@我", official: "官方消息", discount: "游戏优惠",
};

function notificationTimestamp(value: number | undefined): number | undefined {
    if (!value || !Number.isFinite(value)) return undefined;
    return value < 10_000_000_000 ? value * 1000 : value;
}

/**
 * 扩展激活入口 — 当用户首次使用或打开工作区时由 VSCode 调用
 *
 * 初始化 API 客户端、注册视图与命令、检查 Cookie、启动消息轮询
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // 初始化 API 客户端并加载配置
    const client = new HeyBoxClient(context);
    activeClient = client;
    await client.loadConfig();
    postListProvider = new PostListProvider(client);
    postListProvider.setContext(context);

    // 创建帖子列表树视图
    const treeView = vscode.window.createTreeView("heybox.postList", {
        treeDataProvider: postListProvider, showCollapseAll: true,
    });
    postListProvider.setTreeView(treeView);
    context.subscriptions.push(treeView);

    // 注册帖子详情 Webview 视图
    postDetailProvider = new PostDetailViewProvider(context.extensionUri, (id, rootId) => {
        if (rootId) {
            const post = postDetailProvider?.getCurrentPost();
            if (post && String(post.link.linkid) === id) {
                void loadRepliesForPost(client, post, id, rootId, (updated, note) => {
                    if (postDetailProvider?.getCurrentPost() === post) {
                        postDetailProvider.showPost(updated, note, postDetailProvider.getFoldedTips(), getReadPosition(context, id));
                    }
                });
            }
        } else {
            const post = postDetailProvider?.getCurrentPost();
            if (post && String(post.link.linkid) === id) {
                void loadMoreCommentsForPost(client, post, id, (updated, note) => {
                    if (postDetailProvider?.getCurrentPost() === post) postDetailProvider.showPost(updated, note, postDetailProvider.getFoldedTips(), getReadPosition(context, id));
                });
            }
        }
    }, (url) => client.getOriginalImageUrl(url), openOriginalImagePreview, (action, post) => {
        if (action === "goBack" || action === "goForward") void vscode.commands.executeCommand(`heybox.${action}`);
        else return handleDetailAction(action, post);
    }, (linkId, position) => saveReadPosition(context, linkId, position));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(PostDetailViewProvider.viewType, postDetailProvider));

    // 应用隐身模式设置
    applyStealthMode();

    // 状态栏消息提醒按钮
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBarItem.command = "heybox.openMessages";
    statusBarItem.tooltip = "小黑盒消息（点击查看）";
    updateStatusBar(statusBarItem, 0, false);
    context.subscriptions.push(statusBarItem);

    // 检查 Cookie 是否已配置，未配置则弹窗提示
    checkCookieAndPrompt(context, client);

    // ─── 命令注册 ───
    context.subscriptions.push(vscode.commands.registerCommand("heybox.openMessages", () => postListProvider!.switchTo("messages")));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.loginCompleted", () => undefined));

    // 刷新帖子列表，重新加载配置
    context.subscriptions.push(vscode.commands.registerCommand("heybox.refreshList", async () => { await client.loadConfig(); postListProvider!.refresh(); }));

    // 搜索帖子 — 弹出输入框输入关键词，执行搜索
    context.subscriptions.push(vscode.commands.registerCommand("heybox.searchPost", async () => {
        const q = await vscode.window.showInputBox({
            prompt: "搜索帖子",
            placeHolder: "输入关键词",
            value: postListProvider!.isSearchMode ? postListProvider!.getSearchQuery() : "",
            ignoreFocusOut: true,
        });
        if (q?.trim()) {
            const query = q.trim();
            await postListProvider!.performSearch(query);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("heybox.showReadingHistory", async () => {
        const entries = getReadingHistory(context);
        const picked = await vscode.window.showQuickPick(entries.map((entry) => ({
            label: entry.title || "无标题",
            description: new Date(entry.readAt).toLocaleString("zh-CN"),
            id: entry.id,
        })), { placeHolder: "阅读历史" });
        if (picked) await openAndShowPost(context, client, picked.id);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("heybox.continueReading", async () => {
        const id = context.globalState.get<number>("heybox.lastPostId");
        if (!id) { vscode.window.showInformationMessage("暂无可继续阅读的帖子"); return; }
        await openAndShowPost(context, client, String(id));
    }));

    context.subscriptions.push(vscode.commands.registerCommand("heybox.goBack", async () => {
        if (navigationIndex <= 0) { vscode.window.setStatusBarMessage("没有更早浏览的帖子", 1800); return; }
        navigationIndex--;
        await openAndShowPost(context, client, navigationEntries[navigationIndex], false, undefined, "restore");
    }));

    context.subscriptions.push(vscode.commands.registerCommand("heybox.goForward", async () => {
        if (navigationIndex < 0 || navigationIndex >= navigationEntries.length - 1) { vscode.window.setStatusBarMessage("没有下一篇帖子", 1800); return; }
        navigationIndex++;
        await openAndShowPost(context, client, navigationEntries[navigationIndex], false, undefined, "restore");
    }));

    // 退出搜索模式，恢复默认视图
    context.subscriptions.push(vscode.commands.registerCommand("heybox.exitSearch", () => { postListProvider!.exitSearch(); postListProvider!.refresh(); }));

    // 切换到推荐视图
    context.subscriptions.push(vscode.commands.registerCommand("heybox.switchToRecommend", () => postListProvider!.switchTo("recommend")));

    // 切换到分类视图
    context.subscriptions.push(vscode.commands.registerCommand("heybox.switchToCategories", () => postListProvider!.switchTo("categories")));

    // 切换到收藏视图
    context.subscriptions.push(vscode.commands.registerCommand("heybox.switchToFavorites", () => postListProvider!.switchTo("favorites")));

    // 切换到消息中心
    context.subscriptions.push(vscode.commands.registerCommand("heybox.switchToMessages", () => postListProvider!.switchTo("messages")));

    // 原生 TreeView 使用一个入口切换模式，避免四个固定节点挤占侧边栏首屏。
    context.subscriptions.push(vscode.commands.registerCommand("heybox.selectMode", async () => {
        const current = postListProvider!.getViewMode();
        const picked = await vscode.window.showQuickPick([
            { label: "$(flame) 推荐", value: "recommend", description: current === "recommend" ? "当前" : "" },
            { label: "$(folder) 板块", value: "categories", description: current === "categories" ? "当前" : "" },
            { label: "$(star) 收藏", value: "favorites", description: current === "favorites" ? "当前" : "" },
            { label: "$(bell) 消息", value: "messages", description: current === "messages" ? "当前" : "" },
        ], { placeHolder: "选择列表模式" });
        if (picked) postListProvider!.switchTo(picked.value as "recommend" | "categories" | "favorites" | "messages");
    }));

    // 账号和阅读设置收进一个轻量菜单，工具栏保持搜索、刷新和菜单三个入口。
    context.subscriptions.push(vscode.commands.registerCommand("heybox.showMenu", async () => {
        const loggedIn = !!client.getCookie();
        const choices: Array<{ label: string; command: string }> = [
            { label: "$(list-selection) 切换列表模式", command: "heybox.selectMode" },
            { label: "$(history) 阅读历史", command: "heybox.showReadingHistory" },
            { label: "$(symbol-color) 阅读主题", command: "heybox.switchTheme" },
            { label: "$(settings-gear) 打开设置", command: "workbench.action.openSettings" },
        ];
        if (loggedIn) {
            choices.splice(1, 0,
                { label: "$(bell) 消息提醒", command: "heybox.toggleNotifications" },
                { label: "$(settings-gear) 消息提醒分类", command: "heybox.configureNotifications" },
                { label: "$(sign-out) 退出登录", command: "heybox.logout" },
            );
        } else {
            choices.splice(1, 0, { label: "$(sign-in) 登录", command: "heybox.login" });
        }
        const picked = await vscode.window.showQuickPick(choices, { placeHolder: "HeyBox 菜单" });
        if (picked) await vscode.commands.executeCommand(picked.command, picked.command === "workbench.action.openSettings" ? "heybox" : undefined);
    }));

    // 加载更多搜索结果
    context.subscriptions.push(vscode.commands.registerCommand("heybox.loadMoreSearch", async () => postListProvider!.loadMoreSearch()));

    // 加载更多帖子（按分类类型）
    context.subscriptions.push(vscode.commands.registerCommand("heybox.loadMore", async (t: number) => postListProvider!.loadMorePosts(t)));

    // 加载更多 Feed
    context.subscriptions.push(vscode.commands.registerCommand("heybox.loadMoreFeed", async () => postListProvider!.loadMoreFeed()));

    // 加载更多云端收藏或某一类消息
    context.subscriptions.push(vscode.commands.registerCommand("heybox.loadMoreFavourites", async () => postListProvider!.loadMoreFavourites()));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.loadMoreMessages", async (section: "comment" | "award" | "follow" | "mention" | "official" | "discount") => postListProvider!.loadMoreMessages(section)));

    // 开启/关闭消息提醒 — 切换轮询状态
    context.subscriptions.push(vscode.commands.registerCommand("heybox.toggleNotifications", async () => {
        if (pollTimer) {
            pollSessionGeneration++;
            clearInterval(pollTimer);
            pollTimer = undefined;
            await context.globalState.update(NOTIFICATION_ENABLED_KEY, false);
            updateStatusBar(statusBarItem, 0, false);
            vscode.window.showInformationMessage("小黑盒消息提醒已关闭");
        } else {
            await context.globalState.update(NOTIFICATION_ENABLED_KEY, true);
            startPolling(client, statusBarItem, context);
            vscode.window.showInformationMessage("小黑盒消息提醒已开启 (每3分钟检查)");
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("heybox.configureNotifications", async () => {
        const selected = new Set(getNotificationSections(context));
        const picked = await vscode.window.showQuickPick(
            (Object.keys(NOTIFICATION_SECTION_LABELS) as NotificationSection[]).map((section) => ({
                label: NOTIFICATION_SECTION_LABELS[section], section, picked: selected.has(section),
            })),
            { canPickMany: true, placeHolder: "选择需要提醒的消息分类（可随时修改）" },
        );
        if (!picked) return;
        await context.globalState.update(NOTIFICATION_SECTIONS_KEY, picked.map((item) => item.section));
        vscode.window.showInformationMessage(picked.length ? `已订阅 ${picked.length} 类消息提醒` : "已取消所有消息分类订阅");
    }));

    // 已读状态由服务端维护；未知写入接口时不再伪造本地“已读”，避免下一轮把未读消息重新弹出。
    context.subscriptions.push(vscode.commands.registerCommand("heybox.markAllRead", async () => {
        vscode.window.showInformationMessage("已读状态以小黑盒服务端为准，请在小黑盒客户端中标记已读。");
    }));

    // 已登录时自动启动消息轮询
    if (client.getCookie() && notificationsEnabled(context)) startPolling(client, statusBarItem, context);

    // 打开帖子详情
    context.subscriptions.push(vscode.commands.registerCommand("heybox.openPost", async (post: SearchItemInfo) => {
        if (!post?.linkid) return;
        postListProvider!.saveLastPost(post.linkid);
        await openAndShowPost(context, client, String(post.linkid));
    }));

    // 通过 URL 打开帖子 — 从输入框解析帖子 ID
    context.subscriptions.push(vscode.commands.registerCommand("heybox.openByUrl", async () => {
        const url = await vscode.window.showInputBox({ prompt: "输入帖子URL", placeHolder: "https://www.xiaoheihe.cn/app/bbs/link/xxxxx" });
        if (!url) return;
        const m = url.match(/\/link\/([a-zA-Z0-9]+)/);
        if (!m) { vscode.window.showErrorMessage("无法解析帖子ID"); return; }
        await openAndShowPost(context, client, m[1]);
    }));

    // 在浏览器中打开帖子
    context.subscriptions.push(vscode.commands.registerCommand("heybox.openInBrowser", async (item: any) => {
        const post = item?.post || item;
        if (!post?.linkid) return;
        vscode.env.openExternal(vscode.Uri.parse(`https://www.xiaoheihe.cn/app/bbs/link/${post.linkid}`));
    }));

    // 收藏状态以服务端收藏夹为准。/favour 是切换型写接口，不做自动重试，
    // 且同一帖子写入期间拒绝重复点击。
    context.subscriptions.push(vscode.commands.registerCommand("heybox.toggleFavourite", async (item: any) => {
        const post = item?.post || item;
        if (!post?.linkid) return;
        const linkId = String(post.linkid);
        if (favouriteInFlight.has(linkId)) {
            vscode.window.setStatusBarMessage("收藏操作正在提交，请稍候", 1800);
            return;
        }
        favouriteInFlight.add(linkId);
        try {
            const wasFav = await postListProvider!.isFavouritedOnServer(linkId);
            await client.favouritePost(linkId);
            // /favour 是切换型接口。已确认的写入前状态可推导预期结果，
            // 因此无需再次扫描整个收藏夹。
            const isFav = !wasFav;
            postListProvider!.applyFavouriteToggle(linkId, isFav);
            vscode.window.showInformationMessage(isFav ? "已收藏（服务端已同步）" : "已取消收藏（服务端已同步）");
        } catch (error) {
            const message = error instanceof Error ? error.message : "未知错误";
            vscode.window.showErrorMessage(`收藏失败: ${message}`);
        } finally {
            favouriteInFlight.delete(linkId);
        }
        postListProvider!.switchTo(postListProvider!.getViewMode());
    }));

    // 切换侧边栏显示
    context.subscriptions.push(vscode.commands.registerCommand("heybox.toggleSidebar", async () => {
        await vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
    }));

    // 登录命令 — 默认使用手机扫码，手动 Cookie 仅作为兼容兜底。
    context.subscriptions.push(vscode.commands.registerCommand("heybox.login", async () => {
        // 扫码功能的 qrcode 依赖只在用户登录时加载。这样即使发行包意外漏掉
        // 该可选界面依赖，也不会阻止扩展完成激活及注册其它命令。
        const { showQrLoginPanel } = await import("./auth/qrLoginPanel");
        await showQrLoginPanel(
            context,
            client,
            async (nickname) => onLoginSuccess(client, context, statusBarItem, nickname),
            async () => loginByPaste(client, context, statusBarItem),
        );
    }));

    // 退出登录 — 清除 Cookie 并停止轮询
    context.subscriptions.push(vscode.commands.registerCommand("heybox.logout", async () => {
        const confirmed = await vscode.window.showWarningMessage(
            "确定要退出登录？",
            "确定", "取消"
        );
        if (confirmed === "确定") {
            accountGeneration++;
            postRequestGeneration++;
            pollSessionGeneration++;
            lastSeenIds.clear();
            await client.clearCookie();
            vscode.window.showInformationMessage("已退出登录");
            postListProvider!.refresh();
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = undefined;
                updateStatusBar(statusBarItem, 0, false);
            }
        }
    }));

    // 切换 Webview 主题（跟随 VSCode / 暗色 / 亮色）
    context.subscriptions.push(vscode.commands.registerCommand("heybox.switchTheme", async () => {
        const current = vscode.workspace.getConfiguration("heybox").get<string>("theme", "auto");
        const picked = await vscode.window.showQuickPick([
            { label: "跟随 VSCode", value: "auto", description: current === "auto" ? "当前" : "" },
            { label: "暗色主题", value: "dark", description: current === "dark" ? "当前" : "" },
            { label: "亮色主题", value: "light", description: current === "light" ? "当前" : "" }
        ], { placeHolder: "选择 Webview 主题" });
        if (picked) {
            await vscode.workspace.getConfiguration("heybox").update("theme", picked.value, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`主题已切换为: ${picked.label}`);
        }
    }));

    // 从剪贴板打开帖子链接
    context.subscriptions.push(vscode.commands.registerCommand("heybox.openClipboardUrl", async () => {
        const clip = await vscode.env.clipboard.readText();
        const m = clip.match(/\/link\/([a-zA-Z0-9]+)/);
        if (!m) { vscode.window.showErrorMessage("剪贴板中未找到帖子链接"); return; }
        await openAndShowPost(context, client, m[1]);
    }));

    // 监听配置变更，自动刷新并重新应用设置
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration("heybox")) {
            await client.loadConfig();
            applyStealthMode();
            postListProvider!.refresh();
            refreshOpenPostDetails();
        }
    }));
}

/**
 * 打开并展示帖子详情
 *
 * @param context - 扩展上下文，用于读写全局状态（浏览历史）
 * @param client  - API 客户端
 * @param linkId  - 帖子 ID
 */
/** 仅为当前评论组追加子回复，避免重新请求整帖后覆盖已加载的数据。 */
async function loadRepliesForPost(
    client: HeyBoxClient,
    post: PostTreeResult,
    linkId: string,
    rootId: string,
    render: (post: PostTreeResult, note?: string) => void,
): Promise<void> {
    if (!post || String(post.link.linkid) !== linkId) return;
    const group = post.comments?.find(g => String(g.comment?.[0]?.commentid) === rootId);
    if (!group?.comment?.[0]) return;

    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "加载回复中...", cancellable: false }, async () => {
            const known = new Set(group.comment.map(c => String(c.commentid)));
            let lastval = String(group.comment.at(-1)?.commentid || "");
            for (let pageNo = 0; pageNo < 20; pageNo++) {
                const page = await client.getSubComments(rootId, lastval);
                if (!page.comments.length) break;
                let added = 0;
                for (const comment of page.comments) {
                    if (!known.has(String(comment.commentid))) {
                        known.add(String(comment.commentid));
                        group.comment.push(comment);
                        added++;
                    }
                }
                if (!added || !page.lastval || page.lastval === lastval) break;
                lastval = page.lastval;
            }
        });
        const total = post.link.comment_num || 0;
        const shown = post.comments.reduce((sum, g) => sum + (g.comment?.length || 0), 0);
        render(post, shown >= total ? undefined : `共 ${total} 条评论，当前显示 ${shown} 条`);
    } catch (e) {
        vscode.window.showErrorMessage(`加载回复失败: ${(e as Error).message || "未知错误"}`);
        render(post, `加载回复失败：${(e as Error).message || "未知错误"}，请重试`);
    }
}

/** 追加下一页顶层评论。 */
async function loadMoreCommentsForPost(
    client: HeyBoxClient,
    post: PostTreeResult,
    linkId: string,
    render: (post: PostTreeResult, note?: string) => void,
): Promise<void> {
    if (String(post.link.linkid) !== linkId || Number(post.has_more_floors) === 0) return;
    try {
        const offset = post.comments?.length || 0;
        const page = await client.getPostTree(linkId, offset, 20);
        const known = new Set((post.comments || []).map((group) => String(group.comment?.[0]?.commentid || "")));
        const added = (page.comments || []).filter((group) => {
            const id = String(group.comment?.[0]?.commentid || "");
            if (!id || known.has(id)) return false;
            known.add(id);
            return true;
        });
        if (String(post.link.linkid) !== linkId) return;
        post.comments = [...(post.comments || []), ...added];
        post.has_more_floors = page.has_more_floors;
        const shown = post.comments.reduce((sum, group) => sum + (group.comment?.length || 0), 0);
        const total = post.link.comment_num || 0;
        render(post, Number(post.has_more_floors) === 0 ? undefined : `共 ${total} 条评论，当前显示 ${shown} 条`);
    } catch (error) {
        vscode.window.showErrorMessage(`加载更多评论失败: ${(error as Error).message || "未知错误"}`);
        render(post, `加载更多评论失败：${(error as Error).message || "未知错误"}，请重试`);
    }
}

function getReadingHistory(context: vscode.ExtensionContext): ReadingHistoryEntry[] {
    const stored = context.globalState.get<ReadingHistoryEntry[]>(READING_HISTORY_KEY, []);
    // 兼容旧版以“标题\0id”存储的 history，迁移后不再依赖不可解析的字符串。
    if (stored.length > 0) return stored.filter((entry) => entry?.id);
    const legacy = context.globalState.get<string[]>("history", []);
    return legacy.map((value) => {
        const separator = value.lastIndexOf("\x00");
        return separator >= 0
            ? { title: value.slice(0, separator), id: value.slice(separator + 1), readAt: 0 }
            : { title: value, id: "", readAt: 0 };
    }).filter((entry) => entry.id);
}

function saveReadingHistory(context: vscode.ExtensionContext, id: string, title: string): void {
    const updated = getReadingHistory(context).filter((entry) => entry.id !== id);
    updated.unshift({ id, title, readAt: Date.now() });
    void context.globalState.update(READING_HISTORY_KEY, updated.slice(0, MAX_HISTORY));
}

function getReadPosition(context: vscode.ExtensionContext, linkId: string): number {
    const positions = context.globalState.get<Record<string, number>>(READ_POSITION_KEY, {});
    const value = positions[linkId];
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function saveReadPosition(context: vscode.ExtensionContext, linkId: string, position: number): void {
    if (!Number.isFinite(position) || position < 0) return;
    const positions = context.globalState.get<Record<string, number>>(READ_POSITION_KEY, {});
    positions[linkId] = Math.floor(position);
    // 只保留近期阅读帖子的进度，避免状态无限增长。
    const recentIds = new Set(getReadingHistory(context).map((entry) => entry.id));
    for (const id of Object.keys(positions)) if (!recentIds.has(id)) delete positions[id];
    void context.globalState.update(READ_POSITION_KEY, positions);
}

function recordNavigation(linkId: string): void {
    if (navigationEntries[navigationIndex] === linkId) return;
    navigationEntries = navigationEntries.slice(0, navigationIndex + 1);
    navigationEntries.push(linkId);
    if (navigationEntries.length > MAX_HISTORY) navigationEntries.shift();
    navigationIndex = navigationEntries.length - 1;
}

async function openAndShowPost(
    context: vscode.ExtensionContext,
    client: HeyBoxClient,
    linkId: string,
    loadAll = false,
    rootId?: string,
    navigation: "push" | "restore" = "push",
): Promise<void> {
    const requestGeneration = ++postRequestGeneration;
    const requestAccountGeneration = accountGeneration;
    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "加载帖子中...", cancellable: false }, async () => {
            const tree = await client.getPostTree(linkId, 0, loadAll ? 100 : 20);
            if (requestGeneration !== postRequestGeneration || requestAccountGeneration !== accountGeneration) return;
            if (!tree || !tree.link) { vscode.window.showWarningMessage("未获取到帖子内容"); return; }

            saveReadingHistory(context, linkId, tree.link.title || "无标题");
            void context.globalState.update("heybox.lastPostId", Number(linkId));
            if (navigation === "push") recordNavigation(linkId);

            const totalCommentNum = tree.link.comment_num || 0;
            const allCommentGroups = tree.comments || [];
            const foldedTips = (tree as any)?.folded_comment_tips || "";

            // 不要在打开帖子后立即尝试多个排序。link/tree 是风控敏感接口，
            // 一次打开产生 4 次重复请求很容易被判定为自动化流量。
            // 默认响应已经包含首屏评论，后续仅按需做分页。
            // 只展示 link/tree 返回的首屏评论。此前这里会串行分页全部评论，
            // 再逐组请求子评论；帖子内容已经拿到后仍需等待大量请求，明显拖慢点击。
            // 后续如需完整评论，可由详情页单独触发加载。
            let stoppedByEmpty = false;
            if (rootId) {
                const group = allCommentGroups.find(g => g.comment?.[0]?.commentid === rootId);
                if (group?.comment?.[0]) {
                    let last = group.comment.at(-1)?.commentid || "";
                    for (let i = 0; i < 20; i++) {
                        const page = await client.getSubComments(rootId, last);
                        if (!page.comments.length) break;
                        group.comment.push(...page.comments);
                        if (!page.lastval || page.lastval === last) break;
                        last = page.lastval;
                    }
                }
            }
            if (loadAll && totalCommentNum > allCommentGroups.length) {
                let offset = allCommentGroups.length;
                while (offset < totalCommentNum) {
                    const page = await client.getPostTree(linkId, offset, 100);
                    if (!page.comments?.length) { stoppedByEmpty = true; break; }
                    allCommentGroups.push(...page.comments);
                    offset += page.comments.length;
                }
            }

            // 组装完整帖子树，根据设置选择在侧边栏或面板中展示
            const fullTree: PostTreeResult = { ...tree, comments: allCommentGroups };
            const location = vscode.workspace.getConfiguration("heybox").get<string>("postDetailLocation", "sidebar");
            const stealth = isStealthMode();
            const loadedCount = allCommentGroups.reduce((sum, g) => sum + (g.comment?.length || 0), 0);
            const commentNote = (stoppedByEmpty || loadedCount >= totalCommentNum)
                ? undefined
                : `共 ${totalCommentNum} 条评论，当前显示 ${loadedCount} 条`;

            if (location === "sidebar" && postDetailProvider) {
                if (requestGeneration !== postRequestGeneration || requestAccountGeneration !== accountGeneration) return;
                postDetailProvider.showPost(fullTree, commentNote, foldedTips, getReadPosition(context, linkId));
                if (!postDetailProvider.isViewVisible()) {
                    vscode.window.showInformationMessage("帖子已加载，请在侧边栏点击「帖子详情」查看");
                }
            } else {
                if (requestGeneration !== postRequestGeneration || requestAccountGeneration !== accountGeneration) return;
                if (currentPanel) currentPanel.dispose();
                const col = location === "beside" ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
                const panel = vscode.window.createWebviewPanel("heybox.postDetailPanel", stealth ? "README.md" : "帖子", col, { enableScripts: true });
                currentPanel = panel;
                currentPanelPost = fullTree;
                currentPanelFoldedTips = foldedTips;
                panel.webview.onDidReceiveMessage((msg) => {
                    if (msg?.command === "loadOriginalImage" && isSupportedImageUrl(msg.url)) {
                        void loadOriginalImage(client, panel.webview, msg.url);
                        return;
                    }
                    if (["copyLink", "openInBrowser", "toggleFavourite"].includes(msg?.command) && currentPanelPost) {
                        void handleDetailAction(msg.command, currentPanelPost).then(
                            () => panel.webview.postMessage({ command: "actionResult", action: msg.command, success: true }),
                            (error) => panel.webview.postMessage({ command: "actionResult", action: msg.command, success: false, message: error instanceof Error ? error.message : "操作失败" }),
                        );
                        return;
                    }
                    if (msg?.command === "goBack" || msg?.command === "goForward") {
                        void vscode.commands.executeCommand(`heybox.${msg.command}`);
                        return;
                    }
                    if (msg?.command === "saveReadPosition" && String(msg.linkId) === String(currentPanelPost?.link.linkid)
                        && Number.isFinite(msg.position) && msg.position >= 0) {
                        saveReadPosition(context, String(msg.linkId), Math.floor(msg.position));
                        return;
                    }
                    if ((msg?.command !== "loadReplies" && msg?.command !== "loadMoreComments") || typeof msg.linkId !== "string") return;
                    if (currentPanel !== panel || !currentPanelPost) return;
                    const postAtRequest = currentPanelPost;
                    const render = (updated: PostTreeResult, note?: string) => {
                        if (currentPanel !== panel) return;
                        if (currentPanelPost !== postAtRequest) return;
                        currentPanelPost = updated;
                        panel.webview.html = postHtml(updated, isStealthMode(), note, currentPanelFoldedTips, getReadPosition(context, linkId));
                    };
                    if (msg.command === "loadReplies" && typeof msg.rootId === "string") void loadRepliesForPost(client, postAtRequest, msg.linkId, msg.rootId, render);
                    else if (msg.command === "loadMoreComments") void loadMoreCommentsForPost(client, postAtRequest, msg.linkId, render);
                });
                panel.webview.html = postHtml(fullTree, stealth, commentNote, foldedTips, getReadPosition(context, linkId));
                panel.onDidDispose(() => {
                    if (currentPanel === panel) {
                        currentPanel = undefined;
                        currentPanelPost = undefined;
                        currentPanelFoldedTips = "";
                    }
                });
            }
        });
    } catch (e) {
        if (requestGeneration !== postRequestGeneration || requestAccountGeneration !== accountGeneration) return;
        if (isCaptchaError(e)) {
            vscode.window.showErrorMessage(
                "帖子详情被服务端风控拦截，请在浏览器中完成人机验证后重新扫码登录。",
            );
        } else {
            const message = e instanceof Error ? e.message : "未知错误";
            vscode.window.showErrorMessage(`获取帖子详情失败: ${message}`);
        }
    }
}

/** 处理详情页工具栏动作；同一逻辑同时服务侧边栏 Webview 与编辑区 Webview。 */
async function handleDetailAction(action: string, post: PostTreeResult): Promise<void> {
    const url = `https://www.xiaoheihe.cn/app/bbs/link/${post.link.linkid}`;
    if (action === "copyLink") {
        await vscode.env.clipboard.writeText(url);
        void vscode.window.setStatusBarMessage("小黑盒帖子链接已复制", 2000);
        return;
    }
    if (action === "openInBrowser") {
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
    }
    if (action === "toggleFavourite") {
        const item: SearchItemInfo = {
            linkid: post.link.linkid,
            userid: post.link.user.userid,
            title: post.link.title,
            description: post.link.description,
            link_type: post.link.link_type,
            link_tag: post.link.link_tag,
            is_web: 1,
            comment_num: post.link.comment_num,
            favour_count: post.link.favour_count,
            create_at: post.link.create_at,
            modify_at: post.link.modify_at,
            share_url: post.link.share_url,
            up: post.link.up,
            down: post.link.down,
            topics: post.link.topics,
            has_video: post.link.has_video || 0,
        };
        await vscode.commands.executeCommand("heybox.toggleFavourite", item);
    }
}

async function loadOriginalImage(client: HeyBoxClient, webview: vscode.Webview, imageUrl: string): Promise<void> {
    try {
        const originalUrl = await client.getOriginalImageUrl(imageUrl);
        openOriginalImagePreview(originalUrl);
        await webview.postMessage({ command: "originalImageOpened" });
    } catch (error) {
        const message = error instanceof Error ? error.message : "未知错误";
        await webview.postMessage({ command: "originalImageError", message });
    }
}

function refreshOpenPostDetails(): void {
    postDetailProvider?.refreshCurrentPost();
    if (currentPanel && currentPanelPost) {
        currentPanel.title = isStealthMode() ? "README.md" : (currentPanelPost.link.title || "帖子");
        currentPanel.webview.html = postHtml(currentPanelPost, isStealthMode(), undefined, currentPanelFoldedTips);
    }
}

/** 原图仅在用户主动请求时打开编辑区预览，避免普通浏览占用主编辑区。 */
function openOriginalImagePreview(url: string): void {
    if (!isSupportedImageUrl(url)) return;
    if (!originalImagePanel) {
        originalImagePanel = vscode.window.createWebviewPanel(
            "heybox.originalImage",
            "原图预览",
            vscode.ViewColumn.Active,
            { enableScripts: false },
        );
        originalImagePanel.onDidDispose(() => { originalImagePanel = undefined; });
    } else {
        originalImagePanel.reveal(vscode.ViewColumn.Active);
    }
    originalImagePanel.webview.html = originalImageHtml(url);
}

function originalImageHtml(url: string): string {
    const escapedUrl = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#039;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const nonce = crypto.randomBytes(16).toString("base64");
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'nonce-${nonce}';"><style nonce="${nonce}">body{margin:0;padding:20px;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground)}img{display:block;width:100%;height:auto;margin:auto;border-radius:6px}</style></head><body><img src="${escapedUrl}" alt="原图"></body></html>`;
}

function isSupportedImageUrl(value: unknown): value is string {
    return typeof value === "string" && /^(https?:\/\/|data:image\/)/i.test(value);
}

/**
 * 检查 Cookie 是否已配置，未配置时弹窗提供快捷操作
 */
function checkCookieAndPrompt(context: vscode.ExtensionContext, client: HeyBoxClient): void {
    const cookie = client.getCookie();

    if (!cookie) {
        vscode.window.showWarningMessage(
            "HeyBox 插件需要登录后才能使用。",
            "扫码登录", "从剪贴板导入", "打开设置", "查看教程"
        ).then(c => {
            if (c === "扫码登录") vscode.commands.executeCommand("heybox.login");
            if (c === "打开设置") vscode.commands.executeCommand("workbench.action.openSettings", "heybox.cookie");
            if (c === "查看教程") vscode.commands.executeCommand("workbench.action.openWalkthrough", "heybox.heybox-forum.heybox.walkthrough");
            if (c === "从剪贴板导入") importCookieFromClipboard(context, client);
        });
    }
}

/**
 * 登录成功后的统一处理 — 提示并刷新列表，启动消息轮询
 */
function onLoginSuccess(client: HeyBoxClient, context: vscode.ExtensionContext, statusBarItem?: vscode.StatusBarItem, nickname?: string): void {
    accountGeneration++;
    postRequestGeneration++;
    lastSeenIds.clear();
    vscode.window.showInformationMessage(nickname ? `登录成功，欢迎你，${nickname}！` : "登录成功！");
    postListProvider?.refresh();
    if (statusBarItem) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
        if (notificationsEnabled(context)) startPolling(client, statusBarItem, context);
        else updateStatusBar(statusBarItem, 0, false);
    }
    void vscode.commands.executeCommand("heybox.loginCompleted");
}

/**
 * 手动粘贴 Cookie 登录（扫码异常时的兼容兜底）
 */
async function loginByPaste(client: HeyBoxClient, context: vscode.ExtensionContext, statusBarItem?: vscode.StatusBarItem): Promise<void> {
    const cookie = await vscode.window.showInputBox({
        prompt: "请输入小黑盒 Cookie",
        placeHolder: "从浏览器开发者工具复制的 Cookie",
        password: true,
        ignoreFocusOut: true
    });
    if (!cookie) return;
    if (client.validateCookie(cookie)) {
        const previousCookie = client.getCookie();
        await client.setCookie(cookie);
        try {
            await client.getFavouriteLinks(0, 1);
            onLoginSuccess(client, context, statusBarItem);
        } catch (error) {
            if (isAuthenticationError(error)) {
                if (previousCookie && client.validateCookie(previousCookie)) await client.setCookie(previousCookie);
                else await client.clearCookie();
                vscode.window.showErrorMessage("Cookie 已失效，请重新获取后再试。");
            } else vscode.window.showWarningMessage(`无法验证 Cookie：${(error as Error).message || "网络请求失败"}`);
        }
    } else {
        vscode.window.showErrorMessage("Cookie 格式无效，需要包含 heybox_id 或 x_xhh_tokenid");
    }
}

/**
 * 从剪贴板导入 Cookie 并验证
 */
async function importCookieFromClipboard(context: vscode.ExtensionContext, client: HeyBoxClient, statusBarItem?: vscode.StatusBarItem): Promise<void> {
    const clip = await vscode.env.clipboard.readText();
    if (client.validateCookie(clip)) {
        const previousCookie = client.getCookie();
        await client.setCookie(clip);
        try {
            await client.getFavouriteLinks(0, 1);
            onLoginSuccess(client, context, statusBarItem);
        } catch (error) {
            if (isAuthenticationError(error)) {
                if (previousCookie && client.validateCookie(previousCookie)) await client.setCookie(previousCookie);
                else await client.clearCookie();
                vscode.window.showErrorMessage("Cookie 已失效，请重新获取后再试。");
            } else vscode.window.showWarningMessage(`Cookie 已保存，但暂时无法验证：${(error as Error).message || "网络请求失败"}`);
        }
    } else {
        vscode.window.showWarningMessage("剪贴板内容不是有效的 Cookie，请重新复制（需要包含 heybox_id 字段）");
    }
}

/**
 * 更新状态栏消息提醒按钮的显示状态
 *
 * @param item   - 状态栏项
 * @param unread - 未读消息数
 * @param active - 消息提醒是否已开启
 */
function updateStatusBar(item: vscode.StatusBarItem, unread: number, active: boolean) {
    if (!active) {
        // 未开启：显示静音图标
        item.text = "$(bell-slash) 消息";
        item.tooltip = "小黑盒消息提醒: 已关闭 (点击开启)";
        item.backgroundColor = undefined;
    } else if (unread > 0) {
        // 有新消息：显示数量 + 黄色背景高亮
        item.text = `$(bell) ${unread}`;
        item.tooltip = `小黑盒: ${unread} 条新消息 (点击查看)`;
        item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
        // 已开启但无新消息
        item.text = "$(bell) 0";
        item.tooltip = "小黑盒消息提醒: 无新消息";
        item.backgroundColor = undefined;
    }
    item.show();
}

function notificationsEnabled(context: vscode.ExtensionContext): boolean {
    return context.globalState.get<boolean>(NOTIFICATION_ENABLED_KEY, true);
}

function getNotificationSections(context: vscode.ExtensionContext): NotificationSection[] {
    const saved = context.globalState.get<NotificationSection[]>(NOTIFICATION_SECTIONS_KEY);
    const all = Object.keys(NOTIFICATION_SECTION_LABELS) as NotificationSection[];
    return saved === undefined ? all : saved.filter((section): section is NotificationSection => all.includes(section));
}

/**
 * 启动消息轮询 — 立即检查一次，之后每 3 分钟轮询一次
 */
function startPolling(client: HeyBoxClient, statusBarItem: vscode.StatusBarItem, context: vscode.ExtensionContext) {
    if (!notificationsEnabled(context)) {
        updateStatusBar(statusBarItem, 0, false);
        return;
    }
    // 从全局状态恢复已读消息 ID
    lastSeenIds = new Set(context.globalState.get<string[]>("heybox.seenMsgIds", []));
    // 若接口没有提供已读字段，首次启用只以此刻作为分界，旧历史绝不触发通知。
    if (!context.globalState.get<number>("heybox.notificationBaselineAt")) {
        void context.globalState.update("heybox.notificationBaselineAt", Date.now());
    }
    const account = accountGeneration;
    const session = ++pollSessionGeneration;
    void checkMessages(client, statusBarItem, context, account, session);
    pollTimer = setInterval(() => { void checkMessages(client, statusBarItem, context, account, session); }, 3 * 60 * 1000);
}

/**
 * 检查新消息 — 覆盖互动、官方及游戏优惠；只读取各列表首屏，避免高频请求。
 */
async function checkMessages(client: HeyBoxClient, statusBarItem: vscode.StatusBarItem, context: vscode.ExtensionContext, generation = accountGeneration, session = pollSessionGeneration) {
    if (pollInFlight || generation !== accountGeneration || session !== pollSessionGeneration || !client.getCookie()) return;
    pollInFlight = true;
    try {
        const responses = await Promise.allSettled([
            client.getInteractionMessages("comment", 0, 10),
            client.getInteractionMessages("award", 0, 10),
            client.getInteractionMessages("follow", 0, 10),
            client.getInteractionMessages("mention", 0, 10),
            client.getOfficialMessages(0, 10),
            client.getDiscountMessages(0),
        ]);
        if (generation !== accountGeneration || session !== pollSessionGeneration || !client.getCookie()) return;
        const rejected = responses
            .filter((response): response is PromiseRejectedResult => response.status === "rejected")
            .map((response) => response.reason);
        if (rejected.some(isAuthenticationError)) {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
            updateStatusBar(statusBarItem, 0, false);
            vscode.window.showWarningMessage("小黑盒登录状态已失效，请重新扫码登录。");
            return;
        }
        if (rejected.some(isCaptchaError)) {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
            updateStatusBar(statusBarItem, 0, false);
            vscode.window.showWarningMessage("小黑盒要求人机验证，请在浏览器完成验证后重新扫码登录。");
            return;
        }
        const valueAt = <T>(index: number): T | undefined => {
            const response = responses[index];
            if (response.status === "fulfilled") return response.value as T;
            console.warn("HeyBox notification request failed", response.reason);
            return undefined;
        };
        const comments = valueAt<import("./types").MessageListResult>(0);
        const awards = valueAt<import("./types").MessageListResult>(1);
        const follows = valueAt<import("./types").MessageListResult>(2);
        const mentions = valueAt<import("./types").MessageListResult>(3);
        const official = valueAt<import("./types").OfficialMessageResult>(4);
        const discounts = valueAt<import("./types").DiscountMessageResult>(5);
        const interactionNotifications = (messages: import("./types").MessageItem[], section: NotificationSection): PolledNotification[] => messages.map((message, index) => {
            const user = message.user_a?.nickname || message.user_a?.username || "小黑盒用户";
            const detail = String(message.text || message.comment_a_text || "新消息").replace(/\s+/g, " ").trim();
            return {
                id: String(message.message_id || `interaction-${index}-${message.timestamp || message.create_at || ""}-${detail}`),
                title: user,
                detail,
                linkId: String(message.link?.linkid || message.link_id || message.linkid || "") || undefined,
                timestamp: notificationTimestamp(Number(message.timestamp || message.create_at || 0)),
                readState: getReadState(message),
                section,
            };
        });
        const all: PolledNotification[] = [
            ...interactionNotifications(comments?.messages || [], "comment"),
            ...interactionNotifications(awards?.messages || [], "award"),
            ...interactionNotifications(follows?.messages || [], "follow"),
            ...interactionNotifications(mentions?.messages || [], "mention"),
            ...(official?.messages || []).map((message, index) => ({
                id: String(message.message_id || `official-${index}-${message.timestamp || ""}-${message.title || message.text || ""}`),
                title: message.sender_name || "小黑盒官方",
                detail: String(message.title || message.text || "官方消息").replace(/\s+/g, " ").trim(),
                timestamp: notificationTimestamp(Number(message.timestamp || 0)),
                readState: getReadState(message),
                section: "official" as const,
            })),
            ...(discounts?.msg_list || []).map((message, index) => ({
                id: `discount-${index}-${message.timestamp || ""}-${message.datetime || ""}-${message.description || ""}`,
                title: "游戏优惠",
                detail: String(message.description || message.game_list?.map((game) => game.name).filter(Boolean).join("、") || "已关注游戏有新的优惠").replace(/\s+/g, " ").trim(),
                timestamp: notificationTimestamp(Number(message.timestamp || 0)),
                readState: getReadState(message),
                section: "discount" as const,
            })),
        ];
        const baselineAt = context.globalState.get<number>("heybox.notificationBaselineAt", Date.now());
        const subscribed = new Set(getNotificationSections(context));
        const unread = all.filter((message) => subscribed.has(message.section) && (
            message.readState === "unread" || (message.readState === "unknown" && !!message.timestamp && message.timestamp > baselineAt)
        ));
        const newMsgs = unread.filter((message) => !lastSeenIds.has(message.id));

        if (newMsgs.length > 0) {
            updateStatusBar(statusBarItem, unread.length, true);
            for (const msg of newMsgs) lastSeenIds.add(msg.id);
            // 持久化已读 ID，最多保留 400 条防止无限增长。
            const seenArr = Array.from(lastSeenIds).slice(-400);
            lastSeenIds = new Set(seenArr);
            void context.globalState.update("heybox.seenMsgIds", seenArr);

            // 只显示一条聚合通知，且不等待用户关闭通知；轮询锁可立即释放。
            const first = newMsgs[0];
            void vscode.window.showInformationMessage(
                `小黑盒有 ${newMsgs.length} 条新消息${first ? `：${first.title}` : ""}`,
                "查看消息",
            ).then((action) => {
                if (generation === accountGeneration && session === pollSessionGeneration && action === "查看消息") {
                    postListProvider?.switchTo("messages");
                }
            });
        } else updateStatusBar(statusBarItem, unread.length, true);
    } catch (e) {
        // Cookie 失效时停止轮询
        if (isAuthenticationError(e) || isCaptchaError(e)) {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
            updateStatusBar(statusBarItem, 0, false);
        }
    } finally {
        pollInFlight = false;
    }
}

/**
 * 检测是否启用了隐身模式（隐藏小黑盒相关内容）
 */
function isStealthMode(): boolean {
    return vscode.workspace.getConfiguration("heybox").get<boolean>("stealthMode", false);
}

/**
 * 应用隐身模式 — 将状态同步到 VSCode 上下文，供菜单条件使用
 */
function applyStealthMode(): void {
    vscode.commands.executeCommand("setContext", "heybox.stealth", isStealthMode());
}

/**
 * 扩展停用时清理资源 — 销毁视图、停止消息轮询
 */
export function deactivate(): void {
    postListProvider?.dispose();
    activeClient?.dispose();
    activeClient = undefined;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
}

