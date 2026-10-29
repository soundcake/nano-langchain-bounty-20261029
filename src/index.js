import { tool } from "@langchain/core/tools";
import { z } from "zod";
export { GuardedNanoClient } from "./client.js";
export { createEnvironmentSigner } from "./signer.js";

export function createNanoTool(client) {
  return tool(async (input) => JSON.stringify(await client.request(input)), {
    name: "nano_x402_request",
    description: "Call an operator-approved HTTPS resource using the configured Nano payment budget.",
    schema: z.object({ url: z.string().url(), method: z.enum(["GET", "POST"]).default("GET"),
      body: z.string().default(""), requestId: z.string().optional() }),
  });
}
