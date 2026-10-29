# LangChain Nano x402

A LangChain Tool that purchases an HTTPS resource using x402 v2 `exact` payments
on `nano:mainnet`. It signs with `nanocurrency` and exposes the result through
LangChain's native Tool interface. The included LangGraph example runs the Tool
inside an agent loop with a deterministic one-purchase planner, so it needs no
model API account.

## Install and validate

Node.js 22 or newer is required. From the repository:

```sh
npm ci --ignore-scripts
npm test
```

The dependencies are pinned in `package.json` and `package-lock.json`. No install
scripts are required. `npm pack --ignore-scripts` produces the installable package.

## One paid call through the agent

Configure an already opened and funded Nano account using `NANO_SEED` and,
optionally, `NANO_INDEX` (default zero). Configure `NANO_ALLOWED_RECIPIENTS` with
the seller account you approve; the Tool never constructs that allowlist from
an untrusted quote. Pursekeeper publishes its current account at
<https://pursekeeper.dev/v1/price>.

```sh
# NANO_SEED is supplied by your environment's secret configuration.
export NANO_ALLOWED_RECIPIENTS='YOUR_APPROVED_NANO_RECIPIENT'
npm run example
```

This invokes the `nano_x402_request` Tool through LangGraph's `ToolNode`, buys
`POST https://pursekeeper.dev/v1/hash` and prints the response and payment hash.
Both the per-call and whole-run caps are **0.001 XNO**
(`1000000000000000000000000000` raw). A fresh 402 quote is requested first.
The example's planner calls the Tool once and then returns its result.

For your own agent, use one client for its whole run:

```js
import {
  GuardedNanoClient, createNanoTool, createEnvironmentSigner,
} from "@soundcake/langchain-nano-x402";

const client = new GuardedNanoClient({
  signer: createEnvironmentSigner(),
  allowedOrigins: ["https://pursekeeper.dev"],
  allowedRecipients: process.env.NANO_ALLOWED_RECIPIENTS.split(","),
  perCallRaw: "1000000000000000000000000000",
  totalRaw: "3000000000000000000000000000",
});
const tools = [createNanoTool(client)];
// Supply tools to your LangChain agent / LangGraph ToolNode.
```

`examples/agent.js` contains the complete graph, including the agent → tools →
agent loop. Its `createPurchaseAgent` function also accepts an injected client
for offline tests.

## Payment behavior

Before signing, the client validates the scheme, network, asset, resource URL,
recipient allowlist, positive integer amount, per-call cap, cumulative cap and
quote lifetime. If account lookup or work computation outlives the quote, the
client requests and validates a fresh quote. After three expired quotes it
stops unsigned.

The same URL, method and body identify the same request throughout a client
instance. Concurrent and later invocations reuse its existing result, even if
they supply different `requestId` values. Reusing an explicit ID with different
inputs is rejected. Distinct intended purchases must have distinct request
contents. The budget counts every signed attempt, including unsuccessful ones.

Redirects are refused before and after payment. There is at most one signed
HTTP request per operation and no automatic paid retry after a non-2xx, timeout
or lost response. An unavailable paid response returns `status: null` and the
payment hash so the operator can inspect its outcome. Request deduplication and
budgets last for that client/run; restarting the process begins a new run.

The signer holds an exclusive local lock for its account until the request
finishes. A leftover lock is preserved after a crash; an operator can remove it
only after checking the previous payment and confirming that no process still
uses that account. Separate hosts must use separate accounts. The account must
already be opened and funded; the package does not receive funds or open wallets.

When a quote advertises `extra.workOptional: true` (or `work: "optional"`), the
seller supplies proof of work. Otherwise the signer computes and validates it
locally, or uses an operator-configured HTTPS `workUrl`. It never pays a work
server automatically. The seed stays inside the signer closure and is never
included in Tool output. An injected signer may replace the environment signer:
its asynchronous `prepare(accepted)` does unsigned preparation and returns a
synchronous `sign()` function plus an optional `release()` function.

## Tests

`npm test` runs offline. It covers each guard, concurrent deduplication and
budgeting, quote expiry/refetch, paid-error behavior, the actual LangGraph agent
loop, wallet locking and a real Nano signature with an ephemeral test key.
Live settlement is a separate check using the operator's funded account.

## License

MIT.
