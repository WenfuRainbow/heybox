import * as vscode from "vscode";
import { PostTreeResult } from "../types";
import { postHtml } from "../utils/htmlRenderer";

/**
 * 帖子详情的 WebviewView 提供者
 * 在侧边栏中渲染帖子正文和评论，支持隐身模式（伪装为 README.md）
 */
export class PostDetailViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "heybox.postDetail";
    private _view?: vscode.WebviewView;
    /** 当前正在展示的帖子数据 */
    private _currentPost: PostTreeResult | undefined;
    /** 被折叠评论的提示文案 */
    private _foldedTips: string = "";

    constructor(private readonly extensionUri: vscode.Uri) {}

    /**
     * VSCode 回调：当面板首次被激活时调用
     * - 启用脚本执行权限
     * - 如有已缓存的帖子数据则立即渲染，否则显示占位页
     */
    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
        webviewView.title = getPanelTitle();
        if (this._currentPost) {
            this._view.webview.html = postHtml(this._currentPost, isStealth(), undefined, this._foldedTips);
        } else {
            webviewView.webview.html = this.placeholderHtml();
        }
    }

    isViewVisible(): boolean { return !!this._view; }

    /**
     * 在面板中展示指定帖子
     * @param postTree 帖子完整数据（正文 + 评论组）
     * @param commentNote 评论区底部的备注说明
     * @param foldedTips 被折叠评论的提示文案
     */
    showPost(postTree: PostTreeResult, commentNote?: string, foldedTips?: string): void {
        this._currentPost = postTree;
        this._foldedTips = foldedTips || "";
        if (this._view) {
            this._view.show?.(true);
            this._view.webview.html = postHtml(postTree, isStealth(), commentNote, foldedTips);
            this._view.title = isStealth() ? "README.md" : (postTree.link.title || "帖子");
        }
    }

    /** 未选中帖子时的占位 HTML 页面 */
    private placeholderHtml(): string {
        return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>body{font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground);padding:16px;text-align:center;font-size:13px}</style></head><body><p>点击帖子查看详情</p></body></html>`;
    }
}

function getPanelTitle(): string { return isStealth() ? "README.md" : "帖子"; }
function isStealth(): boolean { return vscode.workspace.getConfiguration("heybox").get<boolean>("stealthMode", false); }