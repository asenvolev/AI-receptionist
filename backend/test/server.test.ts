import request from "supertest";
import twilio from "twilio";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agent.js";
import { ConversationStore } from "../src/conversation.js";
import { recordLog } from "../src/logs.js";
import { createApp, type PlaceCall } from "../src/server.js";
import { testConfig } from "./helpers.js";

function setup(agentRespond: Agent["respond"] = vi.fn(), configOverrides: Record<string, string> = {}) {
  const config = testConfig(configOverrides);
  const store = new ConversationStore();
  const placeCall = vi.fn<PlaceCall>(async () => ({ sid: "CA123" }));
  const agent: Agent = { respond: vi.fn(agentRespond) };
  const app = createApp({ config, agent, placeCall, store });
  return { app, config, store, placeCall, agent };
}

async function startCall(app: ReturnType<typeof setup>["app"]) {
  const res = await request(app)
    .post("/test-call")
    .set("Authorization", "Bearer secret")
    .send({ task: "Запиши час при зъболекар." });
  return res.body.conversationId as string;
}

describe("POST /test-call", () => {
  it("rejects requests without the token", async () => {
    const { app, placeCall } = setup();
    const res = await request(app).post("/test-call").send({});
    expect(res.status).toBe(401);
    expect(placeCall).not.toHaveBeenCalled();
  });

  it("calls the test number with webhook URLs for the conversation", async () => {
    const { app, placeCall, config } = setup();
    const res = await request(app).post("/test-call").set("Authorization", "Bearer secret").send({});
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ callSid: "CA123", task: config.agent.defaultTask });
    const cid = res.body.conversationId;
    expect(placeCall).toHaveBeenCalledWith({
      to: "+359888000000",
      from: "+15550001111",
      url: `https://example.ngrok.app/twilio/voice?cid=${cid}`,
      statusCallback: `https://example.ngrok.app/twilio/status?cid=${cid}`,
    });
  });

  it("returns 502 when Twilio fails", async () => {
    const { app, placeCall } = setup();
    placeCall.mockRejectedValueOnce(Object.assign(new Error("The number is unverified."), { code: 21219 }));
    const res = await request(app).post("/test-call").set("Authorization", "Bearer secret").send({});
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ twilioCode: 21219, twilioMessage: "The number is unverified." });
  });
});

describe("Twilio webhooks", () => {
  it("hands the call to ConversationRelay in Bulgarian with the AI disclosure", async () => {
    const { app } = setup(vi.fn(), { VOICE_MODE: "relay" });
    const cid = await startCall(app);
    const res = await request(app).post(`/twilio/voice?cid=${cid}`).type("form").send({});
    expect(res.type).toBe("text/xml");
    expect(res.text).toContain(`<Connect action="https://example.ngrok.app/twilio/relay-done?cid=${cid}"`);
    expect(res.text).toContain('url="wss://example.ngrok.app/relay"');
    expect(res.text).toContain('language="bg-BG"');
    expect(res.text).toContain('welcomeGreetingInterruptible="none"');
    expect(res.text).toMatch(/welcomeGreeting="[^"]*AI асистент/);
    expect(res.text).toContain(`<Parameter name="cid" value="${cid}"/>`);
  });

  it("gather mode: opens with the disclosure and listens in Bulgarian", async () => {
    const { app } = setup();
    const cid = await startCall(app);
    const res = await request(app).post(`/twilio/voice?cid=${cid}`).type("form").send({});
    expect(res.text).toContain('<Gather input="speech" language="bg-BG"');
    expect(res.text).toContain(`action="https://example.ngrok.app/twilio/gather?cid=${cid}"`);
    expect(res.text).toContain('voice="Google.bg-BG-Standard-A"');
    expect(res.text).toContain("AI асистент");
  });

  it("gather mode: answers recognized speech via the agent", async () => {
    const { app, agent, store } = setup(async (conversation) => {
      conversation.messages.push({ role: "assistant", content: "Във вторник?" });
      return { say: "Във вторник?", endCall: false };
    });
    const cid = await startCall(app);
    const res = await request(app)
      .post(`/twilio/gather?cid=${cid}`)
      .type("form")
      .send({ SpeechResult: "Да, слушам.", Confidence: "0.9" });
    expect(agent.respond).toHaveBeenCalledOnce();
    expect(res.text).toContain("Във вторник?");
    expect(res.text).toContain("<Gather");
    expect(store.get(cid)!.transcript.at(-2)).toEqual({ speaker: "callee", text: "Да, слушам.", confidence: 0.9 });
  });

  it("gather mode: hangs up after end_call and after repeated silence", async () => {
    const ended = setup(async () => ({ say: "Довиждане!", endCall: true }));
    const cid = await startCall(ended.app);
    const res = await request(ended.app).post(`/twilio/gather?cid=${cid}`).type("form").send({ SpeechResult: "Записах ви." });
    expect(res.text).toContain("Довиждане!");
    expect(res.text).toContain("<Hangup/>");

    const silent = setup();
    const cid2 = await startCall(silent.app);
    for (let i = 0; i < 2; i++) {
      const r = await request(silent.app).post(`/twilio/gather?cid=${cid2}`).type("form").send({});
      expect(r.text).toContain("не ви чух");
    }
    const last = await request(silent.app).post(`/twilio/gather?cid=${cid2}`).type("form").send({});
    expect(last.text).toContain("<Hangup/>");
    expect(silent.agent.respond).not.toHaveBeenCalled();
  });

  it("hangs up for an unknown conversation and after the relay ends", async () => {
    const { app } = setup();
    const unknown = await request(app).post("/twilio/voice?cid=nope").type("form").send({});
    expect(unknown.text).toContain("<Hangup/>");
    const done = await request(app).post("/twilio/relay-done?cid=x").type("form").send({ SessionStatus: "ended" });
    expect(done.text).toContain("<Hangup/>");
  });

  it("forgets the conversation when the call completes", async () => {
    const { app, store } = setup();
    const cid = await startCall(app);
    const res = await request(app).post(`/twilio/status?cid=${cid}`).type("form").send({ CallStatus: "completed" });
    expect(res.status).toBe(204);
    expect(store.get(cid)).toBeUndefined();
  });

  it("rejects webhooks with an invalid signature when validation is on", async () => {
    const config = { ...testConfig() };
    config.twilio = { ...config.twilio, validateSignature: true };
    const app = createApp({ config, agent: { respond: vi.fn() }, placeCall: vi.fn() });
    const bad = await request(app).post("/twilio/voice?cid=x").set("X-Twilio-Signature", "nope").type("form").send({ A: "1" });
    expect(bad.status).toBe(403);

    // Unsigned requests pass through; the unknown conversation id still hangs up.
    const unsigned = await request(app).post("/twilio/voice?cid=x").type("form").send({ A: "1" });
    expect(unsigned.status).toBe(200);
    expect(unsigned.text).toContain("<Hangup/>");

    const url = "https://example.ngrok.app/twilio/voice?cid=x";
    const signature = twilio.getExpectedTwilioSignature("twilio-token", url, { A: "1" });
    const good = await request(app).post("/twilio/voice?cid=x").set("X-Twilio-Signature", signature).type("form").send({ A: "1" });
    expect(good.status).toBe(200);
  });
});

describe("GET /logs", () => {
  it("requires the token and returns recent lines", async () => {
    const { app } = setup();
    recordLog("log", ["[test] hello"]);
    expect((await request(app).get("/logs")).status).toBe(401);
    const res = await request(app).get("/logs").set("Authorization", "Bearer secret");
    expect(res.status).toBe(200);
    expect(res.body.lines.at(-1)).toMatch(/\[test\] hello$/);
  });

  it("includes Twilio debugger alerts when available", async () => {
    const app = createApp({
      config: testConfig(),
      agent: { respond: vi.fn() },
      placeCall: vi.fn(),
      fetchTwilioAlerts: async () => ["2026-10-06 error 64101: WebSocket failed"],
    });
    const res = await request(app).get("/logs").set("Authorization", "Bearer secret");
    expect(res.body.twilioAlerts).toEqual(["2026-10-06 error 64101: WebSocket failed"]);
  });
});

describe("GET /", () => {
  it("serves the phone-friendly trigger page without exposing the token", async () => {
    const { app } = setup();
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Звънни ми");
    expect(res.text).not.toContain("secret");
    // A syntax error here makes the form fall back to a plain reload.
    const script = res.text.split("<script>")[1]!.split("</script>")[0]!;
    expect(() => new Function(script)).not.toThrow();
  });
});
