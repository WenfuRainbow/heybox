import * as vscode from "vscode";
import { HeyBoxClient } from "./api/client";
import { PostListProvider, toggleFav, getFavs } from "./providers/postListProvider";
import { PostDetailViewProvider } from "./providers/postDetailProvider";
import { SearchItemInfo, PostTreeResult, SignTaskItem, MessageItem } from "./types";
import { postHtml } from "./utils/htmlRenderer";

let postDetailProvider: PostDetailViewProvider | undefined;
let postListProvider: PostListProvider | undefined;
let currentPanel: vscode.WebviewPanel | undefined;
const MAX_HISTORY = 50;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let lastSeenIds = new Set<string>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const client = new HeyBoxClient(context);
    await client.loadConfig();
    postListProvider = new PostListProvider(client);
    postListProvider.setContext(context);

    const treeView = vscode.window.createTreeView("heybox.postList", {
        treeDataProvider: postListProvider, showCollapseAll: true,
    });
    postListProvider.setTreeView(treeView);
    context.subscriptions.push(treeView);

    postDetailProvider = new PostDetailViewProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(PostDetailViewProvider.viewType, postDetailProvider));

    checkCookieAndPrompt(context, client);
    applyStealthMode();

    // 每次打开自动签到
    client.signDaily().then((r) => {
        vscode.window.showInformationMessage(`签到: ${r.message}`);
    }).catch(() => {});

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBarItem.command = "heybox.toggleNotifications";
    statusBarItem.tooltip = "小黑盒消息提醒 (点击开启/关闭)";
    updateStatusBar(statusBarItem, 0, false);
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(vscode.commands.registerCommand("heybox.refreshList", async () => { await client.loadConfig(); postListProvider!.refresh(); }));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.searchPost", async () => {
        const q = await vscode.window.showInputBox({ prompt: "搜索帖子", placeHolder: "输入关键词", ignoreFocusOut: true });
        if (q?.trim()) await postListProvider!.performSearch(q.trim());
    }));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.exitSearch", () => { postListProvider!.exitSearch(); postListProvider!.refresh(); }));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.switchToRecommend", () => postListProvider!.switchTo("recommend")));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.switchToCategories", () => postListProvider!.switchTo("categories")));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.switchToFavorites", () => postListProvider!.switchTo("favorites")));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.loadMoreSearch", async () => postListProvider!.loadMoreSearch()));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.loadMore", async (t: number) => postListProvider!.loadMorePosts(t)));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.loadMoreFeed", async () => postListProvider!.loadMoreFeed()));
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

                    let signTask: SignTaskItem | undefined;
                    for (const group of taskList.task_list || []) {
                        for (const task of group.tasks || []) {
                            if (task.type === "sign") { signTask = task; break; }
                        }
                        if (signTask) break;
                    }

                    if (signTask && signTask.state === "finish") {
                        const awards = (signTask.award_desc_v2 || [])
                            .map(a => a.desc).filter(Boolean).join(" ");
                        vscode.window.showInformationMessage(
                            `签到已完成${awards ? "，奖励: " + awards : ""}`);
                        return;
                    }

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

    context.subscriptions.push(vscode.commands.registerCommand("heybox.markAllRead", async () => {
        lastSeenIds = new Set<string>();
        context.globalState.update("heybox.seenMsgIds", []);
        updateStatusBar(statusBarItem, 0, pollTimer !== undefined);
        vscode.window.showInformationMessage("已标记所有消息为已读");
    }));

    if (client.getCookie()) {
        startPolling(client, statusBarItem, context);
    }

    context.subscriptions.push(vscode.commands.registerCommand("heybox.openPost", async (post: SearchItemInfo) => {
        if (!post?.linkid) return;
        postListProvider!.saveLastPost(post.linkid);
        await openAndShowPost(context, client, String(post.linkid));
    }));

    context.subscriptions.push(vscode.commands.registerCommand("heybox.openByUrl", async () => {
        const url = await vscode.window.showInputBox({ prompt: "输入帖子URL", placeHolder: "https://www.xiaoheihe.cn/app/bbs/link/xxxxx" });
        if (!url) return;
        const m = url.match(/\/link\/([a-zA-Z0-9]+)/);
        if (!m) { vscode.window.showErrorMessage("无法解析帖子ID"); return; }
        await openAndShowPost(context, client, m[1]);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("heybox.openInBrowser", async (item: any) => {
        const post = item?.post || item;
        if (!post?.linkid) return;
        vscode.env.openExternal(vscode.Uri.parse(`https://www.xiaoheihe.cn/app/bbs/link/${post.linkid}`));
    }));

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

    context.subscriptions.push(vscode.commands.registerCommand("heybox.toggleSidebar", async () => {
        await vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
    }));

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
            if (!pollTimer) {
                startPolling(client, statusBarItem, context);
            }
        } else {
            vscode.window.showErrorMessage("Cookie 格式无效，需要包含 heybox_id 或 x_xhh_tokenid");
        }
    }));

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

    context.subscriptions.push(vscode.commands.registerCommand("heybox.openClipboardUrl", async () => {
        const clip = await vscode.env.clipboard.readText();
        const m = clip.match(/\/link\/([a-zA-Z0-9]+)/);
        if (!m) { vscode.window.showErrorMessage("剪贴板中未找到帖子链接"); return; }
        await openAndShowPost(context, client, m[1]);
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration("heybox")) { await client.loadConfig(); applyStealthMode(); postListProvider!.refresh(); }
    }));
}

async function openAndShowPost(context: vscode.ExtensionContext, client: HeyBoxClient, linkId: string): Promise<void> {
    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "加载帖子中...", cancellable: false }, async () => {
            const tree = await client.getPostTree(linkId, 0);
            if (!tree || !tree.link) { vscode.window.showWarningMessage("未获取到帖子内容"); return; }

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

            // 当评论为空但帖子有评论时，尝试不同 sort_filter
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

            // 如果仍有不足，加载额外页面
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

async function importCookieFromClipboard(context: vscode.ExtensionContext, client: HeyBoxClient): Promise<void> {
    const clip = await vscode.env.clipboard.readText();
    if (client.validateCookie(clip)) {
        await client.setCookie(clip);
        vscode.window.showInformationMessage("Cookie 已导入！请刷新侧边栏。");
    } else {
        vscode.window.showWarningMessage("剪贴板内容不是有效的 Cookie，请重新复制（需要包含 heybox_id 字段）");
    }
}

function updateStatusBar(item: vscode.StatusBarItem, unread: number, active: boolean) {
    if (!active) {
        item.text = "$(bell-slash) 消息";
        item.tooltip = "小黑盒消息提醒: 已关闭 (点击开启)";
        item.backgroundColor = undefined;
    } else if (unread > 0) {
        item.text = `$(bell) ${unread}`;
        item.tooltip = `小黑盒: ${unread} 条新消息 (点击查看)`;
        item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
        item.text = "$(bell) 0";
        item.tooltip = "小黑盒消息提醒: 无新消息";
        item.backgroundColor = undefined;
    }
    item.show();
}

function startPolling(client: HeyBoxClient, statusBarItem: vscode.StatusBarItem, context: vscode.ExtensionContext) {
    lastSeenIds = new Set(context.globalState.get<string[]>("heybox.seenMsgIds", []));
    checkMessages(client, statusBarItem, context);
    pollTimer = setInterval(() => checkMessages(client, statusBarItem, context), 3 * 60 * 1000);
}

async function checkMessages(client: HeyBoxClient, statusBarItem: vscode.StatusBarItem, context: vscode.ExtensionContext) {
    try {
        const replies = await client.getMessages(0, 0, 10);
        const likes = await client.getMessages(1, 0, 10);

        const all = [...(replies.messages || []), ...(likes.messages || [])];
        const newMsgs = all.filter(m => !lastSeenIds.has(m.message_id));

        if (newMsgs.length > 0) {
            updateStatusBar(statusBarItem, newMsgs.length, true);

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

                lastSeenIds.add(msg.message_id);
            }

            const seenArr = Array.from(lastSeenIds).slice(-200);
            lastSeenIds = new Set(seenArr);
            context.globalState.update("heybox.seenMsgIds", seenArr);
        } else {
            updateStatusBar(statusBarItem, 0, true);
        }
    } catch (e) {
        const msg = (e as Error).message || "";
        if (msg.includes("Cookie")) {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
            updateStatusBar(statusBarItem, 0, false);
        }
    }
}

function isStealthMode(): boolean {
    return vscode.workspace.getConfiguration("heybox").get<boolean>("stealthMode", false);
}

function applyStealthMode(): void {
    vscode.commands.executeCommand("setContext", "heybox.stealth", isStealthMode());
}

export function deactivate(): void {
    postListProvider?.dispose();
    if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
}