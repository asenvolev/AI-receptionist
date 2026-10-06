import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, RespondOptions } from "../src/agent.js";
import { ConversationStore, createConversation, type Conversation } from "../src/conversation.js";
import { handleRelaySocket } from "../src/relay.js";
import { testConfig } from "./helpers.js";

class FakeSocket extends EventEmitter {
  sent: Array<Record<string, unknown>> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  receive(message: object) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(respond: Agent["respond"]) {
  const store = new ConversationStore();
  const conversation = createConversation("Запиши час.", "Иван");
  store.add(conversation);
  const ws = new FakeSocket();
  const agent: Agent = { respond: vi.fn(respond) };
  handleRelaySocket(ws, { store, agent, config: testConfig(), speechDurationMs: () => 10 });
  ws.receive({ type: "setup", callSid: "CA1", customParameters: { cid: conversation.id } });
  return { ws, agent, conversation };
}

const replying =
  (text: string, endCall = false): Agent["respond"] =>
  async (conversation: Conversation, { onText }: RespondOptions) => {
    onText(text);
    conversation.messages.push({ role: "assistant", content: text });
    return { say: text, endCall, ...(endCall ? { outcome: "ok" } : {}) };
  };

afterEach(() => {
  vi.useRealTimers();
});

describe("handleRelaySocket", () => {
  it("ends the session for an unknown conversation", () => {
    const ws = new FakeSocket();
    handleRelaySocket(ws, { store: new ConversationStore(), agent: { respond: vi.fn() }, config: testConfig() });
    ws.receive({ type: "setup", callSid: "CA1", customParameters: { cid: "nope" } });
    expect(ws.sent[0]).toMatchObject({ type: "end" });
  });

  it("streams the agent reply as text tokens and finishes with last=true", async () => {
    const { ws, conversation } = setup(replying("Добър ден."));
    ws.receive({ type: "prompt", voicePrompt: "Ало, слушам.", last: true });
    await flush();
    expect(ws.sent).toEqual([
      { type: "text", token: "Добър ден.", last: false },
      { type: "text", token: "", last: true },
    ]);
    expect(conversation.callSid).toBe("CA1");
    expect(conversation.messages.at(-2)).toEqual({ role: "user", content: "Ало, слушам." });
    expect(conversation.transcript.slice(-2).map((l) => l.speaker)).toEqual(["callee", "agent"]);
  });

  it("sends end after the goodbye when the agent ends the call", async () => {
    const { ws } = setup(replying("Довиждане!", true));
    ws.receive({ type: "prompt", voicePrompt: "Записах ви.", last: true });
    await flush();
    expect(ws.sent.some((m) => m.type === "end")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ws.sent.at(-1)).toEqual({ type: "end", handoffData: JSON.stringify({ outcome: "ok" }) });
  });

  it("aborts generation on interrupt and tells Claude what was heard", async () => {
    let first = true;
    const { ws, conversation } = setup(async (conv, { onText, signal }) => {
      if (first) {
        first = false;
        onText("Бих искал");
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
        return null;
      }
      return replying("Разбрах.")(conv, { onText, signal });
    });
    ws.receive({ type: "prompt", voicePrompt: "Слушам.", last: true });
    await flush();
    ws.receive({ type: "interrupt", utteranceUntilInterrupt: "Бих" });
    await flush();
    ws.receive({ type: "prompt", voicePrompt: "Един момент.", last: true });
    await flush();

    // The aborted turn left no assistant message, so both utterances share one user turn.
    expect(conversation.messages.at(-2)).toEqual({
      role: "user",
      content: "Слушам. [Прекъснаха те. От последната ти реплика чуха само: „Бих“] Един момент.",
    });
    expect(conversation.messages.at(-1)).toEqual({ role: "assistant", content: "Разбрах." });
  });

  it("ignores partial prompts and closes politely at the turn limit", async () => {
    const { ws, agent } = setup(replying("Добре."));
    ws.receive({ type: "prompt", voicePrompt: "Сл", last: false });
    await flush();
    expect(agent.respond).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) {
      ws.receive({ type: "prompt", voicePrompt: `реплика ${i}`, last: true });
      await flush();
    }
    expect(ws.sent.some((m) => typeof m.token === "string" && m.token.includes("приключа"))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ws.sent.at(-1)?.type).toBe("end");
  });
});
