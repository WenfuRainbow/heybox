import * as crypto from "crypto";

const ALPHABET = "AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89";

function md5(input: string): string {
    return crypto.createHash("md5").update(input).digest("hex");
}

function vm(e: number): number {
    return 128 & e ? 255 & (e << 1 ^ 27) : e << 1;
}

function qm(e: number): number {
    return vm(e) ^ e;
}

function dollarM(e: number): number {
    return qm(vm(e));
}

function ym(e: number): number {
    return dollarM(qm(vm(e)));
}

function gm(e: number): number {
    return ym(e) ^ dollarM(e) ^ qm(e);
}

function km(e: number[]): number[] {
    const t = [0, 0, 0, 0];
    t[0] = gm(e[0]) ^ ym(e[1]) ^ dollarM(e[2]) ^ qm(e[3]);
    t[1] = qm(e[0]) ^ gm(e[1]) ^ ym(e[2]) ^ dollarM(e[3]);
    t[2] = dollarM(e[0]) ^ qm(e[1]) ^ gm(e[2]) ^ ym(e[3]);
    t[3] = ym(e[0]) ^ dollarM(e[1]) ^ qm(e[2]) ^ gm(e[3]);
    e[0] = t[0];
    e[1] = t[1];
    e[2] = t[2];
    e[3] = t[3];
    return e;
}

function av(text: string, alphabet: string, offset: number): string {
    let result = "";
    const sliced = alphabet.slice(0, offset);
    for (let i = 0; i < text.length; i++) {
        result += sliced[text.charCodeAt(i) % sliced.length];
    }
    return result;
}

function sv(text: string, alphabet: string): string {
    let result = "";
    for (let i = 0; i < text.length; i++) {
        result += alphabet[text.charCodeAt(i) % alphabet.length];
    }
    return result;
}

function interleave(arr: string[]): string {
    let result = "";
    const maxLen = Math.max(...arr.map((s) => s.length));
    for (let i = 0; i < maxLen; i++) {
        for (const s of arr) {
            if (i < s.length) {
                result += s[i];
            }
        }
    }
    return result;
}

function ov(path: string, timestamp: number, nonce: string): string {
    const normalizedPath =
        "/" + path.split("/").filter((s) => s).join("/") + "/";
    const encT = av(String(timestamp), ALPHABET, -2);
    const encP = sv(normalizedPath, ALPHABET);
    const encN = sv(nonce, ALPHABET);
    const interleaved = interleave([encT, encP, encN]).slice(0, 20);
    const hash = md5(interleaved);
    const last6Codes = hash
        .slice(-6)
        .split("")
        .map((c) => c.charCodeAt(0));
    const transformed = km([...last6Codes]);
    let checksum = String(
        transformed.reduce((sum, val) => sum + val, 0) % 100
    );
    if (checksum.length < 2) {
        checksum = "0" + checksum;
    }
    const prefix = av(hash.substring(0, 5), ALPHABET, -4);
    return prefix + checksum;
}

export interface Signature {
    hkey: string;
    _time: number;
    nonce: string;
}

export function generateSignature(apiPath: string): Signature {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = md5(
        timestamp + Math.random().toString()
    ).toUpperCase();
    const hkey = ov(apiPath, timestamp + 1, nonce);
    return { hkey, _time: timestamp, nonce };
}
