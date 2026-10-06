import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeAgent } from "../src/agent.js";
import { createConversation } from "../src/conversation.js";

/** Fake of client.beta.messages.stream: emits `chunks` as text events, then resolves to `response`. */
function fakeClient(chunks: string[], response: Partial<Anthropic.Beta.BetaMessage> | Error) {
  const stream = vi.fn((_params: unknown, _options: { signal: AbortSignal }) => {
    let onText: (text: string) => void = () => {};
    return {
      on(event: string, listener: (text: string) => void) {
        if (event === "text") onText = listener;
        return this;
      },
      async finalMessage() {
        for (const chunk of chunks) onText(chunk);
        if (response instanceof Error) throw response;
        return response;
      },
    };
  });
  return { client: { beta: { messages: { stream } } } as unknown as Anthropic, stream };
}

const conversationWithCallee = () => {
  const conversation = createConversation("Запиши час при уролог.", "Иван Петров");
  conversation.messages.push({ role: "user", content: "Да, слушам." });
  return conversation;
};

const options = () => {
  const texts: string[] = [];
  return { texts, opts: { onText: (t: string) => texts.push(t), signal: new AbortController().signal } };
};

describe("ClaudeAgent", () => {
  it("streams text and appends the full assistant content", async () => {
    const content = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "Искам да запиша час.", citations: null },
    ] as unknown as Anthropic.Beta.BetaContentBlock[];
    const { client, stream } = fakeClient(["Искам да ", "запиша час."], { content, stop_reason: "end_turn" });
    const conversation = conversationWithCallee();
    const { texts, opts } = options();

    const reply = await new ClaudeAgent({ model: "claude-opus-5-5", effort: "low" }, client).respond(conversation, opts);

    expect(texts).toEqual(["Искам да ", "запиша час."]);
    expect(reply).toEqual({ say: "Искам да запиша час.", endCall: false });
    expect(conversation.messages.at(-1)).toEqual({ role: "assistant", content });
    expect(stream.mock.calls[0]![0]).toMatchObject({
      model: "claude-opus-5-5",
      output_config: { effort: "low" },
      fallbacks: "default",
    });
  });

  it("detects end_call with its outcome", async () => {
    const { client } = fakeClient(["Довиждане!"], {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Довиждане!", citations: null },
        { type: "tool_use", id: "t1", name: "end_call", input: { outcome: "Вторник 15:00" } },
      ] as unknown as Anthropic.Beta.BetaContentBlock[],
    });
    const { opts } = options();
    const reply = await new ClaudeAgent({ model: "m", effort: "low" }, client).respond(conversationWithCallee(), opts);
    expect(reply).toEqual({ say: "Довиждане!", endCall: true, outcome: "Вторник 15:00" });
  });

  it("returns null when aborted", async () => {
    const { client } = fakeClient(["Иска"], new Anthropic.APIUserAbortError());
    const { opts } = options();
    expect(await new ClaudeAgent({ model: "m", effort: "low" }, client).respond(conversationWithCallee(), opts)).toBeNull();
  });

  it("speaks an apology and ends the call on refusal or API failure", async () => {
    const { client } = fakeClient([], { stop_reason: "refusal", content: [] });
    const conversation = conversationWithCallee();
    const before = conversation.messages.length;
    const { texts, opts } = options();
    const reply = await new ClaudeAgent({ model: "m", effort: "low" }, client).respond(conversation, opts);
    expect(reply?.endCall).toBe(true);
    expect(texts.join("")).toContain("технически проблем");
    expect(conversation.messages).toHaveLength(before);

    const failing = fakeClient([], new Error("network")).client;
    const second = options();
    const failed = await new ClaudeAgent({ model: "m", effort: "low" }, failing).respond(conversationWithCallee(), second.opts);
    expect(failed?.endCall).toBe(true);
  });
});
