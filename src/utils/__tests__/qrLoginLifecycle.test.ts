import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import test from "node:test";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

test("cancelling QR login rejects an in-flight success before credentials are stored", async () => {
    const nodeRequire = createRequire(__filename);
    const pending = deferred<any>();
    const entered = deferred<void>();
    let disposeHandler: (() => void) | undefined;
    let stores = 0;
    let successes = 0;
    const panel: any = {
        reveal() {},
        webview: {
            html: "", postMessage: async () => true,
            onDidReceiveMessage: () => ({ dispose() {} }),
        },
        onDidDispose(handler: () => void) { disposeHandler = handler; },
        dispose() { disposeHandler?.(); },
    };
    const vscodeStub = {
        ViewColumn: { Active: 1 },
        window: { createWebviewPanel: () => panel },
    };
    const originalLoad = (Module as any)._load;
    (Module as any)._load = function(request: string, parent: unknown, isMain: boolean) {
        if (request === "vscode") return vscodeStub;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const modulePath = nodeRequire.resolve("../../auth/qrLoginPanel");
        delete nodeRequire.cache[modulePath];
        const { showQrLoginPanel } = nodeRequire(modulePath) as typeof import("../../auth/qrLoginPanel");
        const opening = showQrLoginPanel({ subscriptions: { push() {} } } as any, {
            startQrLogin: async () => ({ qrContent: "https://example.invalid/qr", expiresAt: Date.now() + 60_000, cookies: {}, pollParams: {} }),
            pollQrLogin: async () => { entered.resolve(); return pending.promise; },
            setCookie: async () => { stores++; },
        } as any, () => { successes++; }, () => {});
        await entered.promise;
        panel.dispose();
        pending.resolve({ state: "success", cookie: "synthetic", message: "ok", remainingSeconds: 30 });
        await opening;
        assert.equal(stores, 0);
        assert.equal(successes, 0);
    } finally {
        (Module as any)._load = originalLoad;
    }
});
