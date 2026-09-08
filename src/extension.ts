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
import { HeyBoxClient } from "./api/client";
import { isAuthenticationError, isCaptchaError } from "./api/errors";
import { PostListProvider, toggleFav, getFavs } from "./providers/postListProvider";
import { PostDetailViewProvider } from "./providers/postDetailProvider";
import { SearchItemInfo, PostTreeResult } from "./types";
import { postHtml } from "./utils/htmlRenderer";

let postDetailProvider: PostDetailViewProvider | undefined;
let postListProvider: PostListProvider | undefined;
let currentPanel: vscode.WebviewPanel | undefined;
let currentPanelPost: PostTreeResult | undefined;
let currentPanelFoldedTips = "";
let originalImagePanel: vscode.WebviewPanel | undefined;
/** 浏览历史最大条数 */
const MAX_HISTORY = 50;
/** 消息轮询定时器 */
let pollTimer: ReturnType<typeof setInterval> | undefined;
/** 已读消息 ID 集合，用于去重 */
let lastSeenIds = new Set<string>();

/** 轮询时统一处理的只读通知条目。 */
interface PolledNotification {
    id: string;
    title: string;
    detail: string;
    linkId?: string;
    timestamp?: number;
    readState: "unread" | "read" | "unknown";
}

type ReadStateValue = string | number | boolean | undefined;

/**
 * 将不同消息接口的已读字段归一化。缺少字段时返回 false：
 * 不能把“插件第一次看到”误当成“服务端未读”。
 */
function getReadState(message: {
    is_read?: ReadStateValue;
    has_read?: ReadStateValue;
    is_unread?: ReadStateValue;
    unread?: ReadStateValue;
    read_status?: ReadStateValue;
}): "unread" | "read" | "unknown" {
    const normalized = (value: ReadStateValue): string => String(value ?? "").trim().toLowerCase();
    const isTrue = (value: ReadStateValue) => ["1", "true", "yes", "unread"].includes(normalized(value));
    const isFalse = (value: ReadStateValue) => ["0", "false", "no", "unread"].includes(normalized(value));
    if (message.is_unread !== undefined) return isTrue(message.is_unread) ? "unread" : "read";
    if (message.unread !== undefined) return isTrue(message.unread) ? "unread" : "read";
    if (message.is_read !== undefined) return isFalse(message.is_read) ? "unread" : "read";
    if (message.has_read !== undefined) return isFalse(message.has_read) ? "unread" : "read";
    if (message.read_status !== undefined) return isFalse(message.read_status) ? "unread" : "read";
    return "unknown";
}

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
            if (post) {
                void loadRepliesForPost(client, post, id, rootId, (updated, note) => {
                    postDetailProvider?.showPost(updated, note, postDetailProvider.getFoldedTips());
                });
            }
        }
    }, (url) => client.getOriginalImageUrl(url), openOriginalImagePreview);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(PostDetailViewProvider.viewType, postDetailProvider));

    // 应用隐身模式设置
    applyStealthMode();

    // 状态栏消息提醒按钮
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBarItem.command = "heybox.toggleNotifications";
    statusBarItem.tooltip = "小黑盒消息提醒 (点击开启/关闭)";
    updateStatusBar(statusBarItem, 0, false);
    context.subscriptions.push(statusBarItem);

    // 检查 Cookie 是否已配置，未配置则弹窗提示
    checkCookieAndPrompt(context, client);

    // ─── 命令注册 ───

    // 刷新帖子列表，重新加载配置
    context.subscriptions.push(vscode.commands.registerCommand("heybox.refreshList", async () => { await client.loadConfig(); postListProvider!.refresh(); }));

    // 搜索帖子 — 弹出输入框输入关键词，执行搜索
    context.subscriptions.push(vscode.commands.registerCommand("heybox.searchPost", async () => {
        const q = await vscode.window.showInputBox({ prompt: "搜索帖子", placeHolder: "输入关键词", ignoreFocusOut: true });
        if (q?.trim()) await postListProvider!.performSearch(q.trim());
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
            clearInterval(pollTimer);
            pollTimer = undefined;
            updateStatusBar(statusBarItem, 0, false);
            vscode.window.showInformationMessage("小黑盒消息提醒已关闭");
        } else {
            startPolling(client, statusBarItem, context);
            vscode.window.showInformationMessage("小黑盒消息提醒已开启 (每3分钟检查)");
        }
    }));

    // 已读状态由服务端维护；未知写入接口时不再伪造本地“已读”，避免下一轮把未读消息重新弹出。
    context.subscriptions.push(vscode.commands.registerCommand("heybox.markAllRead", async () => {
        vscode.window.showInformationMessage("已读状态以小黑盒服务端为准，请在小黑盒客户端中标记已读。");
    }));

    // 已登录时自动启动消息轮询
    if (client.getCookie()) {
        startPolling(client, statusBarItem, context);
    }

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

    // 切换收藏状态 — 乐观更新 + 服务端同步，失败时回滚
    context.subscriptions.push(vscode.commands.registerCommand("heybox.toggleFavourite", async (item: any) => {
        const post = item?.post || item;
        if (!post?.linkid) return;
        const linkId = String(post.linkid);
        const wasFav = getFavs(context).some(f => f.linkid === post.linkid);
        toggleFav(context, post);
        // 服务端同步
        try {
            await client.favouritePost(linkId);
            vscode.window.showInformationMessage(wasFav ? "已取消收藏（服务端已同步）" : "已收藏（服务端已同步）");
            await postListProvider!.refreshFavourites();
        } catch (error) {
            toggleFav(context, post); // 回滚
            const message = error instanceof Error ? error.message : "未知错误";
            vscode.window.showErrorMessage(`收藏失败: ${message}`);
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
        if (e.affectsConfiguration("heybox")) { await client.loadConfig(); applyStealthMode(); postListProvider!.refresh(); }
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
    }
}

async function openAndShowPost(context: vscode.ExtensionContext, client: HeyBoxClient, linkId: string, loadAll = false, rootId?: string): Promise<void> {
    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "加载帖子中...", cancellable: false }, async () => {
            const tree = await client.getPostTree(linkId, 0, loadAll ? 100 : 20);
            if (!tree || !tree.link) { vscode.window.showWarningMessage("未获取到帖子内容"); return; }

            // 记录浏览历史，最多保留 MAX_HISTORY 条，自动去重
            const history = context.globalState.get<string[]>("history", []);
            const SEP = "\x00"; // 使用 null 字符作为分隔符，避免与标题内容冲突
            const entry = `${tree.link.title || "无标题"}${SEP}${linkId}`;
            const deduped = history.filter(h => !h.endsWith(`${SEP}${linkId}`));
            deduped.unshift(entry);
            context.globalState.update("history", deduped.slice(0, MAX_HISTORY));

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
                postDetailProvider.showPost(fullTree, commentNote, foldedTips);
                if (!postDetailProvider.isViewVisible()) {
                    vscode.window.showInformationMessage("帖子已加载，请在侧边栏点击「帖子详情」查看");
                }
            } else {
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
                    if (msg?.command !== "loadReplies" || typeof msg.linkId !== "string" || typeof msg.rootId !== "string") return;
                    if (currentPanel !== panel || !currentPanelPost) return;
                    void loadRepliesForPost(client, currentPanelPost, msg.linkId, msg.rootId, (updated, note) => {
                        if (currentPanel !== panel) return;
                        currentPanelPost = updated;
                        panel.webview.html = postHtml(updated, isStealthMode(), note, currentPanelFoldedTips);
                    });
                });
                panel.webview.html = postHtml(fullTree, stealth, commentNote, foldedTips);
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
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline';"><style>body{margin:0;padding:20px;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground)}img{display:block;width:100%;height:auto;margin:auto;border-radius:6px}</style></head><body><img src="${escapedUrl}" alt="原图"></body></html>`;
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
    vscode.window.showInformationMessage(nickname ? `登录成功，欢迎你，${nickname}！` : "登录成功！");
    postListProvider?.refresh();
    if (!pollTimer && statusBarItem) {
        startPolling(client, statusBarItem, context);
    }
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
        await client.setCookie(cookie);
        onLoginSuccess(client, context, statusBarItem);
    } else {
        vscode.window.showErrorMessage("Cookie 格式无效，需要包含 heybox_id 或 x_xhh_tokenid");
    }
}

/**
 * 从剪贴板导入 Cookie 并验证
 */
async function importCookieFromClipboard(context: vscode.ExtensionContext, client: HeyBoxClient): Promise<void> {
    const clip = await vscode.env.clipboard.readText();
    if (client.validateCookie(clip)) {
        await client.setCookie(clip);
        vscode.window.showInformationMessage("Cookie 已导入！请刷新侧边栏。");
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

/**
 * 启动消息轮询 — 立即检查一次，之后每 3 分钟轮询一次
 */
function startPolling(client: HeyBoxClient, statusBarItem: vscode.StatusBarItem, context: vscode.ExtensionContext) {
    // 从全局状态恢复已读消息 ID
    lastSeenIds = new Set(context.globalState.get<string[]>("heybox.seenMsgIds", []));
    // 若接口没有提供已读字段，首次启用只以此刻作为分界，旧历史绝不触发通知。
    if (!context.globalState.get<number>("heybox.notificationBaselineAt")) {
        void context.globalState.update("heybox.notificationBaselineAt", Date.now());
    }
    checkMessages(client, statusBarItem, context);
    pollTimer = setInterval(() => checkMessages(client, statusBarItem, context), 3 * 60 * 1000);
}

/**
 * 检查新消息 — 覆盖互动、官方及游戏优惠；只读取各列表首屏，避免高频请求。
 */
async function checkMessages(client: HeyBoxClient, statusBarItem: vscode.StatusBarItem, context: vscode.ExtensionContext) {
    try {
        const responses = await Promise.allSettled([
            client.getInteractionMessages("comment", 0, 10),
            client.getInteractionMessages("award", 0, 10),
            client.getInteractionMessages("follow", 0, 10),
            client.getInteractionMessages("mention", 0, 10),
            client.getOfficialMessages(0, 10),
            client.getDiscountMessages(0),
        ]);
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
        const interactions: PolledNotification[] = [
            ...(comments?.messages || []), ...(awards?.messages || []), ...(follows?.messages || []), ...(mentions?.messages || []),
        ].map((message, index) => {
            const user = message.user_a?.nickname || message.user_a?.username || "小黑盒用户";
            const detail = String(message.text || message.comment_a_text || "新消息").replace(/\s+/g, " ").trim();
            return {
                id: String(message.message_id || `interaction-${index}-${message.timestamp || message.create_at || ""}-${detail}`),
                title: user,
                detail,
                linkId: String(message.link?.linkid || message.link_id || message.linkid || "") || undefined,
                timestamp: notificationTimestamp(Number(message.timestamp || message.create_at || 0)),
                readState: getReadState(message),
            };
        });
        const all: PolledNotification[] = [
            ...interactions,
            ...(official?.messages || []).map((message, index) => ({
                id: String(message.message_id || `official-${index}-${message.timestamp || ""}-${message.title || message.text || ""}`),
                title: message.sender_name || "小黑盒官方",
                detail: String(message.title || message.text || "官方消息").replace(/\s+/g, " ").trim(),
                timestamp: notificationTimestamp(Number(message.timestamp || 0)),
                readState: getReadState(message),
            })),
            ...(discounts?.msg_list || []).map((message, index) => ({
                id: `discount-${index}-${message.timestamp || ""}-${message.datetime || ""}-${message.description || ""}`,
                title: "游戏优惠",
                detail: String(message.description || message.game_list?.map((game) => game.name).filter(Boolean).join("、") || "已关注游戏有新的优惠").replace(/\s+/g, " ").trim(),
                timestamp: notificationTimestamp(Number(message.timestamp || 0)),
                readState: getReadState(message),
            })),
        ];
        const baselineAt = context.globalState.get<number>("heybox.notificationBaselineAt", Date.now());
        const unread = all.filter((message) =>
            message.readState === "unread" || (message.readState === "unknown" && !!message.timestamp && message.timestamp > baselineAt),
        );
        const newMsgs = unread.filter((message) => !lastSeenIds.has(message.id));

        if (newMsgs.length > 0) {
            updateStatusBar(statusBarItem, unread.length, true);

            // 逐条弹窗通知新消息
            for (const msg of newMsgs) {
                const shortDesc = msg.detail.length > 50 ? msg.detail.substring(0, 50) + "..." : msg.detail;
                if (msg.linkId) {
                    const action = await vscode.window.showInformationMessage(`${msg.title}: ${shortDesc}`, "查看帖子");
                    if (action === "查看帖子") {
                        await vscode.commands.executeCommand("heybox.openPost", { linkid: Number(msg.linkId) });
                    }
                } else {
                    vscode.window.showInformationMessage(`${msg.title}: ${shortDesc}`);
                }

                // 标记为已读
                lastSeenIds.add(msg.id);
            }

            // 持久化已读 ID，最多保留 400 条防止无限增长。
            const seenArr = Array.from(lastSeenIds).slice(-400);
            lastSeenIds = new Set(seenArr);
            context.globalState.update("heybox.seenMsgIds", seenArr);
        } else updateStatusBar(statusBarItem, unread.length, true);
    } catch (e) {
        // Cookie 失效时停止轮询
        if (isAuthenticationError(e) || isCaptchaError(e)) {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
            updateStatusBar(statusBarItem, 0, false);
        }
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
    if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
}

