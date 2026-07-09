import * as crypto from "crypto";

/**
 * 自定义字母表，用于将字节值映射为特定字符
 * 签名算法中的字符替换都基于此表
 */
const ALPHABET = "AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89";

/** 计算 MD5 哈希，返回十六进制字符串 */
function md5(input: string): string {
    return crypto.createHash("md5").update(input).digest("hex");
}

/**
 * 以下 vm / qm / dollarM / ym / gm / km 是一组字节级位变换函数
 * 用于对 MD5 哈希的尾部字节进行混淆变换，生成最终校验码
 */

/** 左移一位，若最高位为 1 则异或多项式 0x1B（GF(2^8) 乘法） */
function vm(e: number): number {
    return 128 & e ? 255 & (e << 1 ^ 27) : e << 1;
}

/** vm 结果与原值异或 */
function qm(e: number): number {
    return vm(e) ^ e;
}

/** 嵌套变换：qm(vm(e)) */
function dollarM(e: number): number {
    return qm(vm(e));
}

/** 多层嵌套：dollarM(qm(vm(e))) */
function ym(e: number): number {
    return dollarM(qm(vm(e)));
}

/** 组合变换：ym ^ dollarM ^ qm */
function gm(e: number): number {
    return ym(e) ^ dollarM(e) ^ qm(e);
}

/**
 * 4 字节矩阵变换：将 4 个字节通过 gm/qm/dollarM/ym 的交叉组合
 * 产生新的 4 字节输出，用于生成校验码
 */
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

/**
 * 将文本字符通过字母表前 offset 个字符进行编码映射
 * offset 为负数时取字母表尾部
 */
function av(text: string, alphabet: string, offset: number): string {
    let result = "";
    const sliced = alphabet.slice(0, offset);
    for (let i = 0; i < text.length; i++) {
        result += sliced[text.charCodeAt(i) % sliced.length];
    }
    return result;
}

/** 将文本字符通过完整字母表进行编码映射 */
function sv(text: string, alphabet: string): string {
    let result = "";
    for (let i = 0; i < text.length; i++) {
        result += alphabet[text.charCodeAt(i) % alphabet.length];
    }
    return result;
}

/** 将多个字符串按列交错拼接（interleave），用于混合编码结果 */
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

/**
 * 核心签名生成函数
 *
 * 算法步骤：
 * 1. 规范化 API 路径（统一首尾斜杠，过滤空段）
 * 2. 分别对时间戳、路径、nonce 进行字母表编码
 * 3. 将三个编码结果交错拼接并截取前 20 位
 * 4. 对截取结果计算 MD5
 * 5. 取 MD5 末尾 6 个字符的 ASCII 码，经 km 矩阵变换后求和取模 100 作为校验码
 * 6. 取 MD5 前 5 位进行字母表编码作为前缀
 * 7. 拼接前缀 + 校验码返回
 */
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

/** API 请求签名数据 */
export interface Signature {
    /** 签名密钥 */
    hkey: string;
    /** 请求时间戳（秒） */
    _time: number;
    /** 随机 nonce（大写 MD5） */
    nonce: string;
}

/**
 * 为指定 API 路径生成请求签名
 * @param apiPath API 路径，如 "/forum/v2/link"
 * @returns 包含 hkey、时间戳、nonce 的签名对象
 */
export function generateSignature(apiPath: string): Signature {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = md5(
        timestamp + Math.random().toString()
    ).toUpperCase();
    // timestamp + 1 作为签名中的时间偏移
    const hkey = ov(apiPath, timestamp + 1, nonce);
    return { hkey, _time: timestamp, nonce };
}
