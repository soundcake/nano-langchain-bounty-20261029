import N from "nanocurrency";
import { createHash } from "node:crypto";

const MAX_RAW = (1n << 128n) - 1n;
const raw = (value) => {
  if (typeof value !== "string" || !/^[1-9]\d{0,38}$/.test(value) || BigInt(value) > MAX_RAW)
    throw new Error("Expected a positive raw amount within uint128");
  return BigInt(value);
};
const address = (value) => {
  if (typeof value !== "string" || !N.checkAddress(value)) throw new Error("Invalid Nano address");
  return value.replace(/^xrb_/, "nano_");
};
const https = (value) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Expected an HTTPS URL without credentials or fragment");
  return url;
};

/** A single instance owns one run's budget and deduplication ledger. */
export class GuardedNanoClient {
  #used = 0n;
  #tail = Promise.resolve();
  #requests = new Map();
  #ids = new Map();
  #signer; #fetch; #now; #origins; #recipients; #perCall; #total;

  constructor({ signer, allowedOrigins, allowedRecipients, perCallRaw, totalRaw,
    fetchImpl = fetch, now = Date.now }) {
    if (!signer || typeof signer.prepare !== "function") throw new Error("A signer is required");
    this.#signer = signer; this.#fetch = fetchImpl; this.#now = now;
    this.#origins = new Set(allowedOrigins.map(x => https(x).origin));
    this.#recipients = new Set(allowedRecipients.map(address));
    if (!this.#origins.size || !this.#recipients.size) throw new Error("Allowlist is empty");
    this.#perCall = raw(perCallRaw); this.#total = raw(totalRaw);
  }

  get committedRaw() { return String(this.#used); }

  request({ url, method = "GET", body = "", requestId }) {
    const target = https(url).href;
    if (!this.#origins.has(new URL(target).origin)) throw new Error("Origin is not allowed");
    if (!["GET", "POST"].includes(method) || typeof body !== "string" || body.length > 1_000_000 || (method === "GET" && body))
      throw new Error("Invalid request");
    const fingerprint = createHash("sha256").update(JSON.stringify([target, method, body])).digest("hex");
    const key = requestId ?? fingerprint;
    if (typeof key !== "string" || !key.length || key.length > 512) throw new Error("Invalid request ID");
    if (this.#ids.has(key) && this.#ids.get(key) !== fingerprint)
      throw new Error("Request ID already used with other inputs");
    this.#ids.set(key, fingerprint);
    if (this.#requests.has(fingerprint)) return this.#requests.get(fingerprint);
    // Serial execution keeps the cumulative budget and account frontier coherent.
    const promise = this.#tail.then(() => this.#run(target, method, body));
    this.#requests.set(fingerprint, promise);
    this.#tail = promise.catch(() => {});
    return promise;
  }

  #validate(quote, target) {
    if (!quote || quote.x402Version !== 2 || !quote.resource || quote.resource.url !== target ||
        !Array.isArray(quote.accepts) || !quote.accepts.length || quote.accepts.length > 100)
      throw new Error("Malformed payment quote");
    const accepted = quote.accepts.find(a => a && a.scheme === "exact" && a.network === "nano:mainnet");
    if (!accepted || accepted.asset !== "XNO") throw new Error("Unsupported payment scheme, network or asset");
    if (!this.#recipients.has(address(accepted.payTo))) throw new Error("Recipient is not allowed");
    const amount = raw(accepted.amount);
    if (amount > this.#perCall) throw new Error("Per-call cap exceeded");
    if (this.#used + amount > this.#total) throw new Error("Run cap exceeded");
    if (!Number.isInteger(accepted.maxTimeoutSeconds) || accepted.maxTimeoutSeconds < 1 || accepted.maxTimeoutSeconds > 3600)
      throw new Error("Invalid quote lifetime");
    if (accepted.extra != null && (typeof accepted.extra !== "object" || Array.isArray(accepted.extra)))
      throw new Error("Malformed quote extras");
    return { accepted, amount };
  }

  async #fetchRequest(target, method, body, payment) {
    const headers = { "content-type": "application/json" };
    if (payment) headers["payment-signature"] = payment;
    const response = await this.#fetch(target, {
      method, body: method === "POST" ? body : undefined, headers,
      redirect: "manual", signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("Redirect refused");
    if (response.url && response.url !== target) throw new Error("Unexpected response URL");
    return response;
  }

  async #result(response, paymentHash = null) {
    // Do not return signed payment headers or any signer state to the agent.
    return { status: response.status, ok: response.ok, paymentHash, body: await response.text() };
  }

  async #run(target, method, body) {
    for (let refresh = 0; refresh < 3; refresh++) {
      const fetchedAt = this.#now();
      const response = await this.#fetchRequest(target, method, body);
      if (response.status !== 402) return this.#result(response);
      const header = response.headers.get("payment-required");
      if (!header || header.length > 65536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header))
        throw new Error("Malformed payment-required header");
      let quote;
      try { quote = JSON.parse(Buffer.from(header, "base64").toString("utf8")); }
      catch { throw new Error("Malformed payment-required JSON"); }
      const { accepted, amount } = this.#validate(quote, target);
      const expires = fetchedAt + accepted.maxTimeoutSeconds * 1000;
      if (this.#now() >= expires) continue;
      // prepare may perform account/work reads, but MUST NOT sign a block.
      const prepared = await this.#signer.prepare(structuredClone(accepted));
      try {
        if (this.#now() >= expires) continue;
        this.#validate(quote, target);
        this.#used += amount;
        // Signing is synchronous: no await separates the lifetime check and signature.
        const signed = prepared.sign();
        if (!signed || !signed.block || !/^[a-fA-F0-9]{64}$/.test(signed.hash))
          throw new Error("Signer did not return a Nano block and hash");
        const payload = Buffer.from(JSON.stringify({ x402Version: 2, resource: quote.resource,
          accepted, payload: { block: signed.block } })).toString("base64");
        // Exactly one paid request. Even an error retains the budget and request ID.
        try {
          const paid = await this.#fetchRequest(target, method, body, payload);
          return await this.#result(paid, signed.hash);
        } catch {
          return { status: null, ok: false, paymentHash: signed.hash,
            body: "Paid response unavailable. Inspect this payment hash before making another purchase." };
        }
      } finally { await prepared.release?.(); }
    }
    throw new Error("Quote expired before signing after three fresh quotes");
  }
}
