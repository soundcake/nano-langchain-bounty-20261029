import N from "nanocurrency";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** The seed stays in this closure. Uses an already opened/funded Nano account. */
export function createEnvironmentSigner({ env = process.env, fetchImpl = fetch,
  accountApi = "https://pursekeeper.dev", workUrl, lockDirectory = tmpdir(), computeWork = N.computeWork } = {}) {
  if (!/^[a-fA-F0-9]{64}$/.test(env.NANO_SEED ?? "")) throw new Error("NANO_SEED must be configured");
  const index = Number(env.NANO_INDEX ?? 0);
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new Error("Invalid NANO_INDEX");
  const key = N.deriveSecretKey(env.NANO_SEED, index);
  const account = N.deriveAddress(N.derivePublicKey(key), { useNanoPrefix: true });
  for (const url of [accountApi, workUrl].filter(Boolean)) {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password) throw new Error("Signer services require HTTPS");
  }
  return {
    account,
    async prepare(accepted) {
      const file = join(lockDirectory, `langchain-nano-${account}.lock`);
      const owner = `${process.pid}:${randomUUID()}`;
      try { writeFileSync(file, owner, { flag: "wx", mode: 0o600 }); }
      catch { throw new Error("Wallet is locked; finish its active operation before retrying"); }
      const release = () => {
        try { if (readFileSync(file, "utf8") === owner) unlinkSync(file); } catch {}
      };
      try {
        const r = await fetchImpl(`${accountApi.replace(/\/$/, "")}/v1/account_info?account=${account}`, {
          redirect: "error", signal: AbortSignal.timeout(30_000),
        });
        if (!r.ok) throw new Error("Account service unavailable");
        const info = await r.json();
        if (!info.found || !/^[a-fA-F0-9]{64}$/.test(info.frontier ?? "") ||
            !N.checkAddress(info.representative ?? "") || !/^\d{1,39}$/.test(info.balance_raw ?? ""))
          throw new Error("Account must be opened and have valid chain state");
        const balance = BigInt(info.balance_raw) - BigInt(accepted.amount);
        if (balance < 0n) throw new Error("Insufficient account balance");
        const optional = accepted.extra?.workOptional === true || accepted.extra?.work === "optional";
        let work = "0";
        if (!optional) {
          if (workUrl) {
            const wr = await fetchImpl(workUrl, { method: "POST", redirect: "error",
              headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30_000),
              body: JSON.stringify({ action: "work_generate", hash: info.frontier, difficulty: "fffffff800000000" }) });
            if (!wr.ok) throw new Error("Configured work service unavailable");
            work = (await wr.json()).work;
          } else work = await computeWork(info.frontier, { workThreshold: "fffffff800000000" });
          if (!/^[a-fA-F0-9]{16}$/.test(work ?? "") ||
              !N.validateWork({ blockHash: info.frontier, work, threshold: "fffffff800000000" }))
            throw new Error("Invalid proof of work");
        }
        let signed = false;
        return { release, sign() {
          if (signed) throw new Error("Prepared payment was already signed");
          signed = true;
          const result = N.createBlock(key, { previous: info.frontier, representative: info.representative,
            balance: balance.toString(), link: accepted.payTo, work });
          result.block.account = account;
          return result;
        } };
      } catch (error) { release(); throw error; }
    },
  };
}
