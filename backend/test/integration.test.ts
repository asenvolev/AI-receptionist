import type { AddressInfo } from "node:net";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { Agent } from "../src/agent.js";
import { ConversationStore } from "../src/conversation.js";
import { createAppServer } from "../src/server.js";
import { testConfig } from "./helpers.js";

describe("createAppServer", () => {
  it("serves HTTP and the ConversationRelay WebSocket on one port", async () => {
    const store = new ConversationStore();
    const agent: Agent = {
      respond: vi.fn(async (_conversation, { onText }) => {
        onText("Здравейте.");
        return { say: "Здравейте.", endCall: false };
      }),
    };
    const server = createAppServer({ config: testConfig(), agent, store, placeCall: async () => ({ sid: "CA9" }) });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    const started = await request(server).post("/test-call").set("Authorization", "Bearer secret").send({});
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`);
    await new Promise((resolve) => ws.once("open", resolve));
    const received: unknown[] = [];
    const gotLast = new Promise<void>((resolve) =>
      ws.on("message", (data) => {
        const message = JSON.parse(String(data));
        received.push(message);
        if (message.last === true) resolve();
      }),
    );
    ws.send(JSON.stringify({ type: "setup", callSid: "CA9", customParameters: { cid: started.body.conversationId } }));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Ало?", last: true }));
    await gotLast;

    expect(received).toEqual([
      { type: "text", token: "Здравейте.", last: false },
      { type: "text", token: "", last: true },
    ]);
    ws.close();
    await new Promise((resolve) => server.close(resolve));
  });
});
