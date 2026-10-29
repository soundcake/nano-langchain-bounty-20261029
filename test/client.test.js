import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import N from "nanocurrency";
import { GuardedNanoClient } from "../src/client.js";
import { createPurchaseAgent } from "../examples/agent.js";
import { HumanMessage } from "@langchain/core/messages";

const recipient = N.deriveAddress(randomBytes(32).toString("hex"), { useNanoPrefix: true });
const url = "https://seller.example/v1/hash";
const request = { url, method: "POST", body: "example" };
const hash = "A".repeat(64);
const accepted = () => ({ scheme: "exact", network: "nano:mainnet", asset: "XNO", amount: "10",
  payTo: recipient, maxTimeoutSeconds: 10, extra: { workOptional: true } });
const quote = (change = {}) => ({ x402Version: 2, resource: { url }, accepts: [{ ...accepted(), ...change }] });
const response402 = q => new Response("", { status: 402,
  headers: { "payment-required": Buffer.from(JSON.stringify(q)).toString("base64") } });
function fixture({ q = quote(), onFetch, onPrepare, now = Date.now, totalRaw = "20" } = {}) {
  const state = { requests: [], signed: 0, prepared: 0, released: 0 };
  const client = new GuardedNanoClient({ allowedOrigins: ["https://seller.example"], allowedRecipients: [recipient],
    perCallRaw: "10", totalRaw, now,
    signer: { async prepare(a) {
      state.prepared++;
      await onPrepare?.(a, state);
      return { sign() { state.signed++; return { hash, block: { type: "state" } }; }, release() { state.released++; } };
    } },
    fetchImpl: async (u, init) => {
      state.requests.push({ url: u, init });
      if (onFetch) return onFetch(u, init, state);
      return init.headers["payment-signature"] ? new Response("paid") : response402(q);
    },
  });
  return { client, state };
}

for (const [name, change] of [
  ["wrong network", { network: "nano:testnet" }],
  ["wrong scheme", { scheme: "upto" }],
  ["wrong asset", { asset: "USDC" }],
  ["unapproved recipient", { payTo: N.deriveAddress(randomBytes(32).toString("hex"), { useNanoPrefix: true }) }],
  ["invalid recipient", { payTo: "nano_invalid" }],
  ["per-call cap", { amount: "11" }],
  ["numeric amount", { amount: 10 }],
  ["negative amount", { amount: "-1" }],
  ["fractional amount", { amount: "0.1" }],
  ["zero amount", { amount: "0" }],
  ["overflow amount", { amount: "9".repeat(39) }],
  ["missing lifetime", { maxTimeoutSeconds: undefined }],
  ["zero lifetime", { maxTimeoutSeconds: 0 }],
]) test(`refuses ${name} before preparation/signing`, async () => {
  const { client, state } = fixture({ q: quote(change) });
  await assert.rejects(client.request(request));
  assert.equal(state.prepared, 0); assert.equal(state.signed, 0);
});

test("malformed required header is refused", async () => {
  const { client, state } = fixture({ onFetch: () => new Response("", { status: 402, headers: { "payment-required": "%%%" } }) });
  await assert.rejects(client.request(request), /Malformed/); assert.equal(state.signed, 0);
});
test("resource URL must match the requested resource", async () => {
  const q = quote(); q.resource.url = "https://other.example/";
  const { client, state } = fixture({ q }); await assert.rejects(client.request(request)); assert.equal(state.signed, 0);
});
test("quote redirect cannot reach another origin or signer", async () => {
  const { client, state } = fixture({ onFetch: () => new Response("", { status: 302, headers: { location: "https://other.example" } }) });
  await assert.rejects(client.request(request), /Redirect/);
  assert.equal(state.requests.length, 1); assert.equal(state.requests[0].init.redirect, "manual"); assert.equal(state.signed, 0);
});
test("unapproved request origin is refused before any fetch", () => {
  const { client, state } = fixture(); assert.throws(() => client.request({ url: "https://other.example/" }));
  assert.equal(state.requests.length, 0);
});
test("one quote, one payment and one signature for concurrent duplicate invocations", async () => {
  const { client, state } = fixture();
  const [a, b] = await Promise.all([client.request(request), client.request({ ...request, requestId: "another-id" })]);
  assert.deepEqual(a, b); assert.equal(a.body, "paid"); assert.equal(a.paymentHash, hash);
  assert.equal(state.signed, 1); assert.equal(state.requests.length, 2); assert.equal(state.released, 1);
  const paid = state.requests[1].init;
  assert.equal(paid.body, "example"); assert.equal(paid.redirect, "manual");
  const payload = JSON.parse(Buffer.from(paid.headers["payment-signature"], "base64"));
  assert.deepEqual(payload.accepted, accepted()); assert.equal(payload.x402Version, 2);
});
test("explicit request ID cannot be reused for a different operation", async () => {
  const { client } = fixture(); await client.request({ ...request, requestId: "a" });
  assert.throws(() => client.request({ ...request, body: "different", requestId: "a" }), /already used/);
});
test("cumulative cap holds under concurrent distinct requests", async () => {
  const { client, state } = fixture({ totalRaw: "10" });
  const result = await Promise.allSettled([client.request(request), client.request({ ...request, body: "second" })]);
  assert.equal(result[0].status, "fulfilled"); assert.equal(result[1].status, "rejected");
  assert.match(result[1].reason.message, /Run cap/); assert.equal(state.signed, 1); assert.equal(client.committedRaw, "10");
});
for (const status of [302, 402, 429, 500]) test(`paid HTTP ${status} never triggers another paid retry`, async () => {
  const { client, state } = fixture({ onFetch: (_, init) => init.headers["payment-signature"]
    ? new Response("failed", { status }) : response402(quote()) });
  await client.request(request).catch(() => {});
  await client.request(request).catch(() => {});
  assert.equal(state.signed, 1); assert.equal(state.requests.length, 2); assert.equal(client.committedRaw, "10");
});
test("lost paid reply is retained without automatic repurchase", async () => {
  const { client, state } = fixture({ onFetch: (_, init) => {
    if (init.headers["payment-signature"]) throw new Error("network interrupted");
    return response402(quote());
  } });
  const first = await client.request(request); const second = await client.request(request);
  assert.equal(first.status, null); assert.equal(first.paymentHash, hash); assert.deepEqual(first, second);
  assert.equal(state.signed, 1); assert.equal(state.requests.length, 2);
});
test("expired quote is refetched after slow unsigned preparation", async () => {
  let clock = 0;
  const { client, state } = fixture({ now: () => clock, onPrepare: (_, s) => { if (s.prepared === 1) clock = 10000; } });
  await client.request(request);
  assert.equal(state.prepared, 2); assert.equal(state.signed, 1); assert.equal(state.released, 2);
  assert.equal(state.requests.length, 3);
});
test("perpetually stale quotes fail with a bounded unsigned refresh count", async () => {
  let clock = 0;
  const { client, state } = fixture({ now: () => clock, onPrepare: () => { clock += 10000; } });
  await assert.rejects(client.request(request), /expired/); assert.equal(state.signed, 0); assert.equal(state.prepared, 3);
});
test("a refreshed quote gets its own recipient and budget checks", async () => {
  let clock = 0;
  const { client, state } = fixture({ now: () => clock, onPrepare: () => { clock = 10000; },
    onFetch: (_, __, s) => response402(quote({ amount: s.requests.length > 1 ? "11" : "10" })) });
  await assert.rejects(client.request(request), /Per-call/); assert.equal(state.signed, 0);
});
test("unsigned free response does not prepare or spend", async () => {
  const { client, state } = fixture({ onFetch: () => new Response("free") });
  assert.equal((await client.request(request)).body, "free"); assert.equal(state.signed, 0);
});
test("LangGraph invokes the native Tool through an agent loop", async () => {
  const { client, state } = fixture();
  const result = await createPurchaseAgent(client, request).invoke({ messages: [new HumanMessage("Buy once")] });
  assert.deepEqual(result.messages.map(m => m.getType()), ["human", "ai", "tool", "ai"]);
  assert.equal(JSON.parse(result.messages.at(-1).content).paymentHash, hash); assert.equal(state.signed, 1);
});
