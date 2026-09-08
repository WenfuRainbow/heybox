import assert from "node:assert/strict";
import test from "node:test";
import { generateSignature, generateSignatureFor } from "../signature";

test("签名使用七位 hkey 与大写 nonce", () => {
    const signature = generateSignature("/bbs/app/link/tree");
    assert.equal(signature.hkey.length, 7);
    assert.match(signature.nonce, /^[A-F0-9]{32}$/);
    assert.ok(signature._time > 0);
});

test("固定输入生成兼容签名", () => {
    const signature = generateSignatureFor(
        "/bbs/app/api/search/welcome_page/v2",
        1_783_145_668,
        "9ABE456915A70B7A5E91FBE5BBB3E495",
    );
    assert.deepEqual(signature, {
        hkey: "U2XZI47",
        _time: 1_783_145_668,
        nonce: "9ABE456915A70B7A5E91FBE5BBB3E495",
    });
});

test("另一条固定输入保持签名兼容", () => {
    const nonce = "TESTNONCE1234567890123456789012";
    const signature = generateSignatureFor("/bbs/app/link/tree", 1_000_000, nonce);
    assert.equal(signature.hkey, "021TS00");
});
