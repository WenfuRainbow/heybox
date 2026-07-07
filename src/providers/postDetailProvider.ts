import * as vscode from "vscode";
import { PostTreeResult } from "../types";
import { postHtml } from "../utils/htmlRenderer";

export class PostDetailViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "heybox.postDetail";
    private _view?: vscode.WebviewView;
    private _currentPost: PostTreeResult | undefined;
    private _foldedTips: string = "";

    constructor(private readonly extensionUri: vscode.Uri) {}

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

    getCurrentPost(): PostTreeResult | undefined { return this._currentPost; }

    isViewVisible(): boolean { return !!this._view; }

    showPost(postTree: PostTreeResult, commentNote?: string, foldedTips?: string): void {
        this._currentPost = postTree;
        this._foldedTips = foldedTips || "";
        if (this._view) {
            this._view.show?.(true);
            this._view.webview.html = postHtml(postTree, isStealth(), commentNote, foldedTips);
            this._view.title = isStealth() ? "README.md" : (postTree.link.title || "帖子");
        }
    }

    private placeholderHtml(): string {
        return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>body{font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground);padding:16px;text-align:center;font-size:13px}</style></head><body><p>点击帖子查看详情</p></body></html>`;
    }
}

function getPanelTitle(): string { return isStealth() ? "README.md" : "帖子"; }
function isStealth(): boolean { return vscode.workspace.getConfiguration("heybox").get<boolean>("stealthMode", false); }