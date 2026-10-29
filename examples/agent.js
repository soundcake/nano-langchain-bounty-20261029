import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { GuardedNanoClient, createNanoTool, createEnvironmentSigner } from "../src/index.js";

// Deterministic one-purchase planner: runs without a paid model API key.
export function createPurchaseAgent(client, request) {
  const tools = [createNanoTool(client)];
  return new StateGraph(MessagesAnnotation)
    .addNode("agent", ({ messages }) => ({ messages: [messages.at(-1).getType() === "tool"
      ? new AIMessage(messages.at(-1).content)
      : new AIMessage({ content: "", tool_calls: [{ name: tools[0].name, args: request, id: "purchase-1", type: "tool_call" }] })] }))
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "agent").addConditionalEdges("agent", toolsCondition, { tools: "tools", __end__: END })
    .addEdge("tools", "agent").compile();
}

export async function runExample() {
  const recipients = (process.env.NANO_ALLOWED_RECIPIENTS ?? "").split(",").filter(Boolean);
  if (!recipients.length) throw new Error("Set NANO_ALLOWED_RECIPIENTS to the operator-approved recipient");
  const url = process.env.RESOURCE_URL ?? "https://pursekeeper.dev/v1/hash";
  const client = new GuardedNanoClient({ signer: createEnvironmentSigner(),
    allowedOrigins: ["https://pursekeeper.dev"], allowedRecipients: recipients,
    perCallRaw: "1000000000000000000000000000", totalRaw: "1000000000000000000000000000" });
  const result = await createPurchaseAgent(client, { url, method: "POST", body: '{"message":"LangChain Nano x402"}' })
    .invoke({ messages: [new HumanMessage("Make the configured purchase once.")] }, { recursionLimit: 6 });
  console.log(result.messages.at(-1).content);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  runExample().catch(() => { console.error("Purchase did not complete. Check configuration and the existing payment before retrying."); process.exitCode = 1; });
}
