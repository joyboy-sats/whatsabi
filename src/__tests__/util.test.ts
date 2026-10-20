import { expect, test, describe, vi, afterEach } from 'vitest';

import { ethers } from "ethers";

import { hexToBytes, bytesToHex, fetchJSON, FetchError, retryDelay429, withRetry } from "../utils";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Utils', () => {
  test.each([
    new Uint8Array([0, 1, 2, 3]),
    new Uint8Array([42, 69, 255]),
    new Uint8Array([255]),
    new Uint8Array([255, 255]),
    new Uint8Array([0, 255, 0, 255]),
  ])("bytesToHex %s", (bytes) => {
    expect(bytesToHex(bytes)).toStrictEqual(ethers.hexlify(bytes));
  });

  test("bytesToHex padding", () => {
    expect(bytesToHex(new Uint8Array([0]), 20)).toStrictEqual("0x0000000000000000000000000000000000000000");
    expect(bytesToHex(new Uint8Array([255, 255, 255]), 20)).toStrictEqual("0x0000000000000000000000000000000000ffffff");
  });


  test.each([
    "0x00010203",
    "0x0000102030",
    "0x2a45ff",
    "0xff",
    "0xffff",
    "0x00ff00ff",
  ])("hexToBytes %s", (hex) => {
    expect(hexToBytes(hex)).toStrictEqual(ethers.getBytes(hex));
  });

});

// Records requested delays instead of sleeping, so retry tests are deterministic.
function recordWaits() {
  const waits: number[] = [];
  return { waits, wait: async (ms: number) => { waits.push(ms); } };
}

describe("withRetry", () => {
  test("stops once retryDelay accepts the result", async () => {
    const { waits, wait } = recordWaits();
    const fn = vi.fn()
      .mockResolvedValueOnce("busy")
      .mockResolvedValueOnce("busy")
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, (r, attempt) => r === "busy" ? attempt * 100 : undefined, { wait });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([100, 200]);
  });

  test("returns the last result once retries run out", async () => {
    const { waits, wait } = recordWaits();
    const fn = vi.fn(async () => "busy");

    const result = await withRetry(fn, () => 5, { retries: 2, wait });

    expect(result).toBe("busy");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([5, 5]);
  });

  test("retries: 0 disables retrying", async () => {
    const { waits, wait } = recordWaits();
    const fn = vi.fn(async () => "busy");

    await withRetry(fn, () => 5, { retries: 0, wait });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });
});

describe("retryDelay429", () => {
  function response(status: number, retryAfter?: string): Response {
    return new Response("", {
      status,
      headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
    });
  }

  test.each([200, 404, 500])("ignores HTTP %i", (status) => {
    expect(retryDelay429(response(status), 1)).toBeUndefined();
  });

  test.each([
    ["0", 0],
    ["3", 3000],
    ["10", 10000],
    ["0.5", 500],
  ])("honors Retry-After %j", (retryAfter, ms) => {
    expect(retryDelay429(response(429, retryAfter), 2)).toBe(ms);
  });

  // Missing or blank must not become Number(null) === 0.
  test.each([
    ["missing", undefined],
    ["blank", "  "],
    ["too large", "30"],
    ["negative", "-1"],
    ["HTTP-date", "Wed, 21 Oct 2015 07:28:00 GMT"],
    ["Infinity", "Infinity"],
  ])("falls back to linear backoff when Retry-After is %s", (_, retryAfter) => {
    expect(retryDelay429(response(429, retryAfter), 1)).toBe(1000);
    expect(retryDelay429(response(429, retryAfter), 3)).toBe(3000);
  });
});

describe("fetchJSON retry", () => {
  const url = "https://example.test/abi";

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  test("retries HTTP 429 and then returns JSON", async () => {
    const { waits, wait } = recordWaits();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "slow down" }, 429))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchJSON(url, { wait })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(url, {
      headers: { "Content-Type": "application/json" },
    });
    expect(waits).toEqual([1000]);
  });

  test("gives up after 3 retries on HTTP 429", async () => {
    const { waits, wait } = recordWaits();
    const fetchMock = vi.fn(async () => jsonResponse({ error: "slow down" }, 429));
    vi.stubGlobal("fetch", fetchMock);

    const error = await fetchJSON(url, { wait }).then(
      () => undefined,
      (err) => err,
    );
    expect(error).toBeInstanceOf(FetchError);
    expect(error.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([1000, 2000, 3000]);
  });

  test("does not retry non-429 responses", async () => {
    const { waits, wait } = recordWaits();
    const fetchMock = vi.fn(async () => new Response("nope", {
      status: 500,
      statusText: "Server Error",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await fetchJSON(url, { wait }).then(
      () => undefined,
      (err) => err,
    );
    expect(error).toBeInstanceOf(FetchError);
    expect(error.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });
});
