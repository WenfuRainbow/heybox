import * as vscode from "vscode";
import * as QRCode from "qrcode";
import * as crypto from "crypto";
import { HeyBoxClient, QrLoginSession, QrLoginStatus } from "../api/client";

let activePanel: vscode.WebviewPanel | undefined;

/** 打开并维护小黑盒扫码登录面板；二维码内容和凭证均不离开扩展进程。 */
export async function showQrLoginPanel(
    context: vscode.ExtensionContext,
    client: HeyBoxClient,
    onSuccess: (nickname?: string) => Promise<void> | void,
    onManualLogin: () => Promise<void> | void,
): Promise<void> {
    if (activePanel) {
        activePanel.reveal(vscode.ViewColumn.Active);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        "heybox.qrLogin",
        "小黑盒扫码登录",
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
    );
    activePanel = panel;
    context.subscriptions.push(panel);

    let session: QrLoginSession | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let pollInFlight = false;
    let sessionGeneration = 0;
    let closed = false;
    let terminal = false;
    let webviewReady = false;
    let qrImage = "";
    let lastStatus: QrLoginStatus = { state: "waiting", message: "正在生成二维码…", remainingSeconds: 0 };

    const stopPolling = () => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
    };

    const updateStatus = (status: QrLoginStatus) => {
        lastStatus = status;
        // QrLoginStatus 在成功时还携带 Cookie。Webview 属于权限更低的独立渲染端，
        // 因此绝不能把整个对象跨进程发送给它。
        if (webviewReady) {
            void panel.webview.postMessage({
                type: "status",
                state: status.state,
                message: status.message,
                remainingSeconds: status.remainingSeconds,
            });
        }
    };

    const updateQrImage = (image: string) => {
        qrImage = image;
        if (webviewReady) void panel.webview.postMessage({ type: "qr", image });
    };

    const poll = async () => {
        if (closed || terminal || !session || pollInFlight) return;
        const sessionToPoll = session;
        const generationToPoll = sessionGeneration;
        pollInFlight = true;
        try {
            const status = await client.pollQrLogin(sessionToPoll);
            if (closed || terminal || session !== sessionToPoll || generationToPoll !== sessionGeneration || activePanel !== panel) return;
            updateStatus(status);
            if (status.state === "success" && status.cookie) {
                terminal = true;
                stopPolling();
                await client.setCookie(status.cookie);
                // 写入 SecretStorage 期间面板仍可能被取消。
                // 已废弃的扫码会话绝不能继续进入登录成功流程。
                if (closed || generationToPoll !== sessionGeneration || activePanel !== panel) {
                    if (client.getCookie() === status.cookie) await client.clearCookie();
                    return;
                }
                await onSuccess(status.nickname);
                if (!closed && activePanel === panel) setTimeout(() => panel.dispose(), 900);
            } else if (status.state === "expired" || status.state === "failed") {
                terminal = true;
                stopPolling();
            }
        } catch (error) {
            if (closed || terminal || session !== sessionToPoll || generationToPoll !== sessionGeneration || activePanel !== panel) return;
            // 临时网络波动不废弃仍有效的二维码；下一轮继续尝试。
            updateStatus({
                state: "waiting",
                message: `状态查询失败，将自动重试：${(error as Error).message}`,
                remainingSeconds: session ? Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000)) : 0,
            });
        } finally {
            pollInFlight = false;
        }
    };

    const createSession = async () => {
        const generation = ++sessionGeneration;
        stopPolling();
        terminal = false;
        session = undefined;
        qrImage = "";
        webviewReady = false;
        panel.webview.html = loginHtml();
        updateStatus({ state: "waiting", message: "正在生成二维码…", remainingSeconds: 0 });
        try {
            const nextSession = await client.startQrLogin();
            const nextQrImage = await QRCode.toDataURL(nextSession.qrContent, {
                errorCorrectionLevel: "M",
                margin: 2,
                width: 240,
                color: { dark: "#101820", light: "#ffffffff" },
            });
            if (generation !== sessionGeneration || activePanel !== panel) return;
            session = nextSession;
            updateQrImage(nextQrImage);
            await poll();
            if (!closed && !terminal && generation === sessionGeneration && session === nextSession && activePanel === panel) {
                pollTimer = setInterval(() => { void poll(); }, 2000);
            }
        } catch (error) {
            if (generation !== sessionGeneration || activePanel !== panel) return;
            updateStatus({ state: "failed", message: `获取二维码失败：${(error as Error).message}`, remainingSeconds: 0 });
        }
    };

    panel.webview.onDidReceiveMessage((message) => {
        if (!message || typeof message.command !== "string") return;
        if (message.command === "ready") {
            webviewReady = true;
            if (qrImage) void panel.webview.postMessage({ type: "qr", image: qrImage });
            updateStatus(lastStatus);
        }
        if (message.command === "refresh") void createSession();
        if (message.command === "manual") {
            stopPolling();
            panel.dispose();
            void onManualLogin();
        }
        if (message.command === "cancel") panel.dispose();
    });
    panel.onDidDispose(() => {
        closed = true;
        terminal = true;
        sessionGeneration++;
        session = undefined;
        stopPolling();
        if (activePanel === panel) activePanel = undefined;
    });

    await createSession();
}

function loginHtml(): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
    :root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);font-size:13px}.card{width:min(340px,calc(100vw - 40px));text-align:center;padding:28px 24px;border:1px solid var(--vscode-panel-border);border-radius:12px;background:var(--vscode-sideBar-background);box-shadow:0 6px 22px rgba(0,0,0,.18)}h1{margin:0 0 8px;font-size:19px}.sub{margin:0;color:var(--vscode-descriptionForeground);line-height:1.6}.qr-wrap{height:264px;display:grid;place-items:center;margin:18px 0 12px}.qr{display:none;width:240px;height:240px;padding:5px;background:#fff;border-radius:8px}.spinner{width:30px;height:30px;border:3px solid var(--vscode-progressBar-background);border-top-color:var(--vscode-progressBar-background);border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.status{min-height:22px;color:var(--vscode-descriptionForeground);line-height:1.5}.status.scanned{color:var(--vscode-charts-yellow,#cca700)}.status.success{color:var(--vscode-testing-iconPassed,#73c991)}.status.expired,.status.failed{color:var(--vscode-testing-iconFailed,#f14c4c)}.actions{display:flex;justify-content:center;gap:8px;margin-top:18px}button{padding:6px 12px;border:1px solid var(--vscode-button-border,transparent);border-radius:4px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font:inherit;cursor:pointer}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:hover{background:var(--vscode-button-hoverBackground)}.security{margin:16px 0 0;color:var(--vscode-descriptionForeground);font-size:11px;line-height:1.5}</style></head>
<body><main class="card"><h1>使用小黑盒 App 扫码</h1><p class="sub">打开小黑盒 App，扫描下方二维码并确认登录。</p><div class="qr-wrap"><div id="spinner" class="spinner" aria-label="正在生成二维码"></div><img id="qr" class="qr" alt="小黑盒登录二维码" /></div><div id="status" class="status" role="status">正在生成二维码…</div><div class="actions"><button id="refresh" class="primary">刷新二维码</button><button id="manual">粘贴 Cookie</button><button id="cancel">取消</button></div><p class="security">二维码及登录凭证只在本地处理；凭证将保存在 VS Code 的安全存储中。</p></main>
<script nonce="${nonce}">const api=acquireVsCodeApi(),qr=document.getElementById('qr'),spinner=document.getElementById('spinner'),status=document.getElementById('status');document.getElementById('refresh').addEventListener('click',()=>api.postMessage({command:'refresh'}));document.getElementById('manual').addEventListener('click',()=>api.postMessage({command:'manual'}));document.getElementById('cancel').addEventListener('click',()=>api.postMessage({command:'cancel'}));window.addEventListener('message',event=>{const data=event.data||{};if(data.type==='qr'){qr.src=data.image;qr.style.display='block';spinner.style.display='none';return}if(data.type==='status'){status.textContent=data.message||'';status.className='status '+(data.state||'');if(data.remainingSeconds>0&&data.state!=='success')status.textContent+='（'+data.remainingSeconds+' 秒）'}});api.postMessage({command:'ready'});</script></body></html>`;
}
