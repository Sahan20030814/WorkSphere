import {
  OfflineSyncQueueManager,
  generateIdempotencyKey,
} from "@/lib/offlineSyncQueue";

/**
 * Regression tests: the offline queue used to dedupe on a key that ignored
 * nested payload fields (JSON.stringify's array replacer is an allow-list at
 * every depth) and it kept the OLD payload when a newer one was enqueued under
 * the same id, so legitimate offline mutations were silently dropped.
 */
describe("generateIdempotencyKey payload identity", () => {
  it("distinguishes payloads that differ only in nested fields", () => {
    const a = generateIdempotencyKey("review", {
      venueId: "v1",
      review: { rating: 5, text: "great" },
    });
    const b = generateIdempotencyKey("review", {
      venueId: "v1",
      review: { rating: 1, text: "awful" },
    });
    expect(a).not.toBe(b);
  });

  it("distinguishes payloads that differ only inside arrays of objects", () => {
    const a = generateIdempotencyKey("order", { items: [{ sku: "A", qty: 1 }] });
    const b = generateIdempotencyKey("order", { items: [{ sku: "A", qty: 2 }] });
    expect(a).not.toBe(b);
  });

  it("is independent of key order at every nesting level", () => {
    const a = generateIdempotencyKey("t", { a: 1, b: { x: 1, y: [{ p: 1, q: 2 }] } });
    const b = generateIdempotencyKey("t", { b: { y: [{ q: 2, p: 1 }], x: 1 }, a: 1 });
    expect(a).toBe(b);
  });

  it("treats array order, string-vs-number and undefined properties correctly", () => {
    expect(generateIdempotencyKey("t", { a: [1, 2] })).not.toBe(
      generateIdempotencyKey("t", { a: [2, 1] }),
    );
    expect(generateIdempotencyKey("t", "5")).not.toBe(generateIdempotencyKey("t", 5));
    expect(generateIdempotencyKey("t", { a: 1, b: undefined })).toBe(
      generateIdempotencyKey("t", { a: 1 }),
    );
  });

  it("does not throw on circular payloads", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(generateIdempotencyKey("t", circular)).toMatch(/^sync_t_/);
  });
});

describe("OfflineSyncQueueManager latest-payload-wins for the same id", () => {
  it("keeps both mutations that differ only in nested fields", () => {
    const queue = new OfflineSyncQueueManager();
    queue.enqueue("review", { venueId: "v1", review: { rating: 5 } });
    queue.enqueue("review", { venueId: "v1", review: { rating: 1 } });
    expect(queue.getStats().total).toBe(2);
  });

  it("replaces the payload of a pending item enqueued again with new content", () => {
    const queue = new OfflineSyncQueueManager();
    const first = queue.enqueue("note", { text: "v1" }, { id: "note:n1" });
    const second = queue.enqueue("note", { text: "v2" }, { id: "note:n1" });

    expect(second).toBe(first);
    expect(queue.getStats().total).toBe(1);
    expect(queue.getItem("note:n1")?.payload).toEqual({ text: "v2" });
  });

  it("resets a backing-off retry item so the newest payload is sent immediately", () => {
    const queue = new OfflineSyncQueueManager();
    const item = queue.enqueue("note", { text: "v1" }, { id: "note:n1" });
    item.status = "retry";
    item.attempts = 3;
    item.nextAttemptAt = Date.now() + 60_000;

    queue.enqueue("note", { text: "v2" }, { id: "note:n1" });

    expect(item.status).toBe("pending");
    expect(item.attempts).toBe(0);
    expect(item.nextAttemptAt).toBeLessThanOrEqual(Date.now());
    expect(item.payload).toEqual({ text: "v2" });
  });

  it("still treats an identical payload as a pure duplicate", () => {
    const queue = new OfflineSyncQueueManager();
    const item = queue.enqueue("note", { text: "v1" }, { id: "note:n1" });
    item.status = "processing";

    const again = queue.enqueue("note", { text: "v1" }, { id: "note:n1" });

    expect(again).toBe(item);
    expect(item.pendingPayload).toBeUndefined();
  });

  it("sends an edit made while the previous attempt was in flight, after it settles", async () => {
    const queue = new OfflineSyncQueueManager({ concurrency: 1 });
    queue.enqueue("note", { text: "v1" }, { id: "note:n1" });

    const sent: string[] = [];
    let release: () => void = () => undefined;
    const processing = queue.process(async (item) => {
      sent.push((item.payload as { text: string }).text);
      if (sent.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const during = queue.enqueue("note", { text: "v2" }, { id: "note:n1" });
    expect(during.pendingPayload).toEqual({ payload: { text: "v2" } });
    expect(during.payload).toEqual({ text: "v1" });

    release();
    await processing;

    expect(sent).toEqual(["v1", "v2"]);
    const final = queue.getItem("note:n1");
    expect(final?.status).toBe("completed");
    expect(final?.pendingPayload).toBeUndefined();
  });

  it("still sends the latest payload when the in-flight attempt fails permanently", async () => {
    const queue = new OfflineSyncQueueManager({ concurrency: 1 });
    queue.enqueue("note", { text: "v1" }, { id: "note:n1" });

    const sent: string[] = [];
    let release: () => void = () => undefined;
    const processing = queue.process(async (item) => {
      sent.push((item.payload as { text: string }).text);
      if (sent.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw Object.assign(new Error("bad request"), { status: 400 });
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    queue.enqueue("note", { text: "v2" }, { id: "note:n1" });
    release();
    await processing;

    expect(sent).toEqual(["v1", "v2"]);
    expect(queue.getItem("note:n1")?.status).toBe("completed");
  });
});
