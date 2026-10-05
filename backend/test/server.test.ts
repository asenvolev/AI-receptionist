import request from "supertest";
import twilio from "twilio";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../src/agent.js";
import { ConversationStore } from "../src/conversation.js";
import { createApp, type PlaceCall } from "../src/server.js";
import { testConfig } from "./helpers.js";

function setup(agentReply: Agent["reply"] = async () => ({ say: "Добре.", endCall: false })) {
  const config = testConfig();
  const store = new ConversationStore();
  const placeCall = vi.fn<PlaceCall>(async () => ({ sid: "CA123" }));
  const agent: Agent = { reply: vi.fn(agentReply) };
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
    placeCall.mockRejectedValueOnce(new Error("boom"));
    const res = await request(app).post("/test-call").set("Authorization", "Bearer secret").send({});
    expect(res.status).toBe(502);
  });
});

describe("Twilio webhooks", () => {
  it("opens with the AI disclosure in Bulgarian and listens", async () => {
    const { app } = setup();
    const cid = await startCall(app);
    const res = await request(app).post(`/twilio/voice?cid=${cid}`).type("form").send({});
    expect(res.type).toBe("text/xml");
    expect(res.text).toContain("AI асистент");
    expect(res.text).toContain('<Gather input="speech" language="bg-BG"');
    expect(res.text).toContain('voice="Google.bg-BG-Standard-A"');
  });

  it("passes recognized speech to the agent and speaks its reply", async () => {
    const { app, agent, store } = setup(async () => ({ say: "Във вторник в петнайсет часа?", endCall: false }));
    const cid = await startCall(app);
    const res = await request(app)
      .post(`/twilio/gather?cid=${cid}`)
      .type("form")
      .send({ SpeechResult: "Да, слушам.", Confidence: "0.91" });
    expect(agent.reply).toHaveBeenCalledOnce();
    expect(res.text).toContain("Във вторник в петнайсет часа?");
    expect(res.text).toContain("<Gather");
    const conversation = store.get(cid)!;
    expect(conversation.messages.at(-1)).toEqual({ role: "user", content: "Да, слушам." });
    expect(conversation.transcript.at(-2)).toEqual({ speaker: "callee", text: "Да, слушам.", confidence: 0.91 });
  });

  it("hangs up when the agent ends the call", async () => {
    const { app } = setup(async () => ({ say: "Благодаря, довиждане!", endCall: true }));
    const cid = await startCall(app);
    const res = await request(app).post(`/twilio/gather?cid=${cid}`).type("form").send({ SpeechResult: "Записах ви." });
    expect(res.text).toContain("<Hangup/>");
    expect(res.text).not.toContain("<Gather");
  });

  it("reprompts on silence and hangs up after repeated silence", async () => {
    const { app, agent } = setup();
    const cid = await startCall(app);
    for (let i = 0; i < 2; i++) {
      const res = await request(app).post(`/twilio/gather?cid=${cid}`).type("form").send({});
      expect(res.text).toContain("не ви чух");
    }
    const res = await request(app).post(`/twilio/gather?cid=${cid}`).type("form").send({});
    expect(res.text).toContain("<Hangup/>");
    expect(agent.reply).not.toHaveBeenCalled();
  });

  it("ends the call after the turn limit", async () => {
    const { app } = setup();
    const cid = await startCall(app);
    let res;
    for (let i = 0; i < 3; i++) {
      res = await request(app).post(`/twilio/gather?cid=${cid}`).type("form").send({ SpeechResult: `реплика ${i}` });
    }
    expect(res!.text).toContain("<Hangup/>");
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
    const app = createApp({ config, agent: { reply: vi.fn() }, placeCall: vi.fn() });
    const bad = await request(app).post("/twilio/voice?cid=x").set("X-Twilio-Signature", "nope").type("form").send({ A: "1" });
    expect(bad.status).toBe(403);

    const url = "https://example.ngrok.app/twilio/voice?cid=x";
    const signature = twilio.getExpectedTwilioSignature("twilio-token", url, { A: "1" });
    const good = await request(app).post("/twilio/voice?cid=x").set("X-Twilio-Signature", signature).type("form").send({ A: "1" });
    expect(good.status).toBe(200);
  });
});

describe("GET /", () => {
  it("serves the phone-friendly trigger page without exposing the token", async () => {
    const { app } = setup();
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Звънни ми");
    expect(res.text).not.toContain("secret");
  });
});
