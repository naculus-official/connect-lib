import { beforeEach, describe, expect, it, vi } from "vitest";
import { SNS_PROGRAM_ID, SNSProvider } from "./sns";

describe("SNSProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: { value: null },
      }),
    } as Response);
  });

  it("derives the canonical Bonfida PDA and sends a base58 RPC key", async () => {
    await new SNSProvider("https://solana.example").resolveName("bonfida.sol");

    const request = JSON.parse(
      vi.mocked(fetch).mock.calls[0][1]?.body as string,
    ) as { params: [string] };
    // Known public vector from the SPL Name Service documentation.
    expect(request.params[0]).toBe(
      "Crf8hzfthWGbGbLTVCiqRqV5MVnbpHB1L9KQMd6gsinb",
    );
  });

  it("requires the response account to be owned by the SNS program", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: {
          value: {
            data: ["11111111111111111111111111111111", "base58"],
            executable: false,
            lamports: 1,
            owner: "11111111111111111111111111111111",
            rentEpoch: 0,
          },
        },
      }),
    } as Response);

    expect(
      await new SNSProvider("https://solana.example").resolveName(
        "bonfida.sol",
      ),
    ).toBeNull();
    expect(SNS_PROGRAM_ID).toBe("namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX");
  });
});
