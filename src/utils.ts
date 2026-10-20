// Convert 32 bytes of hex to Uint8Array, undefined for other sizes
//
// Borrowed from:
// https://chat.openai.com/share/ae1e8813-ac3d-4262-89c7-14c462febb34
export function hexToBytes(hex: string): Uint8Array {
  if (hex.startsWith("0x")) {
    hex = hex.slice(2);
  }

  const length = hex.length;
  if (length % 2 !== 0) {
    throw new Error('hexToBytes: odd input length, must be even: ' + hex);
  }

  const r = new Uint8Array(length / 2);

  for (let i = 0; i < length; i += 2) {
    const highNibble = parseInt(hex[i], 16);
    const lowNibble = parseInt(hex[i + 1], 16);
    r[i / 2] = (highNibble << 4) | lowNibble;
  }

  return r;
}

export function bytesToHex(bytes: Uint8Array | Number | bigint, padToBytes?: number): string {
  const hex = (typeof bytes === 'number' || typeof bytes === 'bigint') ? bytes.toString(16) : Array.prototype.map.call(bytes, function(n: number) {
    return n.toString(16).padStart(2, "0");
  }).join("");

  if (padToBytes) {
    return "0x" + hex.padStart(padToBytes * 2, "0");
  }

  return "0x" + hex;
}


export class FetchError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Retry behaviour shared by loaders that talk to rate-limited APIs.
 * `wait` defaults to setTimeout; pass your own to control the pacing
 * (tests resolve it immediately so they never sleep).
 */
export type RetryConfig = {
  retries?: number;
  wait?: (ms: number) => Promise<void>;
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Call fn until retryDelay returns undefined (accept the result) or retries
 * run out, waiting retryDelay(result, attempt) ms between calls. Callers
 * decide what counts as retryable, so service quirks stay in their loaders.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retryDelay: (result: T, attempt: number) => number | undefined,
  { retries = 3, wait = sleep }: RetryConfig = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const result = await fn();
    const ms = attempt <= retries ? retryDelay(result, attempt) : undefined;
    if (ms === undefined) return result;
    await wait(ms);
  }
}

const MAX_RETRY_AFTER_SECONDS = 10;

/**
 * HTTP 429: honor Retry-After when it is a small delay (0-10s), otherwise
 * wait attempt seconds (1s, 2s, 3s). A missing header is not 0:
 * Number(null) === 0, which would retry immediately.
 */
export function retryDelay429(response: Response, attempt: number): number | undefined {
  if (response.status !== 429) return undefined;
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter != null && retryAfter.trim() !== "") {
    const seconds = Number(retryAfter);
    if (seconds >= 0 && seconds <= MAX_RETRY_AFTER_SECONDS) return seconds * 1000;
  }
  return attempt * 1000;
}

export function fetchWithRetry(url: string, init?: RequestInit, retry?: RetryConfig): Promise<Response> {
  return withRetry(() => fetch(url, init), retryDelay429, retry);
}

export async function fetchJSON(url: string, retry?: RetryConfig): Promise<any> {
  const response = await fetchWithRetry(url, {
    headers: {
      "Content-Type": "application/json",
    },
  }, retry);
  if (!response.ok) {
    throw new FetchError(response.statusText, response.status);
  }
  return response.json();
}
