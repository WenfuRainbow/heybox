/**
 * 小黑盒 VSCode 扩展入口
 *
 * 提供以下功能：
 * - 帖子列表浏览与搜索
 * - 帖子详情查看（侧边栏 / 面板）
 * - 每日签到
 * - 消息轮询提醒
 * - 收藏管理
 * - Cookie 登录管理
 * - 隐身模式
 */
import * as vscode from "vscode";
import { HeyBoxClient } from "./api/client";
import { PostListProvider, toggleFav, getFavs } from "./providers/postListProvider";
import { PostDetailViewProvider } from "./providers/postDetailProvider";
import { SearchItemInfo, PostTreeResult, SignTaskItem } from "./types";
import { postHtml } from "./utils/htmlRenderer";

let postDetailProvider: PostDetailViewProvider | undefined;
let postListProvider: PostListProvider | undefined;
let currentPanel: vscode.WebviewPanel | undefined;
/** 浏览历史最大条数 */
const MAX_HISTORY = 50;
/** 消息轮询定时器 */
let pollTimer: ReturnType<typeof setInterval> | undefined;
/** 已读消息 ID 集合，用于去重 */
let lastSeenIds = new Set<string>();

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
    postDetailProvider = new PostDetailViewProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(PostDetailViewProvider.viewType, postDetailProvider));

    // 检查 Cookie 是否已配置，未配置则弹窗提示
    checkCookieAndPrompt(context, client);
    // 应用隐身模式设置
    applyStealthMode();

    // 每次打开自动签到
    client.signDaily().then((r) => {
        vscode.window.showInformationMessage(`签到: ${r.message}`);
    }).catch(() => {});

    // 状态栏消息提醒按钮
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBarItem.command = "heybox.toggleNotifications";
    statusBarItem.tooltip = "小黑盒消息提醒 (点击开启/关闭)";
    updateStatusBar(statusBarItem, 0, false);
    context.subscriptions.push(statusBarItem);

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

    // 加载更多搜索结果
    context.subscriptions.push(vscode.commands.registerCommand("heybox.loadMoreSearch", async () => postListProvider!.loadMoreSearch()));

    // 加载更多帖子（按分类类型）
    context.subscriptions.push(vscode.commands.registerCommand("heybox.loadMore", async (t: number) => postListProvider!.loadMorePosts(t)));

    // 加载更多 Feed
    context.subscriptions.push(vscode.commands.registerCommand("heybox.loadMoreFeed", async () => postListProvider!.loadMoreFeed()));

    // 签到命令 — 获取任务列表、检查签到状态、执行签到
    context.subscriptions.push(vscode.commands.registerCommand("heybox.signDaily", async () => {
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: "小黑盒签到", cancellable: false },
                async (progress) => {
                    progress.report({ message: "获取任务列表..." });
                    const taskList = await client.getTaskList();
                    const nickname = taskList.user?.username || "未知";
                    const coin = taskList.user?.level_info?.coin || "?";
                    vscode.window.showInformationMessage(`账号: ${nickname} | 当前H币: ${coin}`);

                    // 在任务列表中查找签到任务
                    let signTask: SignTaskItem | undefined;
                    for (const group of taskList.task_list || []) {
                        for (const task of group.tasks || []) {
                            if (task.type === "sign") { signTask = task; break; }
                        }
                        if (signTask) break;
                    }

                    // 签到任务已完成，直接提示奖励
                    if (signTask && signTask.state === "finish") {
                        const awards = (signTask.award_desc_v2 || [])
                            .map(a => a.desc).filter(Boolean).join(" ");
                        vscode.window.showInformationMessage(
                            `签到已完成${awards ? "，奖励: " + awards : ""}`);
                        return;
                    }

                    // 执行签到
                    progress.report({ message: "正在签到..." });
                    const signResult = await client.signDaily();
                    vscode.window.showInformationMessage(signResult.message);
                }
            );
        } catch (e) {
            const msg = (e as Error).message || "";
            if (msg.includes("Cookie")) vscode.window.showErrorMessage(msg);
            else vscode.window.showErrorMessage(`签到失败: ${msg}`);
        }
    }));

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

    // 标记所有消息为已读，清空已读集合
    context.subscriptions.push(vscode.commands.registerCommand("heybox.markAllRead", async () => {
        lastSeenIds = new Set<string>();
        context.globalState.update("heybox.seenMsgIds", []);
        updateStatusBar(statusBarItem, 0, pollTimer !== undefined);
        vscode.window.showInformationMessage("已标记所有消息为已读");
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
        } catch {
            toggleFav(context, post); // 回滚
            vscode.window.showErrorMessage("收藏失败，请检查网络后重试");
        }
        postListProvider!.switchTo(postListProvider!.getViewMode());
    }));

    // 切换侧边栏显示
    context.subscriptions.push(vscode.commands.registerCommand("heybox.toggleSidebar", async () => {
        await vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
    }));

    // 登录命令 — 手动输入 Cookie
    context.subscriptions.push(vscode.commands.registerCommand("heybox.login", async () => {
        const cookie = await vscode.window.showInputBox({
            prompt: "请输入小黑盒 Cookie",
            placeHolder: "从浏览器开发者工具复制的 Cookie",
            password: true,
            ignoreFocusOut: true
        });
        if (!cookie) return;
        if (client.validateCookie(cookie)) {
            await client.setCookie(cookie);
            vscode.window.showInformationMessage("登录成功！");
            postListProvider!.refresh();
            // 登录成功后自动开启消息轮询
            if (!pollTimer) {
                startPolling(client, statusBarItem, context);
            }
        } else {
            vscode.window.showErrorMessage("Cookie 格式无效，需要包含 heybox_id 或 x_xhh_tokenid");
        }
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
async function openAndShowPost(context: vscode.ExtensionContext, client: HeyBoxClient, linkId: string): Promise<void> {
    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "加载帖子中...", cancellable: false }, async () => {
            const tree = await client.getPostTree(linkId, 0);
            if (!tree || !tree.link) { vscode.window.showWarningMessage("未获取到帖子内容"); return; }

            // 记录浏览历史，最多保留 MAX_HISTORY 条，自动去重
            const history = context.globalState.get<string[]>("history", []);
            const SEP = "\x00"; // 使用 null 字符作为分隔符，避免与标题内容冲突
            const entry = `${tree.link.title || "无标题"}${SEP}${linkId}`;
            const deduped = history.filter(h => !h.endsWith(`${SEP}${linkId}`));
            deduped.unshift(entry);
            context.globalState.update("history", deduped.slice(0, MAX_HISTORY));

            const totalCommentNum = tree.link.comment_num || 0;
            let allCommentGroups = tree.comments || [];
            const seenIds = new Set<string>();
            allCommentGroups.forEach(g => { if (g.comment?.[0]) seenIds.add(g.comment[0].commentid); });

            // 当评论为空但帖子有评论时，尝试不同 sort_filter 获取评论
            let foldedTips = "";
            if (allCommentGroups.length === 0 && totalCommentNum > 0) {
                for (const sort of ["time_aes", "time_desc", "hot"]) {
                    try {
                        const retry = await client.getPostTree(linkId, 0, 0, sort);
                        if (retry?.comments && retry.comments.length > allCommentGroups.length) {
                            allCommentGroups = retry.comments;
                            retry.comments.forEach(g => { if (g.comment?.[0]) seenIds.add(g.comment[0].commentid); });
                            break;
                        }
                        foldedTips = (retry as any)?.folded_comment_tips || "";
                    } catch { /* ignore */ }
                }
            }

            // 评论数超过已加载数量时，分页加载额外评论（最多显示 30 条）
            const commentLimit = 30;
            const pageSize = 10; // API 每页返回的评论数
            if (totalCommentNum > allCommentGroups.length && allCommentGroups.length < commentLimit) {
                const tasks: Promise<void>[] = [];
                // 根据已加载数量和总数量动态计算需要加载的偏移量
                const offsets: number[] = [];
                let nextOffset = allCommentGroups.length;
                while (nextOffset < Math.min(totalCommentNum, commentLimit)) {
                    offsets.push(nextOffset);
                    nextOffset += pageSize;
                }
                for (const o of offsets) {
                    tasks.push(client.getPostTree(linkId, o, 10).then(r => {
                        if (r?.comments) {
                            for (const g of r.comments) {
                                if (g.comment?.[0] && !seenIds.has(g.comment[0].commentid)) {
                                    seenIds.add(g.comment[0].commentid);
                                    allCommentGroups.push(g);
                                }
                            }
                        }
                    }).catch(() => {}));
                }
                await Promise.all(tasks);
            }

            // 组装完整帖子树，根据设置选择在侧边栏或面板中展示
            const fullTree: PostTreeResult = { ...tree, comments: allCommentGroups };
            const location = vscode.workspace.getConfiguration("heybox").get<string>("postDetailLocation", "sidebar");
            const stealth = isStealthMode();
            const commentNote = totalCommentNum > allCommentGroups.length
                ? `共 ${totalCommentNum} 条评论，当前显示前 ${allCommentGroups.length} 条`
                : undefined;

            if (location === "sidebar" && postDetailProvider) {
                postDetailProvider.showPost(fullTree, commentNote, foldedTips);
                if (!postDetailProvider.isViewVisible()) {
                    vscode.window.showInformationMessage("帖子已加载，请在侧边栏点击「帖子详情」查看");
                }
            } else {
                if (currentPanel) currentPanel.dispose();
                const col = location === "beside" ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
                currentPanel = vscode.window.createWebviewPanel("heybox.postDetailPanel", stealth ? "README.md" : "帖子", col, { enableScripts: true });
                currentPanel.webview.html = postHtml(fullTree, stealth, commentNote, foldedTips);
                currentPanel.onDidDispose(() => { currentPanel = undefined; });
            }
        });
    } catch (e) {
        const msg = (e as Error).message || "";
        if (msg.includes("超时")) vscode.window.showErrorMessage("请求超时，请检查网络连接");
        else if (msg.includes("Cookie")) vscode.window.showErrorMessage(msg);
        else vscode.window.showErrorMessage(`获取帖子详情失败: ${msg}`);
    }
}

/**
 * 检查 Cookie 是否已配置，未配置时弹窗提供快捷操作
 */
function checkCookieAndPrompt(context: vscode.ExtensionContext, client: HeyBoxClient): void {
    let cookie = client.getCookie();

    if (!cookie) {
        vscode.window.showWarningMessage(
            "HeyBox 插件需要配置 Cookie 才能使用。",
            "从剪贴板导入", "打开设置", "查看教程"
        ).then(c => {
            if (c === "打开设置") vscode.commands.executeCommand("workbench.action.openSettings", "heybox.cookie");
            if (c === "查看教程") vscode.commands.executeCommand("workbench.action.openWalkthrough", "heybox.heybox-forum.heybox.walkthrough");
            if (c === "从剪贴板导入") importCookieFromClipboard(context, client);
        });
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
    checkMessages(client, statusBarItem, context);
    pollTimer = setInterval(() => checkMessages(client, statusBarItem, context), 3 * 60 * 1000);
}

/**
 * 检查新消息 — 获取回复和点赞，弹窗通知新消息
 */
async function checkMessages(client: HeyBoxClient, statusBarItem: vscode.StatusBarItem, context: vscode.ExtensionContext) {
    try {
        // 并发获取回复消息（type=0）和点赞消息（type=1）
        const replies = await client.getMessages(0, 0, 10);
        const likes = await client.getMessages(1, 0, 10);

        // 合并并过滤出未读消息
        const all = [...(replies.messages || []), ...(likes.messages || [])];
        const newMsgs = all.filter(m => !lastSeenIds.has(m.message_id));

        if (newMsgs.length > 0) {
            updateStatusBar(statusBarItem, newMsgs.length, true);

            // 逐条弹窗通知新消息
            for (const msg of newMsgs) {
                const linkId = msg.link?.linkid || msg.link_id || msg.linkid;
                const user = msg.user_a?.nickname || msg.user_a?.username || "未知用户";
                const desc = msg.text || msg.comment_a_text || "新消息";
                const shortDesc = desc.length > 50 ? desc.substring(0, 50) + "..." : desc;

                const action = await vscode.window.showInformationMessage(
                    `${user}: ${shortDesc}`,
                    "查看帖子"
                );
                if (action === "查看帖子" && linkId) {
                    await vscode.commands.executeCommand("heybox.openPost", { linkid: Number(linkId) });
                }

                // 标记为已读
                lastSeenIds.add(msg.message_id);
            }

            // 持久化已读 ID，最多保留 200 条防止无限增长
            const seenArr = Array.from(lastSeenIds).slice(-200);
            lastSeenIds = new Set(seenArr);
            context.globalState.update("heybox.seenMsgIds", seenArr);
        } else {
            updateStatusBar(statusBarItem, 0, true);
        }
    } catch (e) {
        const msg = (e as Error).message || "";
        // Cookie 失效时停止轮询
        if (msg.includes("Cookie")) {
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
