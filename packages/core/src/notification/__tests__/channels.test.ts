import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InAppChannel, TelegramChannel, NoopChannel } from "../channels";
import type { NotificationPayload, NotificationItem } from "../types";

function makePayload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    id: "test_id",
    userId: "u1",
    txHash: "0xabc123def456",
    chainId: "eip155:1",
    chainName: "Ethereum Mainnet",
    status: "confirmed",
    title: "Test",
    body: "Test body",
    valueFormatted: "100 USDC",
    explorerUrl: "https://etherscan.io/tx/0xabc123def456",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── InAppChannel ──────────────────────────────────────────────────────

describe("InAppChannel", () => {
  let channel: InAppChannel;

  beforeEach(() => {
    channel = new InAppChannel();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("basic capabilities", () => {
    it("should have correct id and name", () => {
      expect(channel.id).toBe("inapp");
      expect(channel.name).toBe("In-App Toast");
    });

    it("should always be available", () => {
      expect(channel.isAvailable()).toBe(true);
    });

    it("should return capabilities", () => {
      const caps = channel.getCapabilities();
      expect(caps.supportsRichText).toBe(true);
      expect(caps.isBackground).toBe(false);
    });

    it("should pass health check", async () => {
      await expect(channel.healthCheck()).resolves.toBe(true);
    });
  });

  describe("sending notifications", () => {
    it("should store notification in history after send", async () => {
      await channel.send(makePayload({ id: "n1" }));
      expect(channel.getHistory()).toHaveLength(1);
      const item = channel.getHistory()[0];
      expect(item.id).toBe("n1");
      expect(item.title).toBe("Test");
      expect(item.read).toBe(false);
    });

    it("should convert payload to NotificationItem correctly", async () => {
      const payload = makePayload({
        id: "n_convert",
        status: "failed",
        chainName: "Polygon",
        valueFormatted: "50 MATIC",
      });

      await channel.send(payload);
      const item = channel.getHistory()[0];
      expect(item.status).toBe("failed");
      expect(item.chainName).toBe("Polygon");
      expect(item.valueFormatted).toBe("50 MATIC");
      expect(item.read).toBe(false);
    });

    it("should fire onNotification callback when configured", async () => {
      const cb = vi.fn();
      const ch = new InAppChannel({ onNotification: cb });
      await ch.send(makePayload({ id: "n_cb" }));

      expect(cb).toHaveBeenCalledTimes(1);
      const item = cb.mock.calls[0][0] as NotificationItem;
      expect(item.id).toBe("n_cb");
    });

    it("should trim history beyond max", async () => {
      const ch = new InAppChannel({ maxHistory: 3 });
      for (let i = 0; i < 5; i++) {
        await ch.send(makePayload({ id: `n_trim_${i}` }));
      }
      expect(ch.getHistory()).toHaveLength(3);
      expect(ch.getHistory()[0].id).toBe("n_trim_2"); // oldest trimmed
    });
  });

  describe("history management", () => {
    it("should mark a single notification as read", async () => {
      await channel.send(makePayload({ id: "read1" }));
      await channel.send(makePayload({ id: "read2" }));

      channel.markAsRead("read1");
      const items = channel.getHistory();
      expect(items.find((n) => n.id === "read1")!.read).toBe(true);
      expect(items.find((n) => n.id === "read2")!.read).toBe(false);
    });

    it("should mark all as read", async () => {
      await channel.send(makePayload({ id: "all1" }));
      await channel.send(makePayload({ id: "all2" }));

      channel.markAllAsRead();
      expect(channel.getHistory().every((n) => n.read)).toBe(true);
    });

    it("should clear history", async () => {
      await channel.send(makePayload({ id: "clear1" }));
      channel.clear();
      expect(channel.getHistory()).toHaveLength(0);
    });

    it("should return correct unread count", async () => {
      await channel.send(makePayload({ id: "u1" }));
      await channel.send(makePayload({ id: "u2" }));
      await channel.send(makePayload({ id: "u3" }));
      expect(channel.unreadCount).toBe(3);

      channel.markAsRead("u1");
      expect(channel.unreadCount).toBe(2);

      channel.markAllAsRead();
      expect(channel.unreadCount).toBe(0);
    });
  });

  describe("persistence", () => {
    it("should persist and restore history", async () => {
      const store = new Map<string, string>();
      const storage = {
        getItem: vi.fn(async <T>(key: string): Promise<T | null> => {
          const raw = store.get(key);
          if (raw === undefined) return null;
          return JSON.parse(raw) as T;
        }),
        setItem: vi.fn(async <T>(key: string, value: T): Promise<void> => {
          store.set(key, JSON.stringify(value));
        }),
        removeItem: vi.fn(async (key: string): Promise<void> => {
          store.delete(key);
        }),
      };

      const ch1 = new InAppChannel({ storage });
      await ch1.send(makePayload({ id: "persist1" }));
      await ch1.send(makePayload({ id: "persist2" }));

      const ch2 = new InAppChannel({ storage });
      await ch2.restore();
      expect(ch2.getHistory()).toHaveLength(2);
      expect(ch2.getHistory()[0].id).toBe("persist1");
    });
  });
});

// ─── TelegramChannel ───────────────────────────────────────────────────

describe("TelegramChannel", () => {
  it("should have correct id and name", () => {
    const ch = new TelegramChannel({ botToken: "abc", chatId: "123" });
    expect(ch.id).toBe("telegram");
    expect(ch.name).toBe("Telegram");
  });

  it("should be available when bot token is non-empty", () => {
    const ch = new TelegramChannel({ botToken: "abc123", chatId: "123" });
    expect(ch.isAvailable()).toBe(true);
  });

  it("should be unavailable when bot token is empty", () => {
    const ch = new TelegramChannel({ botToken: "", chatId: "0" });
    expect(ch.isAvailable()).toBe(false);
  });

  it("should return capabilities", () => {
    const ch = new TelegramChannel({ botToken: "abc", chatId: "123" });
    const caps = ch.getCapabilities();
    expect(caps.supportsRichText).toBe(true);
    expect(caps.supportsActionButtons).toBe(true);
    expect(caps.maxLength).toBe(4096);
    expect(caps.isBackground).toBe(true);
  });

  it("should use transport when provided", async () => {
    const transport = vi.fn(async () => {});
    const ch = new TelegramChannel({
      botToken: "abc",
      chatId: "123",
      transport,
    });

    const payload = makePayload({ status: "confirmed" });
    await ch.send(payload);

    expect(transport).toHaveBeenCalledTimes(1);
    const [sentPayload, formattedMsg] = transport.mock.calls[0];
    expect(sentPayload.txHash).toBe(payload.txHash);
    expect(formattedMsg).toContain("✅");
    expect(formattedMsg).toContain("confirmed");
    expect(formattedMsg).toContain("Ethereum Mainnet");
  });

  it("should format failed notifications with red emoji", async () => {
    const transport = vi.fn(async () => {});
    const ch = new TelegramChannel({
      botToken: "abc",
      chatId: "123",
      transport,
    });

    await ch.send(makePayload({ status: "failed" }));
    const formatted = transport.mock.calls[0][1] as string;
    expect(formatted).toContain("❌");
  });

  it("should format pending notifications with hourglass emoji", async () => {
    const transport = vi.fn(async () => {});
    const ch = new TelegramChannel({
      botToken: "abc",
      chatId: "123",
      transport,
    });

    await ch.send(makePayload({ status: "pending" }));
    const formatted = transport.mock.calls[0][1] as string;
    expect(formatted).toContain("⏳");
  });

  it("should include explorer link when available", async () => {
    const transport = vi.fn(async () => {});
    const ch = new TelegramChannel({
      botToken: "abc",
      chatId: "123",
      transport,
    });

    await ch.send(
      makePayload({
        status: "confirmed",
        explorerUrl: "https://etherscan.io/tx/0xabc",
      }),
    );
    const formatted = transport.mock.calls[0][1] as string;
    expect(formatted).toContain("etherscan.io");
  });

  it("should shorten long tx hashes", async () => {
    const transport = vi.fn(async () => {});
    const ch = new TelegramChannel({
      botToken: "abc",
      chatId: "123",
      transport,
    });

    await ch.send(
      makePayload({
        txHash: "0xabcdef1234567890abcdef1234567890abcdef12",
      }),
    );
    const formatted = transport.mock.calls[0][1] as string;
    expect(formatted).toContain("0xabcdef");
    expect(formatted).toContain("ef12");
  });

  it("should pass health check when available", async () => {
    const ch = new TelegramChannel({ botToken: "abc", chatId: "123" });
    await expect(ch.healthCheck()).resolves.toBe(true);
  });

  it("should log to console when no transport is provided (default)", async () => {
    const ch = new TelegramChannel({ botToken: "abc", chatId: "123" });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await ch.send(makePayload());

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ─── NoopChannel ───────────────────────────────────────────────────────

describe("NoopChannel", () => {
  it("should be available", () => {
    const ch = new NoopChannel();
    expect(ch.isAvailable()).toBe(true);
  });

  it("should have correct id", () => {
    const ch = new NoopChannel();
    expect(ch.id).toBe("noop");
  });

  it("should do nothing on send", async () => {
    const ch = new NoopChannel();
    await expect(ch.send(makePayload())).resolves.toBeUndefined();
  });
});
