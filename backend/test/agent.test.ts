import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeAgent } from "../src/agent.js";
import { createConversation } from "../src/conversation.js";

function fakeClient(response: Partial<Anthropic.Beta.BetaMessage>) {
  const create = vi.fn(async () => response);
  return { client: { beta: { messages: { create } } } as unknown as Anthropic, create };
}

const conversationWithCallee = () => {
  const conversation = createConversation("Запиши час при уролог.", "Иван Петров");
  conversation.messages.push({ role: "user", content: "Да, слушам." });
  return conversation;
};

describe("ClaudeAgent", () => {
  it("returns the spoken text and appends the full assistant content", async () => {
    const content = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "Искам да запиша час при уролог.", citations: null },
    ] as unknown as Anthropic.Beta.BetaContentBlock[];
    const { client, create } = fakeClient({ content, stop_reason: "end_turn" });
    const conversation = conversationWithCallee();

    const reply = await new ClaudeAgent({ model: "claude-opus-5-5", effort: "low" }, client).reply(conversation);

    expect(reply).toEqual({ say: "Искам да запиша час при уролог.", endCall: false });
    expect(conversation.messages.at(-1)).toEqual({ role: "assistant", content });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-5-5", output_config: { effort: "low" }, fallbacks: "default" }),
    );
  });

  it("detects end_call", async () => {
    const { client } = fakeClient({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Благодаря, довиждане!", citations: null },
        { type: "tool_use", id: "t1", name: "end_call", input: { outcome: "Записан вторник 15:00" } },
      ] as unknown as Anthropic.Beta.BetaContentBlock[],
    });
    const reply = await new ClaudeAgent({ model: "m", effort: "low" }, client).reply(conversationWithCallee());
    expect(reply).toEqual({ say: "Благодаря, довиждане!", endCall: true });
  });

  it("ends the call politely on refusal or API failure", async () => {
    const { client } = fakeClient({ stop_reason: "refusal", content: [] });
    const conversation = conversationWithCallee();
    const before = conversation.messages.length;
    const reply = await new ClaudeAgent({ model: "m", effort: "low" }, client).reply(conversation);
    expect(reply.endCall).toBe(true);
    expect(conversation.messages).toHaveLength(before);

    const failing = { beta: { messages: { create: vi.fn().mockRejectedValue(new Error("network")) } } } as unknown as Anthropic;
    expect((await new ClaudeAgent({ model: "m", effort: "low" }, failing).reply(conversationWithCallee())).endCall).toBe(true);
  });
});
