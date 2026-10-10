/**
 * Resilient Offline Background Sync Queue with Exponential Backoff, Jitter,
 * Concurrency Throttling, and Dead-Letter Queue (DLQ) handling.
 */

export type SyncItemStatus =
  | "pending"
  | "processing"
  | "retry"
  | "completed"
  | "dead_letter";

export interface SyncQueueItem<T = unknown> {
  id: string;
  type: string;
  payload: T;
  status: SyncItemStatus;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  maxRetries: number;
  nextAttemptAt: number;
  /**
   * Newer payload enqueued under the same id while this item was being
   * processed. It is applied (latest wins) as soon as the in-flight attempt
   * settles, so a late edit is never dropped.
   */
  pendingPayload?: { payload: T };
  lastError?: string;
  failureReason?:
    | "unrecoverable_client_error"
    | "max_retries_exceeded"
    | "storage_quota_exceeded"
    | string;
}

export interface QueueConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
  concurrency: number;
  jitterFactor: number;
  maxQueueSize?: number;
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  maxRetries: 5,
  concurrency: 3,
  jitterFactor: 0.5,
  maxQueueSize: 5000,
};

export interface QueueStats {
  pending: number;
  processing: number;
  retry: number;
  completed: number;
  deadLetter: number;
  total: number;
}

export type SyncQueueEventType =
  | "queue:start"
  | "queue:progress"
  | "queue:item_success"
  | "queue:item_retry"
  | "queue:item_dlq"
  | "queue:drained"
  | "queue:idle";

export interface SyncQueueEvent {
  type: SyncQueueEventType;
  item?: SyncQueueItem;
  stats: QueueStats;
  error?: Error;
}

export class SyncError extends Error {
  public readonly status?: number;
  public readonly isPermanent?: boolean;

  constructor(message: string, status?: number, isPermanent?: boolean) {
    super(message);
    this.name = "SyncError";
    this.status = status;
    this.isPermanent =
      isPermanent ??
      (status !== undefined &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 429);
  }
}

/**
 * Determines whether an error is an unrecoverable client error (e.g. HTTP 400 Bad Request, 422 Unprocessable Entity)
 * that should immediately transition to dead-letter queue without pointless retries.
 */
export function isPermanentClientError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === "object") {
    const maybeErr = err as {
      status?: number;
      statusCode?: number;
      isPermanent?: boolean;
      message?: string;
    };
    if (maybeErr.isPermanent === true) return true;
    const status = maybeErr.status ?? maybeErr.statusCode;
    if (typeof status === "number") {
      return status >= 400 && status < 500 && status !== 408 && status !== 429;
    }
    if (typeof maybeErr.message === "string") {
      const msg = maybeErr.message.toLowerCase();
      if (
        msg.includes("400") ||
        msg.includes("422") ||
        msg.includes("validation error") ||
        msg.includes("bad request") ||
        msg.includes("unprocessable entity")
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Calculates exponential backoff with full jitter to avoid thundering-herd problems.
 * Formula: delay = min(maxDelay, baseDelay * 2^attempt) + randomJitter
 */
export function calculateBackoff(
  attempt: number,
  config: Partial<QueueConfig> = {},
  randomFn: () => number = Math.random,
): number {
  const base = config.baseDelayMs ?? DEFAULT_QUEUE_CONFIG.baseDelayMs;
  const max = config.maxDelayMs ?? DEFAULT_QUEUE_CONFIG.maxDelayMs;
  const jitterFactor = config.jitterFactor ?? DEFAULT_QUEUE_CONFIG.jitterFactor;

  const rawBackoff = Math.min(max, base * Math.pow(2, Math.max(0, attempt)));
  const jitter = rawBackoff * jitterFactor * randomFn();

  return Math.round(Math.min(max, rawBackoff + jitter));
}

/**
 * Deterministic, order-independent serialization of arbitrary payloads.
 *
 * Unlike `JSON.stringify(obj, Object.keys(obj).sort())`, whose array replacer
 * acts as an allow-list for EVERY nesting level (silently dropping any nested
 * property whose name is not also a top-level key), this walks the whole value
 * and sorts keys at each level, so payloads that differ only in nested data
 * always serialize differently.
 */
function canonicalize(value: unknown, ancestors: unknown[] = []): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
      return String(value);
    case "bigint":
      return `${value}n`;
    case "function":
    case "symbol":
      return "undefined";
  }

  const obj = value as object;
  if (ancestors.includes(obj)) {
    throw new TypeError("Cannot canonicalize circular payload");
  }
  const nextAncestors = [...ancestors, obj];

  const withToJson = obj as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === "function") {
    return canonicalize(withToJson.toJSON(), nextAncestors);
  }

  if (Array.isArray(obj)) {
    return `[${obj
      .map((item) => {
        const text = canonicalize(item, nextAncestors);
        return text === "undefined" ? "null" : text;
      })
      .join(",")}]`;
  }

  const record = obj as Record<string, unknown>;
  const entries: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const text = canonicalize(record[key], nextAncestors);
    if (text === "undefined") continue;
    entries.push(`${JSON.stringify(key)}:${text}`);
  }
  return `{${entries.join(",")}}`;
}

/** 53-bit string hash (cyrb53) - far lower collision odds than a 32-bit hash. */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Generates a deterministic idempotency key for queued offline actions
 * based on entity type and payload content.
 *
 * Two payloads get the same key only when their full (deeply nested,
 * key-order-independent) content is identical, because a key collision makes
 * the queue drop the second mutation as a "duplicate".
 */
export function generateIdempotencyKey<T = unknown>(type: string, payload: T): string {
  try {
    const str = `${type}:${canonicalize(payload)}`;
    // Two independently seeded 53-bit hashes (~106 bits) plus the length.
    const hash = `${cyrb53(str, 0).toString(36)}${cyrb53(str, 1).toString(36)}${str.length.toString(36)}`;
    return `sync_${type}_${hash}`;
  } catch {
    return `sync_${type}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

/**
 * Generates a unique fallback queue item identifier.
 */
export function generateId(): string {
  return `sync_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export class OfflineSyncQueueManager {
  private config: QueueConfig;
  private items: Map<string, SyncQueueItem> = new Map();
  private listeners: Set<(event: SyncQueueEvent) => void> = new Set();
  private activeProcessing = false;
  private abortController: AbortController | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: Partial<QueueConfig> = {}) {
    this.config = { ...DEFAULT_QUEUE_CONFIG, ...config };
  }

  /**
   * Enqueues an action payload for offline sync using deterministic idempotency keys
   * to prevent duplicate queue entries.
   */
  public enqueue<T = unknown>(
    type: string,
    payload: T,
    options: { maxRetries?: number; id?: string } = {},
  ): SyncQueueItem<T> {
    if (this.config.maxQueueSize && this.items.size >= this.config.maxQueueSize) {
      throw new Error(`Sync queue capacity exceeded: max ${this.config.maxQueueSize} items.`);
    }

    const now = Date.now();
    const id = options.id || generateIdempotencyKey(type, payload);

    const existing = this.items.get(id);
    if (
      existing &&
      (existing.status === "pending" ||
        existing.status === "processing" ||
        existing.status === "retry")
    ) {
      // Same id, same content: a true duplicate.
      if (this.hasSamePayload(existing.payload, payload)) {
        return existing as SyncQueueItem<T>;
      }

      // Same id, NEW content (e.g. a second offline edit of the same entity).
      // Latest wins - returning the existing item would silently discard it.
      if (existing.status === "processing") {
        // An attempt with the old payload is in flight; apply once it settles.
        existing.pendingPayload = { payload };
      } else {
        existing.payload = payload;
        existing.status = "pending";
        existing.attempts = 0;
        existing.nextAttemptAt = now;
        existing.lastError = undefined;
        existing.failureReason = undefined;
      }
      existing.updatedAt = now;
      this.emitEvent("queue:progress", existing);
      return existing as SyncQueueItem<T>;
    }

    const item: SyncQueueItem<T> = {
      id,
      type,
      payload,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      maxRetries: options.maxRetries ?? this.config.maxRetries,
      nextAttemptAt: now,
    };

    this.items.set(id, item as SyncQueueItem);
    this.emitEvent("queue:progress", item as SyncQueueItem);
    return item;
  }

  private hasSamePayload(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    try {
      return canonicalize(a) === canonicalize(b);
    } catch {
      return false;
    }
  }

  /**
   * Retrieves a single queue item by ID.
   */
  public getItem(id: string): SyncQueueItem | undefined {
    return this.items.get(id);
  }

  /**
   * Retrieves items optionally filtered by status.
   */
  public getItems(status?: SyncItemStatus): SyncQueueItem[] {
    const all = Array.from(this.items.values());
    if (!status) return all;
    return all.filter((i) => i.status === status);
  }

  /**
   * Aggregates item counts by current status.
   */
  public getStats(): QueueStats {
    let pending = 0;
    let processing = 0;
    let retry = 0;
    let completed = 0;
    let deadLetter = 0;

    for (const item of this.items.values()) {
      switch (item.status) {
        case "pending":
          pending++;
          break;
        case "processing":
          processing++;
          break;
        case "retry":
          retry++;
          break;
        case "completed":
          completed++;
          break;
        case "dead_letter":
          deadLetter++;
          break;
      }
    }

    return {
      pending,
      processing,
      retry,
      completed,
      deadLetter,
      total: this.items.size,
    };
  }

  /**
   * Subscribe to queue lifecycle and progress events.
   */
  public subscribe(listener: (event: SyncQueueEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Returns true if queue processing is actively executing.
   */
  public isProcessing(): boolean {
    return this.activeProcessing;
  }

  /**
   * Cancels active queue processing.
   */
  public cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    this.activeProcessing = false;
    this.emitEvent("queue:idle");
  }

  /**
   * Clears all items from the queue.
   */
  public clear(): void {
    this.cancel();
    this.items.clear();
    this.emitEvent("queue:progress");
  }

  /**
   * Purges completed items to prevent memory unbounded growth.
   */
  public clearCompleted(): number {
    let purged = 0;
    for (const [id, item] of this.items.entries()) {
      if (item.status === "completed") {
        this.items.delete(id);
        purged++;
      }
    }
    if (purged > 0) {
      this.emitEvent("queue:progress");
    }
    return purged;
  }

  /**
   * Re-queues a dead-letter item (or all dead-letter items) for retry.
   */
  public retryDeadLetter(id?: string): number {
    const now = Date.now();
    let count = 0;

    if (id) {
      const item = this.items.get(id);
      if (item && item.status === "dead_letter") {
        item.status = "pending";
        item.attempts = 0;
        item.nextAttemptAt = now;
        item.updatedAt = now;
        item.lastError = undefined;
        item.failureReason = undefined;
        count++;
        this.emitEvent("queue:progress", item);
      }
    } else {
      for (const item of this.items.values()) {
        if (item.status === "dead_letter") {
          item.status = "pending";
          item.attempts = 0;
          item.nextAttemptAt = now;
          item.updatedAt = now;
          item.lastError = undefined;
          item.failureReason = undefined;
          count++;
        }
      }
      if (count > 0) {
        this.emitEvent("queue:progress");
      }
    }

    return count;
  }

  /**
   * Milliseconds until the earliest retry item becomes ready, or null when
   * no retry items are waiting.
   */
  public getNextRetryDelay(): number | null {
    const now = Date.now();
    let min: number | null = null;
    for (const item of this.items.values()) {
      if (item.status !== "retry") continue;
      const delay = item.nextAttemptAt - now;
      if (min === null || delay < min) min = Math.max(0, delay);
    }
    return min;
  }

  /**
   * Processes ready items using concurrency-limited workers.
   */
  public async process(
    handler: (item: SyncQueueItem) => Promise<void>,
  ): Promise<QueueStats> {
    if (this.activeProcessing) {
      return this.getStats();
    }

    this.activeProcessing = true;
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }

    this.emitEvent("queue:start");

    try {
      while (this.activeProcessing && !signal.aborted) {
        const now = Date.now();

        // Get ready items (pending or retry where nextAttemptAt <= now)
        const readyItems = Array.from(this.items.values()).filter(
          (item) =>
            (item.status === "pending" || item.status === "retry") &&
            item.nextAttemptAt <= now,
        );

        if (readyItems.length === 0) {
          break;
        }

        // Process up to `concurrency` items concurrently
        const batch = readyItems.slice(0, this.config.concurrency);

        await Promise.all(
          batch.map(async (item) => {
            if (signal.aborted) return;
            await this.processItem(item, handler);
          }),
        );
      }
    } finally {
      this.activeProcessing = false;
      this.abortController = null;
      const finalStats = this.getStats();

      if (finalStats.pending === 0 && finalStats.retry === 0) {
        this.emitEvent("queue:drained");
      } else {
        this.emitEvent("queue:idle");
        const nextDelay = this.getNextRetryDelay();
        if (nextDelay !== null && nextDelay > 0 && !signal.aborted) {
          this.wakeTimer = setTimeout(() => {
            this.wakeTimer = null;
            this.process(handler).catch(() => undefined);
          }, nextDelay);
          const timer = this.wakeTimer as unknown as { unref?: () => void };
          if (typeof timer.unref === "function") timer.unref();
        }
      }
    }

    return this.getStats();
  }

  /**
   * Processes a single item with error handling, backoff, and DLQ escalation.
   */
  private async processItem(
    item: SyncQueueItem,
    handler: (item: SyncQueueItem) => Promise<void>,
  ): Promise<void> {
    const now = Date.now();
    item.status = "processing";
    item.updatedAt = now;
    item.attempts++;
    this.emitEvent("queue:progress", item);

    try {
      await handler(item);

      item.status = "completed";
      item.updatedAt = Date.now();
      item.lastError = undefined;
      item.failureReason = undefined;
      this.emitEvent("queue:item_success", item);
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : String(err || "Unknown error");
      item.updatedAt = Date.now();
      item.lastError = errorMsg;

      const permanent = isPermanentClientError(err);

      if (permanent || item.attempts >= item.maxRetries) {
        // Permanent 4xx client error OR exceeded maximum retry attempts -> escalate to Dead-Letter Queue
        item.status = "dead_letter";
        item.failureReason = permanent
          ? "unrecoverable_client_error"
          : "max_retries_exceeded";
        this.emitEvent(
          "queue:item_dlq",
          item,
          err instanceof Error ? err : new Error(errorMsg),
        );
      } else {
        // Schedule next retry with exponential backoff & jitter
        const delay = calculateBackoff(item.attempts, this.config);
        item.status = "retry";
        item.nextAttemptAt = Date.now() + delay;
        this.emitEvent(
          "queue:item_retry",
          item,
          err instanceof Error ? err : new Error(errorMsg),
        );
      }
    }

    // A newer payload arrived for this id while the attempt was in flight.
    // Whatever the outcome of the old attempt, the latest payload must be sent.
    if (item.pendingPayload) {
      item.payload = item.pendingPayload.payload;
      item.pendingPayload = undefined;
      item.status = "pending";
      item.attempts = 0;
      item.nextAttemptAt = Date.now();
      item.updatedAt = Date.now();
      item.lastError = undefined;
      item.failureReason = undefined;
      this.emitEvent("queue:progress", item);
    }
  }

  private emitEvent(
    type: SyncQueueEventType,
    item?: SyncQueueItem,
    error?: Error,
  ): void {
    const event: SyncQueueEvent = {
      type,
      item,
      stats: this.getStats(),
      error,
    };

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[OfflineSyncQueue] Listener exception:", err);
      }
    }
  }
}

/**
 * Singleton instance for app-wide offline sync queueing.
 */
export const globalSyncQueue = new OfflineSyncQueueManager();

/**
 * Factory helper for custom queue configurations.
 */
export function createOfflineSyncQueue(
  config?: Partial<QueueConfig>,
): OfflineSyncQueueManager {
  return new OfflineSyncQueueManager(config);
}
