import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import N from "nanocurrency";
import { createEnvironmentSigner } from "../src/signer.js";

function setup(t, { extra = { workOptional: true }, workUrl, fetchImpl, computeWork } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nano-tool-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recipient = N.deriveAddress(randomBytes(32).toString("hex"), { useNanoPrefix: true });
  const info = { found: true, balance_raw: "100", frontier: "F".repeat(64), representative: recipient };
  const signer = createEnvironmentSigner({ env: { NANO_SEED: randomBytes(32).toString("hex") },
    lockDirectory: dir, workUrl, computeWork,
    fetchImpl: fetchImpl ?? (async () => Response.json(info)) });
  return { signer, recipient, dir, accepted: { amount: "10", payTo: recipient, extra }, info };
}
test("real offline signature matches exact balance change and destination", async t => {
  const { signer, accepted, dir } = setup(t); const prepared = await signer.prepare(accepted);
  const { block, hash } = prepared.sign();
  assert.equal(block.balance, "90"); assert.equal(block.account, signer.account);
  assert.equal(block.link, N.derivePublicKey(accepted.payTo));
  assert.ok(N.verifyBlock({ hash, signature: block.signature, publicKey: N.derivePublicKey(signer.account) }));
  assert.throws(() => prepared.sign(), /already signed/);
  await prepared.release(); assert.deepEqual(readdirSync(dir), []);
});
test("wallet lock prevents simultaneous preparation and is released", async t => {
  const { signer, accepted } = setup(t); const first = await signer.prepare(accepted);
  await assert.rejects(signer.prepare(accepted), /locked/); await first.release();
  const next = await signer.prepare(accepted); await next.release();
});
test("account service failure does not leave a wallet lock", async t => {
  const { signer, accepted, dir } = setup(t, { fetchImpl: async () => new Response("", { status: 503 }) });
  await assert.rejects(signer.prepare(accepted), /unavailable/); assert.deepEqual(readdirSync(dir), []);
});
test("required work is obtained before the signing callback", async t => {
  let calls = 0;
  const { signer, accepted } = setup(t, { extra: {}, computeWork: async () => { calls++; throw new Error("work stop"); } });
  await assert.rejects(signer.prepare(accepted), /work stop/); assert.equal(calls, 1);
});
test("invalid configured work fails unsigned", async t => {
  let count = 0;
  const representative = N.deriveAddress(randomBytes(32).toString("hex"), { useNanoPrefix: true });
  const { signer, accepted } = setup(t, { extra: {}, workUrl: "https://work.example/",
    fetchImpl: async () => ++count === 1 ? Response.json({ found: true, balance_raw: "100", frontier: "F".repeat(64), representative })
      : Response.json({ work: "not-work" }) });
  await assert.rejects(signer.prepare(accepted), /Invalid proof/); assert.equal(count, 2);
});
test("required valid work is attached to the real signed block", async t => {
  const { signer, accepted } = setup(t, { extra: {}, computeWork: async () => "000000000b5cef13" });
  const prepared = await signer.prepare(accepted);
  const { block, hash } = prepared.sign();
  assert.equal(block.work, "000000000b5cef13");
  assert.ok(N.validateWork({ blockHash: block.previous, work: block.work, threshold: "fffffff800000000" }));
  assert.ok(N.verifyBlock({ hash, signature: block.signature, publicKey: N.derivePublicKey(signer.account) }));
  await prepared.release();
});
