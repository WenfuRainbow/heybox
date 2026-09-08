import { isRetryableRequestError } from "./errors";

export interface RequestCoordinatorOptions {
    /** 普通请求的最大并发数。 */
    maxConcurrent?: number;
    /** 风控敏感接口的最大并发数。 */
    maxSensitiveConcurrent?: number;
    /** 首次请求之外的最大重试次数。 */
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
}

interface QueuedTask<T> {
    operation: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}

const defaultSleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

/**
 * 合并相同请求、限制并发，并只为短暂错误执行指数退避。
 * 不缓存结果：完成后下一次用户操作会得到新的服务端数据。
 */
export class RequestCoordinator {
    private readonly inFlight = new Map<string, Promise<unknown>>();
    private readonly normalQueue: QueuedTask<unknown>[] = [];
    private readonly sensitiveQueue: QueuedTask<unknown>[] = [];
    private normalActive = 0;
    private sensitiveActive = 0;
    private readonly maxConcurrent: number;
    private readonly maxSensitiveConcurrent: number;
    private readonly maxRetries: number;
    private readonly baseDelayMs: number;
    private readonly maxDelayMs: number;
    private readonly sleep: (delayMs: number) => Promise<void>;

    constructor(options: RequestCoordinatorOptions = {}) {
        this.maxConcurrent = options.maxConcurrent ?? 4;
        this.maxSensitiveConcurrent = options.maxSensitiveConcurrent ?? 1;
        this.maxRetries = options.maxRetries ?? 2;
        this.baseDelayMs = options.baseDelayMs ?? 400;
        this.maxDelayMs = options.maxDelayMs ?? 4_000;
        this.sleep = options.sleep ?? defaultSleep;
    }

    execute<T>(key: string, sensitive: boolean, operation: () => Promise<T>): Promise<T> {
        const existing = this.inFlight.get(key);
        if (existing) return existing as Promise<T>;

        const request = this.enqueue(sensitive, () => this.withRetries(operation));
        this.inFlight.set(key, request);
        const clear = () => {
            if (this.inFlight.get(key) === request) this.inFlight.delete(key);
        };
        void request.then(clear, clear);
        return request;
    }

    private enqueue<T>(sensitive: boolean, operation: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const queue = sensitive ? this.sensitiveQueue : this.normalQueue;
            queue.push({ operation, resolve, reject } as QueuedTask<unknown>);
            this.drain(sensitive);
        });
    }

    private drain(sensitive: boolean): void {
        const queue = sensitive ? this.sensitiveQueue : this.normalQueue;
        const active = sensitive ? this.sensitiveActive : this.normalActive;
        const limit = sensitive ? this.maxSensitiveConcurrent : this.maxConcurrent;
        if (active >= limit || queue.length === 0) return;

        const task = queue.shift()!;
        if (sensitive) this.sensitiveActive++; else this.normalActive++;
        void task.operation().then(task.resolve, task.reject).then(
            () => this.finish(sensitive),
            () => this.finish(sensitive),
        );
        this.drain(sensitive);
    }

    private finish(sensitive: boolean): void {
        if (sensitive) this.sensitiveActive--; else this.normalActive--;
        this.drain(sensitive);
    }

    private async withRetries<T>(operation: () => Promise<T>): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await operation();
            } catch (error) {
                if (attempt >= this.maxRetries || !isRetryableRequestError(error)) throw error;
                const delay = Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs);
                await this.sleep(delay);
            }
        }
    }
}

/** link/tree 与消息轮询会触发更严格的服务端风控。 */
export function isSensitiveApiPath(path: string): boolean {
    return path === "/bbs/app/link/tree"
        || path === "/bbs/app/user/message"
        || path === "/bbs/notify/official_msg_v2/list"
        || path === "/bbs/app/user/discount_message_v2";
}
