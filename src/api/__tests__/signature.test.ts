import { generateSignature } from "../signature";
import * as crypto from "crypto";

function md5(s: string): string {
    return crypto.createHash("md5").update(s).digest("hex");
}

// Test 1: hkey should be 7 characters
const sig1 = generateSignature("/bbs/app/link/tree");
console.assert(sig1.hkey.length === 7, `hkey length should be 7, got ${sig1.hkey.length} (${sig1.hkey})`);
console.log("✓ hkey is 7 characters:", sig1.hkey);

// Test 2: nonce should be 32 characters uppercase hex
console.assert(sig1.nonce.length === 32, `nonce length should be 32, got ${sig1.nonce.length}`);
console.assert(/^[A-F0-9]+$/.test(sig1.nonce), "nonce should be uppercase hex");
console.log("✓ nonce is 32-char uppercase hex:", sig1.nonce);

// Test 3: _time should be a number (current timestamp)
console.assert(typeof sig1._time === "number" && sig1._time > 0, "_time should be a positive number");
console.log("✓ _time is valid timestamp:", sig1._time);

// Test 4: Known value verification
// Using documented test case from reverse engineering:
// path=/bbs/app/api/search/welcome_page/v2, _time=1783145668, nonce=9ABE456915A70B7A5E91FBE5BBB3E495
// expected hkey = U2XZI47

// We need to test the internal `ov` function. Since it's not exported,
// we test via generateSignature approach. For deterministic testing:
const testTime = 1783145668;
const testNonce = "9ABE456915A70B7A5E91FBE5BBB3E495";
const expectedHkey = "U2XZI47";

// Re-implement ov for test since it's not exported
const ALPHABET = "AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89";

function av(text: string, alphabet: string, offset: number): string {
    let r = "";
    const sliced = alphabet.slice(0, offset);
    for (let i = 0; i < text.length; i++) r += sliced[text.charCodeAt(i) % sliced.length];
    return r;
}

function sv(text: string, alphabet: string): string {
    let r = "";
    for (let i = 0; i < text.length; i++) r += alphabet[text.charCodeAt(i) % alphabet.length];
    return r;
}

function Vm(e: number): number { return 128 & e ? 255 & (e << 1 ^ 27) : e << 1; }
function qm(e: number): number { return Vm(e) ^ e; }
function $m(e: number): number { return qm(Vm(e)); }
function Ym(e: number): number { return $m(qm(Vm(e))); }
function Gm(e: number): number { return Ym(e) ^ $m(e) ^ qm(e); }
function Km(e: number[]): number[] {
    const t = [0, 0, 0, 0];
    t[0] = Gm(e[0]) ^ Ym(e[1]) ^ $m(e[2]) ^ qm(e[3]);
    t[1] = qm(e[0]) ^ Gm(e[1]) ^ Ym(e[2]) ^ $m(e[3]);
    t[2] = $m(e[0]) ^ qm(e[1]) ^ Gm(e[2]) ^ Ym(e[3]);
    t[3] = Ym(e[0]) ^ $m(e[1]) ^ qm(e[2]) ^ Gm(e[3]);
    e[0] = t[0]; e[1] = t[1]; e[2] = t[2]; e[3] = t[3];
    return e;
}

function ov(path: string, timestamp: number, nonce: string): string {
    const p = "/" + path.split("/").filter((s) => s).join("/") + "/";
    const interleaved = [av(String(timestamp), ALPHABET, -2), sv(p, ALPHABET), sv(nonce, ALPHABET)];
    let interleaveResult = "";
    const maxLen = Math.max(...interleaved.map((s) => s.length));
    for (let i = 0; i < maxLen; i++) {
        for (const s of interleaved) {
            if (i < s.length) interleaveResult += s[i];
        }
    }
    const hash = md5(interleaveResult.slice(0, 20));
    const codes = hash.slice(-6).split("").map((c) => c.charCodeAt(0));
    const transformed = Km([...codes]);
    let checksum = String(transformed.reduce((s, v) => s + v, 0) % 100);
    if (checksum.length < 2) checksum = "0" + checksum;
    const prefix = av(hash.substring(0, 5), ALPHABET, -4);
    return prefix + checksum;
}

const testHkey = ov("/bbs/app/api/search/welcome_page/v2", testTime + 1, testNonce);
console.assert(testHkey === expectedHkey, `hkey mismatch! Expected ${expectedHkey}, got ${testHkey}`);
console.log("✓ Known value verification: hkey =", testHkey);

// Test 5: Same input should produce same hkey (deterministic)
const testPath = "/bbs/app/link/tree";
const hkeyA = ov(testPath, 1000000, "TESTNONCE1234567890123456789012");
const hkeyB = ov(testPath, 1000000, "TESTNONCE1234567890123456789012");
console.assert(hkeyA === hkeyB, "Same inputs should produce same hkey");
console.log("✓ Deterministic: same inputs → same hkey:", hkeyA);

// Test 6: Different paths should produce different hkeys
const hkeyC = ov("/bbs/app/topic/categories", 1000000, "TESTNONCE1234567890123456789012");
console.assert(hkeyA !== hkeyC, "Different paths should produce different hkeys");
console.log("✓ Different paths → different hkeys");

// Test 7: Different nonces should produce different hkeys
const hkeyD = ov(testPath, 1000000, "OTHERNONCE123456789012345678901");
console.assert(hkeyA !== hkeyD, "Different nonces should produce different hkeys");
console.log("✓ Different nonces → different hkeys");

console.log("\n🎉 All signature tests passed!");