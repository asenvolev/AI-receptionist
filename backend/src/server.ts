import { createServer, type Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import twilio from "twilio";
import { WebSocketServer } from "ws";
import type { Agent } from "./agent.js";
import type { Config } from "./config.js";
import {
  addCalleeTurn,
  ConversationStore,
  createConversation,
  finishCall,
  type Conversation,
} from "./conversation.js";
import { recentLogs } from "./logs.js";
import { testCallPage } from "./page.js";
import { handleRelaySocket } from "./relay.js";

const { VoiceResponse } = twilio.twiml;
type SayAttributes = NonNullable<Parameters<twilio.twiml.VoiceResponse["say"]>[0]>;

const MAX_SILENT_GATHERS = 2;
const MAX_TURNS_CLOSING = "Ще трябва да приключа разговора. Благодаря ви, довиждане!";

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

/** Recent errors/warnings from Twilio's debugger, formatted as text lines. */
export type FetchTwilioAlerts = () => Promise<string[]>;

const ALERTS_CACHE_MS = 15_000;

export function twilioFetchAlerts(config: Config["twilio"]): FetchTwilioAlerts {
  const client = twilio(config.accountSid, config.authToken);
  let cache: { at: number; lines: string[] } | undefined;
  return async () => {
    if (cache && Date.now() - cache.at < ALERTS_CACHE_MS) return cache.lines;
    const alerts = await client.monitor.v1.alerts.list({ limit: 10 });
    const lines = alerts.map((alert) => {
      // alertText is URL-encoded key=value pairs; "Msg" holds the human-readable part.
      const text = new URLSearchParams(alert.alertText ?? "");
      const message = text.get("Msg") ?? text.get("msg") ?? alert.alertText;
      const time = alert.dateCreated?.toISOString().replace("T", " ").slice(0, 19);
      return `${time} ${alert.logLevel ?? ""} ${alert.errorCode}: ${message} (https://www.twilio.com/docs/errors/${alert.errorCode})`;
    });
    cache = { at: Date.now(), lines };
    return lines;
  };
}

export interface AppDeps {
  config: Config;
  agent: Agent;
  placeCall: PlaceCall;
  fetchTwilioAlerts?: FetchTwilioAlerts;
  store?: ConversationStore;
}

export function createApp({ config, agent, placeCall, fetchTwilioAlerts, store = new ConversationStore() }: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use("/twilio", (req, res, next) => {
    res.on("finish", () => console.log(`[twilio] ${req.method} ${req.originalUrl.split("?")[0]} → ${res.statusCode}`));
    next();
  });

  const url = (path: string, conversationId: string) =>
    `${config.publicBaseUrl}${path}?cid=${encodeURIComponent(conversationId)}`;

  const sendTwiml = (res: Response, twiml: twilio.twiml.VoiceResponse) => {
    res.type("text/xml").send(twiml.toString());
  };

  const hangUp = (goodbye?: string) => {
    const twiml = new VoiceResponse();
    if (goodbye) twiml.say(sayAttributes, goodbye);
    twiml.hangup();
    return twiml;
  };

  // Gather mode: Twilio speaks with <Say>, listens with <Gather>, one turn at a time.
  const sayAttributes: SayAttributes = {
    // Not limited to the voices typed in the SDK; Twilio adds new ones over time.
    voice: config.voice.gatherVoice as SayAttributes["voice"],
    language: "bg-BG",
  };

  const sayAndListen = (conversation: Conversation, text: string) => {
    const twiml = new VoiceResponse();
    const gather = twiml.gather({
      input: ["speech"],
      language: "bg-BG",
      action: url("/twilio/gather", conversation.id),
      method: "POST",
      actionOnEmptyResult: true,
      speechTimeout: "auto",
      ...(config.voice.hints ? { hints: config.voice.hints } : {}),
    });
    gather.say(sayAttributes, text);
    return twiml;
  };

  const requireTwilioSignature = (req: Request, res: Response, next: NextFunction) => {
    if (!config.twilio.validateSignature) return next();
    const signature = req.header("X-Twilio-Signature") ?? "";
    if (!signature) {
      // Seen on Twilio trial accounts: webhooks arrive unsigned. Every webhook
      // still needs a valid, unguessable conversation id, so let it through.
      console.warn(`[twilio] no X-Twilio-Signature on ${req.originalUrl.split("?")[0]}; relying on conversation id`);
      return next();
    }
    const params = { ...(req.body ?? {}) } as Record<string, string>;
    // Twilio signs the exact URL it requested; behind a proxy that can differ
    // from our configured base, so also accept the forwarded host.
    const candidates = [
      `${config.publicBaseUrl}${req.originalUrl}`,
      `https://${req.header("x-forwarded-host") ?? req.header("host")}${req.originalUrl}`,
    ];
    if (candidates.some((url) => twilio.validateRequest(config.twilio.authToken, signature, url, params))) {
      return next();
    }
    console.warn(
      `[twilio] rejected request with invalid signature: ${req.originalUrl} ` +
        `(${Object.keys(params).length} params, tried ${candidates.join(" | ")}). ` +
        "Check TWILIO_AUTH_TOKEN is the primary Auth Token, or set TWILIO_VALIDATE_SIGNATURE=false for testing.",
    );
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
  app.get("/logs", async (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    let twilioAlerts: string[] | undefined;
    if (fetchTwilioAlerts) {
      try {
        twilioAlerts = await fetchTwilioAlerts();
      } catch (error) {
        twilioAlerts = [`(не успях да взема грешките от Twilio: ${(error as Error)?.message})`];
      }
    }
    res.json({ lines: recentLogs(), twilioAlerts });
  });

  // Live status, transcript and result of one test call, for the page.
  app.get("/calls/:id", (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const conversation = store.get(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: "unknown call" });
      return;
    }
    const { status, outcome, endReason, transcript, task } = conversation;
    res.json({ status, outcome, endReason, transcript, task });
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
    if (config.voice.mode === "gather") {
      conversation.status = "in-progress";
      console.log(`[call] ${conversation.id} answered; gather mode`);
      sendTwiml(res, sayAndListen(conversation, conversation.transcript[0]!.text));
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
    conversation.status = "in-progress";
    console.log(`[call] ${conversation.id} answered; connecting ConversationRelay to ${config.publicBaseUrl.replace(/^http/, "ws")}${RELAY_PATH}`);
    sendTwiml(res, twiml);
  });

  // Gather mode: Twilio posts the recognized speech here after each <Gather>.
  app.post("/twilio/gather", requireTwilioSignature, async (req, res) => {
    const conversation = store.get(req.query.cid as string | undefined);
    if (!conversation) {
      sendTwiml(res, hangUp());
      return;
    }

    const speech = typeof req.body.SpeechResult === "string" ? req.body.SpeechResult.trim() : "";
    if (!speech) {
      conversation.silentStreak = (conversation.silentStreak ?? 0) + 1;
      if (conversation.silentStreak > MAX_SILENT_GATHERS) {
        finishCall(conversation, { endReason: "Отсреща не отговаряше (тишина)." });
        sendTwiml(res, hangUp("Не ви чувам добре. Ще се обадим отново. Довиждане!"));
      } else {
        sendTwiml(res, sayAndListen(conversation, "Извинете, не ви чух. Бихте ли повторили?"));
      }
      return;
    }
    conversation.silentStreak = 0;

    const confidence = Number(req.body.Confidence);
    conversation.transcript.push({
      speaker: "callee",
      text: speech,
      ...(Number.isFinite(confidence) ? { confidence } : {}),
    });
    console.log(`[call] ${conversation.id} callee (${req.body.Confidence ?? "?"}): ${speech}`);
    addCalleeTurn(conversation, speech);
    conversation.turns += 1;

    const reply = await agent.respond(conversation, { onText: () => {}, signal: new AbortController().signal });
    if (!reply) {
      finishCall(conversation, { endReason: "Грешка при генериране на отговор." });
      sendTwiml(res, hangUp());
      return;
    }
    let spoken = reply.say;
    const atTurnLimit = !reply.endCall && conversation.turns >= config.agent.maxTurns;
    if (atTurnLimit) spoken = `${spoken} ${MAX_TURNS_CLOSING}`.trim();
    conversation.transcript.push({ speaker: "agent", text: spoken });
    console.log(`[call] ${conversation.id} agent: ${spoken}${reply.endCall ? " [end_call]" : ""}`);
    if (reply.outcome) console.log(`[call] ${conversation.id} outcome: ${reply.outcome}`);

    if (reply.endCall || atTurnLimit) {
      finishCall(conversation, {
        outcome: reply.outcome,
        endReason: atTurnLimit ? "Достигнат е лимитът от реплики." : "Агентът приключи разговора.",
      });
      sendTwiml(res, hangUp(spoken));
    } else {
      sendTwiml(res, sayAndListen(conversation, spoken));
    }
  });

  // Twilio calls this when the relay session ends (we sent "end", or an error).
  app.post("/twilio/relay-done", requireTwilioSignature, (req, res) => {
    console.log(
      `[call] ${req.query.cid} relay ended: status=${req.body.SessionStatus ?? "?"} ` +
        `handoff=${req.body.HandoffData ?? "-"}${req.body.ErrorMessage ? ` error=${req.body.ErrorMessage}` : ""}`,
    );
    const conversation = store.get(req.query.cid as string | undefined);
    if (conversation) finishCall(conversation, { endReason: "Разговорът приключи." });
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
      // Kept (not deleted) so the page can still show the result; the store prunes old calls.
      finishCall(conversation, { endReason: `Обаждането приключи (${req.body.CallStatus ?? "?"}).` });
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
