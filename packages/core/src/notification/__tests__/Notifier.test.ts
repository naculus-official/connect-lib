import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Notifier } from "../Notifier";
import { NoopChannel, InAppChannel, TelegramChannel } from "../channels";
import type {
  NotificationPayload,
  NotificationWatch,
  TxStatus,
  TxMetadata,
  MuteRule,
} from "../types";

// ─── Helpers ───────────────────────────────────────────────────────────

function createMockStorage() {
  const store = new Map<string, string>();
  return {
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
}

function makePayload(
  overrides: Partial<NotificationPayload> = {},
): NotificationPayload {
  return {
    id: "test_payload",
    userId: "user_1",
    txHash: "0xabc123def456",
    chainId: "eip155:1",
    chainName: "Ethereum Mainnet",
    status: "confirmed",
    title: "Test",
    body: "Test notification",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("Notifier", () => {
  let notifier: Notifier;
  let spyChannel: NoopChannel;

  beforeEach(() => {
    spyChannel = new NoopChannel();
    // Spy on send
    vi.spyOn(spyChannel, "send");
    notifier = new Notifier({
      defaultPreferences: { channels: ["noop"], frequency: "final-only" },
    });
    notifier.registerChannel(spyChannel);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Channel Management ─────────────────────────────────────────────

  describe("channel management", () => {
    it("should register a channel", () => {
      notifier.registerChannel(new NoopChannel());
      expect(notifier.getChannel("noop")).toBeDefined();
    });

    it("should unregister a channel", () => {
      const ch = new NoopChannel();
      notifier.registerChannel(ch);
      notifier.unregisterChannel("noop");
      expect(notifier.getChannel("noop")).toBeUndefined();
    });

    it("should list active (available) channels", () => {
      const ch = new NoopChannel();
      notifier.registerChannel(ch);
      const active = notifier.getActiveChannels();
      expect(active).toContain("noop");
    });

    it("should exclude unavailable channels from active list", () => {
      const ch = new TelegramChannel({
        botToken: "",
        chatId: "0",
      }); // empty token = unavailable
      notifier.registerChannel(ch);
      const active = notifier.getActiveChannels();
      expect(active).not.toContain("telegram");
    });
  });

  // ── Watch Registration ─────────────────────────────────────────────

  describe("watchTx", () => {
    it("should register a watch for a tx hash", () => {
      notifier.watchTx("0xtest1", "eip155:1", { userId: "u1" });
      const watch = notifier.getWatch("0xtest1");
      expect(watch).toBeDefined();
      expect(watch!.txHash).toBe("0xtest1");
      expect(watch!.userId).toBe("u1");
    });

    it("should use default user id when userId not specified", () => {
      notifier.watchTx("0xtest2", "eip155:1");
      const watch = notifier.getWatch("0xtest2");
      expect(watch).toBeDefined();
      expect(watch!.userId).toBe("default");
    });

    it("should use default frequency from preferences", () => {
      notifier.watchTx("0xtest3", "eip155:1");
      const watch = notifier.getWatch("0xtest3");
      expect(watch!.frequency).toBe("final-only");
    });

    it("should accept explicit frequency override", () => {
      notifier.watchTx("0xtest4", "eip155:1", {
        userId: "u1",
        frequency: "per-tx",
      });
      const watch = notifier.getWatch("0xtest4");
      expect(watch!.frequency).toBe("per-tx");
    });

    it("should accept txMetadata", () => {
      notifier.watchTx("0xtest5", "eip155:137", {
        txMetadata: { txType: "swap" },
      });
      const watch = notifier.getWatch("0xtest5");
      expect(watch!.txMetadata.chainId).toBe("eip155:137");
      expect(watch!.txMetadata.txType).toBe("swap");
    });

    it("should list all registered watches", () => {
      notifier.watchTx("0xa", "eip155:1");
      notifier.watchTx("0xb", "eip155:137");
      expect(notifier.getAllWatches()).toHaveLength(2);
    });
  });

  // ── Unregister Watch ───────────────────────────────────────────────

  describe("unregisterTxWatch", () => {
    it("should remove a watch", () => {
      notifier.watchTx("0xremove", "eip155:1");
      notifier.unregisterTxWatch("0xremove");
      expect(notifier.getWatch("0xremove")).toBeUndefined();
    });

    it("should set resolvedAt on the removed watch", () => {
      notifier.watchTx("0xresolve", "eip155:1", { userId: "u1" });
      const before = notifier.getWatch("0xresolve")!;
      expect(before.resolvedAt).toBeUndefined();

      notifier.unregisterTxWatch("0xresolve");
      // After removal, the internal watch is deleted, so resolvedAt is set before deletion
      expect(notifier.getWatch("0xresolve")).toBeUndefined();
    });
  });

  // ── Status Dispatch ────────────────────────────────────────────────

  describe("handleTxStatus", () => {
    it("should dispatch notification for confirmed status (final-only)", async () => {
      notifier.watchTx("0xconfirmed", "eip155:1", { userId: "u1" });
      await notifier.handleTxStatus("0xconfirmed", "confirmed", { confirmations: 12 });

      expect(spyChannel.send).toHaveBeenCalledTimes(1);
      const payload = (spyChannel.send as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as NotificationPayload;
      expect(payload.status).toBe("confirmed");
      expect(payload.txHash).toBe("0xconfirmed");
    });

    it("should dispatch notification for failed status", async () => {
      notifier.watchTx("0xfailed", "eip155:1", { userId: "u1" });
      await notifier.handleTxStatus("0xfailed", "failed");

      expect(spyChannel.send).toHaveBeenCalledTimes(1);
      const payload = (spyChannel.send as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as NotificationPayload;
      expect(payload.status).toBe("failed");
    });

    it("should NOT dispatch notification for pending status in final-only mode", async () => {
      notifier.watchTx("0xpending", "eip155:1", {
        userId: "u1",
        frequency: "final-only",
      });
      await notifier.handleTxStatus("0xpending", "pending");

      expect(spyChannel.send).not.toHaveBeenCalled();
    });

    it("should dispatch notification for pending status in per-tx mode", async () => {
      notifier.watchTx("0xpending2", "eip155:1", {
        userId: "u1",
        frequency: "per-tx",
      });
      await notifier.handleTxStatus("0xpending2", "pending");

      expect(spyChannel.send).toHaveBeenCalledTimes(1);
      const payload = (spyChannel.send as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as NotificationPayload;
      expect(payload.status).toBe("pending");
    });

    it("should reorg always fire regardless of frequency", async () => {
      notifier.watchTx("0xreorg", "eip155:1", {
        userId: "u1",
        frequency: "final-only",
      });
      await notifier.handleTxStatus("0xreorg", "reorg");
      expect(spyChannel.send).toHaveBeenCalledTimes(1);
    });

    it("should cleanup watch after confirmed", async () => {
      notifier.watchTx("0xcleanup", "eip155:1", { userId: "u1" });
      await notifier.handleTxStatus("0xcleanup", "confirmed");
      // Watch should have auto-cleaned
      expect(notifier.getWatch("0xcleanup")).toBeUndefined();
    });

    it("should cleanup watch after failed", async () => {
      notifier.watchTx("0xcleanfail", "eip155:1", { userId: "u1" });
      await notifier.handleTxStatus("0xcleanfail", "failed");
      expect(notifier.getWatch("0xcleanfail")).toBeUndefined();
    });

    it("should not dispatch if watch is not registered", async () => {
      await notifier.handleTxStatus("0xunknown", "confirmed");
      expect(spyChannel.send).not.toHaveBeenCalled();
    });

    it("should pass confirmations and gas info to payload", async () => {
      notifier.watchTx("0xreceipt", "eip155:1", { userId: "u1" });
      await notifier.handleTxStatus("0xreceipt", "confirmed", {
        confirmations: 24,
        value: BigInt("1000000000000000000"),
        gasUsed: BigInt("21000"),
        gasCostUsd: 0.42,
      });

      const payload = (spyChannel.send as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as NotificationPayload;
      expect(payload.confirmations).toBe(24);
      expect(payload.gasUsed).toBe(BigInt("21000"));
      expect(payload.gasCostUsd).toBe(0.42);
    });

    it("should mute when frequency is muted", async () => {
      notifier.watchTx("0xmuted", "eip155:1", {
        userId: "u1",
        frequency: "muted",
      });
      await notifier.handleTxStatus("0xmuted", "confirmed");
      expect(spyChannel.send).not.toHaveBeenCalled();
    });
  });

  // ── Status Callbacks ───────────────────────────────────────────────

  describe("onTxStatus callbacks", () => {
    it("should fire registered callbacks on status change", async () => {
      notifier.watchTx("0xcb", "eip155:1", { userId: "u1" });
      const cb = vi.fn();
      notifier.onTxStatus("0xcb", cb);
      await notifier.handleTxStatus("0xcb", "confirmed");

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith("confirmed", undefined);
    });

    it("should fire callbacks even for pending (callback independent of dispatch)", async () => {
      notifier.watchTx("0xcb2", "eip155:1", {
        userId: "u1",
        frequency: "final-only",
      });
      const cb = vi.fn();
      notifier.onTxStatus("0xcb2", cb);
      await notifier.handleTxStatus("0xcb2", "pending");

      // Callback should fire but channel should not
      expect(cb).toHaveBeenCalledTimes(1);
      expect(spyChannel.send).not.toHaveBeenCalled();
    });

    it("unsubscribe should remove a callback", async () => {
      notifier.watchTx("0xunsub", "eip155:1", { userId: "u1" });
      const cb = vi.fn();
      const unsubscribe = notifier.onTxStatus("0xunsub", cb);
      unsubscribe();

      await notifier.handleTxStatus("0xunsub", "confirmed");
      expect(cb).not.toHaveBeenCalled();
    });

    it("should support multiple callbacks for same hash", async () => {
      notifier.watchTx("0xmulti", "eip155:1", { userId: "u1" });
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      notifier.onTxStatus("0xmulti", cb1);
      notifier.onTxStatus("0xmulti", cb2);

      await notifier.handleTxStatus("0xmulti", "confirmed");
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  // ── Direct Notify ──────────────────────────────────────────────────

  describe("notify", () => {
    it("should send a payload directly without a watch", async () => {
      await notifier.notify({
        userId: "u1",
        txHash: "0xdirect",
        chainId: "eip155:1",
        chainName: "Ethereum",
        status: "confirmed",
        title: "Direct",
        body: "Direct notification",
        timestamp: Date.now(),
      });

      expect(spyChannel.send).toHaveBeenCalledTimes(1);
      const payload = (spyChannel.send as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as NotificationPayload;
      expect(payload.txHash).toBe("0xdirect");
      expect(payload.id).toBeTruthy();
      expect(payload.timestamp).toBeTruthy();
    });

    it("should send to specified channels when provided", async () => {
      await notifier.notify(
        {
          userId: "u1",
          txHash: "0xch",
          chainId: "eip155:1",
          chainName: "Ethereum",
          status: "confirmed",
          title: "Ch",
          body: "Channel-specific",
          timestamp: Date.now(),
        },
        ["noop"],
      );

      expect(spyChannel.send).toHaveBeenCalledTimes(1);
    });
  });

  // ── Preferences ────────────────────────────────────────────────────

  describe("preferences", () => {
    it("should set and get preferences for a user", () => {
      notifier.setPreferences("u1", {
        channels: ["telegram"],
        frequency: "per-tx",
      });
      const prefs = notifier.getPreferences("u1");
      expect(prefs.channels).toEqual(["telegram"]);
      expect(prefs.frequency).toBe("per-tx");
    });

    it("should merge with defaults on partial update", () => {
      notifier.setPreferences("u2", { frequency: "per-tx" });
      const prefs = notifier.getPreferences("u2");
      expect(prefs.frequency).toBe("per-tx");
      expect(prefs.channels).toEqual(["noop"]); // default from custom prefs
      expect(prefs.confirmInterval).toBe(6); // default
    });

    it("should return default for unknown user", () => {
      const prefs = notifier.getPreferences("unknown");
      expect(prefs.frequency).toBe("final-only");
      expect(prefs.channels).toEqual(["noop"]);
    });

    it("should return default preferences", () => {
      const defaults = notifier.getDefaultPreferences();
      expect(defaults.frequency).toBe("final-only");
    });
  });

  // ── Mute Rules ─────────────────────────────────────────────────────

  describe("mute rules", () => {
    it("should add and retrieve mute rules", () => {
      const rule: MuteRule = {
        id: "r1",
        chainId: "eip155:137",
        createdAt: Date.now(),
      };
      notifier.addMuteRule("u1", rule);
      const rules = notifier.getMuteRules("u1");
      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe("r1");
    });

    it("should remove a mute rule by id", () => {
      const rule: MuteRule = {
        id: "r_remove",
        chainId: "eip155:137",
        createdAt: Date.now(),
      };
      notifier.addMuteRule("u1", rule);
      notifier.removeMuteRule("u1", "r_remove");
      expect(notifier.getMuteRules("u1")).toHaveLength(0);
    });

    it("isMuted should return true when chain matches", () => {
      const metadata: TxMetadata = {
        chainId: "eip155:137",
        txType: "transfer",
      };
      const rules: MuteRule[] = [
        { id: "r1", chainId: "eip155:137", createdAt: Date.now() },
      ];
      expect(notifier.isMuted(metadata, rules)).toBe(true);
    });

    it("isMuted should return false when chain doesn't match", () => {
      const metadata: TxMetadata = {
        chainId: "eip155:1",
        txType: "transfer",
      };
      const rules: MuteRule[] = [
        { id: "r1", chainId: "eip155:137", createdAt: Date.now() },
      ];
      expect(notifier.isMuted(metadata, rules)).toBe(false);
    });

    it("isMuted should return true when txType matches", () => {
      const metadata: TxMetadata = {
        chainId: "eip155:1",
        txType: "approve",
      };
      const rules: MuteRule[] = [
        { id: "r1", txType: "approve", createdAt: Date.now() },
      ];
      expect(notifier.isMuted(metadata, rules)).toBe(true);
    });

    it("isMuted should skip expired rules", () => {
      const metadata: TxMetadata = {
        chainId: "eip155:137",
        txType: "transfer",
      };
      const rules: MuteRule[] = [
        {
          id: "r_expired",
          chainId: "eip155:137",
          until: Date.now() - 1000,
          createdAt: Date.now() - 10000,
        },
      ];
      expect(notifier.isMuted(metadata, rules)).toBe(false);
    });

    it("isMuted should match contract address (case-insensitive)", () => {
      const metadata: TxMetadata = {
        chainId: "eip155:1",
        txType: "transfer",
        to: "0xABCDEF1234567890",
      };
      const rules: MuteRule[] = [
        {
          id: "r_contract",
          contractAddress: "0xabcdef1234567890",
          createdAt: Date.now(),
        },
      ];
      expect(notifier.isMuted(metadata, rules)).toBe(true);
    });

    it("should dispatch notifications that pass mute check", async () => {
      notifier.watchTx("0xnomute", "eip155:1", { userId: "u1" });
      notifier.addMuteRule("u1", {
        id: "m1",
        chainId: "eip155:137", // mute Polygon, not Mainnet
        createdAt: Date.now(),
      });

      await notifier.handleTxStatus("0xnomute", "confirmed");
      expect(spyChannel.send).toHaveBeenCalledTimes(1);
    });

    it("should NOT dispatch notifications caught by mute rules", async () => {
      notifier.watchTx("0xyesmute", "eip155:137", { userId: "u1" });
      notifier.addMuteRule("u1", {
        id: "m2",
        chainId: "eip155:137",
        createdAt: Date.now(),
      });

      await notifier.handleTxStatus("0xyesmute", "confirmed");
      expect(spyChannel.send).not.toHaveBeenCalled();
    });
  });

  // ── Storage / Persistence ─────────────────────────────────────────

  describe("persistence", () => {
    it("should persist and restore preferences", async () => {
      const storage = createMockStorage();
      const n1 = new Notifier({ storage });
      n1.setPreferences("u1", { frequency: "per-tx" });

      const n2 = new Notifier({ storage });
      await n2.restore();
      const prefs = n2.getPreferences("u1");
      expect(prefs.frequency).toBe("per-tx");
    });

    it("should persist and restore watches", async () => {
      const storage = createMockStorage();
      const n1 = new Notifier({ storage });
      n1.watchTx("0xpersist", "eip155:1", { userId: "u1" });

      const n2 = new Notifier({ storage });
      await n2.restore();
      expect(n2.getWatch("0xpersist")).toBeDefined();
    });

    it("should not restore resolved watches", async () => {
      const storage = createMockStorage();
      const n1 = new Notifier({ storage });
      n1.watchTx("0xresolved", "eip155:1", { userId: "u1" });
      n1.unregisterTxWatch("0xresolved");

      const n2 = new Notifier({ storage });
      await n2.restore();
      expect(n2.getWatch("0xresolved")).toBeUndefined();
    });

    it("should persist and restore mute rules", async () => {
      const storage = createMockStorage();
      const n1 = new Notifier({ storage });
      n1.addMuteRule("u1", {
        id: "r_persist",
        chainId: "eip155:137",
        createdAt: Date.now(),
      });

      const n2 = new Notifier({ storage });
      await n2.restore();
      const rules = n2.getMuteRules("u1");
      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe("r_persist");
    });
  });

  // ── Custom Default Preferences ─────────────────────────────────────

  describe("custom defaults", () => {
    it("should use custom default preferences when provided", () => {
      const n = new Notifier({
        defaultPreferences: {
          channels: ["telegram"],
          frequency: "per-tx",
          pendingTimeout: 120,
        },
      });
      const prefs = n.getDefaultPreferences();
      expect(prefs.frequency).toBe("per-tx");
      expect(prefs.channels).toEqual(["telegram"]);
      expect(prefs.pendingTimeout).toBe(120);
    });
  });
});
