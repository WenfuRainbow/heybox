import assert from "node:assert/strict";
import test from "node:test";
import { HeyBoxApiError } from "../errors";
import { RequestCoordinator, isSensitiveApiPath } from "../requestPolicy";

test("相同请求在执行期间只发送一次", async () => {
    const coordinator = new RequestCoordinator();
    let calls = 0;
    const request = () => coordinator.execute("GET /bbs/app/link/tree?id=1", true, async () => {
        calls++;
        return "ok";
    });
    const [first, second] = await Promise.all([request(), request()]);
    assert.equal(first, "ok");
    assert.equal(second, "ok");
    assert.equal(calls, 1);
});

test("短暂服务异常按指数退避后重试", async () => {
    const delays: number[] = [];
    const coordinator = new RequestCoordinator({
        baseDelayMs: 100,
        sleep: async (delay) => { delays.push(delay); },
    });
    let calls = 0;
    const result = await coordinator.execute("retry", false, async () => {
        calls++;
        if (calls < 3) throw new HeyBoxApiError("server", "temporary", true);
        return "recovered";
    });
    assert.equal(result, "recovered");
    assert.equal(calls, 3);
    assert.deepEqual(delays, [100, 200]);
});

test("非幂等写入在临时错误后不会自动重试", async () => {
    const coordinator = new RequestCoordinator({ sleep: async () => { throw new Error("不应等待重试"); } });
    let calls = 0;
    await assert.rejects(
        coordinator.execute("POST /bbs/app/link/favour", false, async () => {
            calls++;
            throw new HeyBoxApiError("server", "temporary", true);
        }, false),
    );
    assert.equal(calls, 1);
});

test("风控敏感接口串行执行", async () => {
    const coordinator = new RequestCoordinator({ maxConcurrent: 2, maxSensitiveConcurrent: 1 });
    let sensitiveActive = 0;
    let sensitivePeak = 0;
    const run = (key: string) => coordinator.execute(key, true, async () => {
        sensitiveActive++;
        sensitivePeak = Math.max(sensitivePeak, sensitiveActive);
        await Promise.resolve();
        sensitiveActive--;
    });
    await Promise.all([run("one"), run("two"), run("three")]);
    assert.equal(sensitivePeak, 1);
});

test("普通请求遵守配置的并发上限", async () => {
    const coordinator = new RequestCoordinator({ maxConcurrent: 2 });
    let active = 0;
    let peak = 0;
    const run = (key: string) => coordinator.execute(key, false, async () => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
    });
    await Promise.all([run("one"), run("two"), run("three")]);
    assert.equal(peak, 2);
});

test("帖子树与消息轮询接口会进入敏感队列", () => {
    assert.equal(isSensitiveApiPath("/bbs/app/link/tree"), true);
    assert.equal(isSensitiveApiPath("/bbs/app/user/message"), true);
    assert.equal(isSensitiveApiPath("/bbs/app/feeds"), false);
});
