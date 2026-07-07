import * as vscode from "vscode";
import { HeyBoxClient } from "./api/client";
import { PostListProvider, toggleFav, getFavs } from "./providers/postListProvider";
import { PostDetailViewProvider } from "./providers/postDetailProvider";
import { SearchItemInfo, PostTreeResult } from "./types";
import { postHtml } from "./utils/htmlRenderer";

let postDetailProvider: PostDetailViewProvider | undefined;
let currentPanel: vscode.WebviewPanel | undefined;
const MAX_HISTORY = 50;

export function activate(context: vscode.ExtensionContext): void {
    const client = new HeyBoxClient(context);
    const postListProvider = new PostListProvider(client);

    const treeView = vscode.window.createTreeView("heybox.postList", {
        treeDataProvider: postListProvider, showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    postDetailProvider = new PostDetailViewProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(PostDetailViewProvider.viewType, postDetailProvider));

    client.refreshCookie().then(() => {
        checkCookieAndPrompt(context, client);
    });
    applyStealthMode();

    context.subscriptions.push(vscode.commands.registerCommand("heybox.refreshList", () => { client.loadConfig(); postListProvider.refresh(); }));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.searchPost", async () => {
        const q = await vscode.window.showInputBox({ prompt: "搜索帖子", placeHolder: "输入关键词", ignoreFocusOut: true });
        if (q?.trim()) await postListProvider.performSearch(q.trim());
    }));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.exitSearch", () => { postListProvider.exitSearch(); postListProvider.refresh(); }));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.switchToRecommend", () => postListProvider.switchTo("recommend")));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.switchToCategories", () => postListProvider.switchTo("categories")));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.switchToFavorites", () => postListProvider.switchTo("favorites")));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.loadMoreSearch", async () => postListProvider.loadMoreSearch()));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.loadMore", async (t: number) => postListProvider.loadMorePosts(t)));
    context.subscriptions.push(vscode.commands.registerCommand("heybox.loadMoreFeed", async () => postListProvider.loadMoreFeed()));

    context.subscriptions.push(vscode.commands.registerCommand("heybox.openPost", async (post: SearchItemInfo) => {
        if (!post?.linkid) return;
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
        postListProvider.switchTo(postListProvider["viewMode"] as any);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("heybox.toggleSidebar", async () => {
        await vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
    }));

    context.subscriptions.push(vscode.commands.registerCommand("heybox.openClipboardUrl", async () => {
        const clip = await vscode.env.clipboard.readText();
        const m = clip.match(/\/link\/([a-zA-Z0-9]+)/);
        if (!m) { vscode.window.showErrorMessage("剪贴板中未找到帖子链接"); return; }
        await openAndShowPost(context, client, m[1]);
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("heybox")) { client.loadConfig(); applyStealthMode(); postListProvider.refresh(); }
    }));
}

async function openAndShowPost(context: vscode.ExtensionContext, client: HeyBoxClient, linkId: string): Promise<void> {
    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "加载帖子中...", cancellable: false }, async () => {
            const tree = await client.getPostTree(linkId, 0);
            if (!tree || !tree.link) { vscode.window.showWarningMessage("未获取到帖子内容"); return; }

            const history = context.globalState.get<string[]>("history", []);
            const entry = `${tree.link.title || "无标题"}||${linkId}`;
            const deduped = history.filter(h => !h.endsWith(`||${linkId}`));
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
            if (totalCommentNum > allCommentGroups.length && allCommentGroups.length < commentLimit) {
                const tasks: Promise<void>[] = [];
                const offsets = [11];
                if (commentLimit > 20) offsets.push(21);
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
                if (!(postDetailProvider as any)._view) {
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
    const config = vscode.workspace.getConfiguration("heybox");
    let cookie = config.get<string>("cookie", "");
    if (!cookie) cookie = client["cookie"];

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
    if (clip.includes("heybox_id") || clip.includes("x_xhh_tokenid") || clip.includes("user_pkey")) {
        const configTarget = vscode.ConfigurationTarget.Global;
        await vscode.workspace.getConfiguration("heybox").update("cookie", clip, configTarget);
        client.loadConfig();
        vscode.window.showInformationMessage("Cookie 已导入！请刷新侧边栏。");
    } else {
        vscode.window.showWarningMessage("剪贴板内容不是有效的 Cookie，请重新复制（需要包含 heybox_id 字段）");
    }
}

function isStealthMode(): boolean {
    return vscode.workspace.getConfiguration("heybox").get<boolean>("stealthMode", false);
}

function applyStealthMode(): void {
    vscode.commands.executeCommand("setContext", "heybox.stealth", isStealthMode());
}

export function deactivate(): void {}