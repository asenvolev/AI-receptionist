import { createServer, type Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import twilio from "twilio";
import { WebSocketServer } from "ws";
import type { Agent } from "./agent.js";
import type { Config } from "./config.js";
import { ConversationStore, createConversation } from "./conversation.js";
import { recentLogs } from "./logs.js";
import { testCallPage } from "./page.js";
import { handleRelaySocket } from "./relay.js";

const { VoiceResponse } = twilio.twiml;

export const RELAY_PATH = "/relay";

export interface PlaceCallParams {
  to: string;
  from: string;
  url: string;
  statusCallback: string;
}

/** Thin seam over Twilio's REST client so routes can be tested without real calls. */
export type PlaceCall = (params: PlaceCallParams) => Promise<{ sid: string }>;

export function twilioPlaceCall(config: Config["twilio"]): PlaceCall {
  const client = twilio(config.accountSid, config.authToken);
  return async ({ statusCallback, ...required }) => {
    try {
      return await client.calls.create({
        ...required,
        statusCallback,
        statusCallbackEvent: ["completed"],
        statusCallbackMethod: "POST",
      });
    } catch (error) {
      // Trial accounts reject some optional parameters; the call works without
      // the status callback (we only lose the end-of-call transcript log).
      console.warn("[call] retrying without status callback:", (error as Error)?.message);
      return client.calls.create(required);
    }
  };
}

export interface AppDeps {
  config: Config;
  agent: Agent;
  placeCall: PlaceCall;
  store?: ConversationStore;
}

export function createApp({ config, placeCall, store = new ConversationStore() }: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use("/twilio", (req, res, next) => {
    res.on("finish", () => console.log(`[twilio] ${req.method} /twilio${req.path} → ${res.statusCode}`));
    next();
  });

  const url = (path: string, conversationId: string) =>
    `${config.publicBaseUrl}${path}?cid=${encodeURIComponent(conversationId)}`;

  const sendTwiml = (res: Response, twiml: twilio.twiml.VoiceResponse) => {
    res.type("text/xml").send(twiml.toString());
  };

  const hangUp = () => {
    const twiml = new VoiceResponse();
    twiml.hangup();
    return twiml;
  };

  const requireTwilioSignature = (req: Request, res: Response, next: NextFunction) => {
    if (!config.twilio.validateSignature) return next();
    const signature = req.header("X-Twilio-Signature") ?? "";
    const fullUrl = `${config.publicBaseUrl}${req.originalUrl}`;
    if (twilio.validateRequest(config.twilio.authToken, signature, fullUrl, req.body ?? {})) {
      return next();
    }
    console.warn(`[twilio] rejected request with invalid signature: ${req.originalUrl}`);
    res.status(403).send("Invalid Twilio signature");
  };

  app.get("/", (_req, res) => {
    res.type("html").send(testCallPage(config.agent.defaultTask));
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const isAuthorized = (req: Request) => req.header("Authorization") === `Bearer ${config.testCallToken}`;

  // Logs can contain call transcripts, so they need the same token.
  app.get("/logs", (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json({ lines: recentLogs() });
  });

  app.post("/test-call", async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const task =
      typeof req.body?.task === "string" && req.body.task.trim()
        ? req.body.task.trim()
        : config.agent.defaultTask;

    const conversation = createConversation(task, config.agent.userName);
    store.add(conversation);

    try {
      const call = await placeCall({
        to: config.testPhoneNumber,
        from: config.twilio.fromNumber,
        url: url("/twilio/voice", conversation.id),
        statusCallback: url("/twilio/status", conversation.id),
      });
      conversation.callSid = call.sid;
      console.log(`[call] ${conversation.id} placed, CallSid=${call.sid}`);
      res.status(202).json({ conversationId: conversation.id, callSid: call.sid, task });
    } catch (error) {
      store.delete(conversation.id);
      console.error("[call] Twilio failed to place the call:", error);
      // The caller is already authenticated, so pass Twilio's reason through.
      const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
      res.status(502).json({
        error: "failed to place call",
        ...(typeof code === "number" ? { twilioCode: code } : {}),
        ...(typeof message === "string" ? { twilioMessage: message } : {}),
      });
    }
  });

  // Twilio fetches this when the callee picks up: hand the call to ConversationRelay.
  app.post("/twilio/voice", requireTwilioSignature, (req, res) => {
    const conversation = store.get(req.query.cid as string | undefined);
    if (!conversation) {
      console.warn(`[call] /twilio/voice for unknown conversation ${req.query.cid}; hanging up`);
      sendTwiml(res, hangUp());
      return;
    }
    const twiml = new VoiceResponse();
    const connect = twiml.connect({ action: url("/twilio/relay-done", conversation.id), method: "POST" });
    const relay = connect.conversationRelay({
      url: `${config.publicBaseUrl.replace(/^http/, "ws")}${RELAY_PATH}`,
      language: "bg-BG",
      // Fixed AI disclosure, spoken in full before the callee can talk over it.
      welcomeGreeting: conversation.transcript[0]!.text,
      welcomeGreetingInterruptible: "none",
      interruptible: "speech",
      ...(config.voice.ttsProvider ? { ttsProvider: config.voice.ttsProvider } : {}),
      ...(config.voice.voice ? { voice: config.voice.voice } : {}),
      ...(config.voice.transcriptionProvider
        ? { transcriptionProvider: config.voice.transcriptionProvider }
        : {}),
      ...(config.voice.speechModel ? { speechModel: config.voice.speechModel } : {}),
      ...(config.voice.hints ? { hints: config.voice.hints } : {}),
    });
    relay.parameter({ name: "cid", value: conversation.id });
    console.log(`[call] ${conversation.id} answered; connecting ConversationRelay to ${config.publicBaseUrl.replace(/^http/, "ws")}${RELAY_PATH}`);
    sendTwiml(res, twiml);
  });

  // Twilio calls this when the relay session ends (we sent "end", or an error).
  app.post("/twilio/relay-done", requireTwilioSignature, (req, res) => {
    console.log(
      `[call] ${req.query.cid} relay ended: status=${req.body.SessionStatus ?? "?"} ` +
        `handoff=${req.body.HandoffData ?? "-"}${req.body.ErrorMessage ? ` error=${req.body.ErrorMessage}` : ""}`,
    );
    sendTwiml(res, hangUp());
  });

  app.post("/twilio/status", requireTwilioSignature, (req, res) => {
    const conversation = store.get(req.query.cid as string | undefined);
    if (conversation) {
      console.log(
        `[call] ${conversation.id} finished (${req.body.CallStatus}, ${req.body.CallDuration ?? "?"}s). Transcript:\n` +
          conversation.transcript
            .map((line) => `  ${line.speaker === "agent" ? "AI" : "Отсреща"}: ${line.text}`)
            .join("\n"),
      );
      store.delete(conversation.id);
    }
    res.sendStatus(204);
  });

  return app;
}

/** HTTP server with the Express app plus the ConversationRelay WebSocket endpoint. */
export function createAppServer(deps: AppDeps): Server {
  const store = deps.store ?? new ConversationStore();
  const server = createServer(createApp({ ...deps, store }));
  const wss = new WebSocketServer({ server, path: RELAY_PATH });
  // The socket is only useful with a valid conversation id, which is an
  // unguessable UUID that Twilio receives from our signed webhook response.
  wss.on("connection", (ws, req) => {
    console.log(`[relay] WebSocket connected from ${req.headers["x-forwarded-for"] ?? req.socket.remoteAddress}`);
    handleRelaySocket(ws, { store, agent: deps.agent, config: deps.config });
  });
  return server;
}
