import express, { type NextFunction, type Request, type Response } from "express";
import twilio from "twilio";
import type { Agent } from "./agent.js";
import type { Config } from "./config.js";
import { ConversationStore, createConversation, type Conversation } from "./conversation.js";

const { VoiceResponse } = twilio.twiml;
type SayAttributes = Parameters<twilio.twiml.VoiceResponse["say"]>[0];

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
  return (params) =>
    client.calls.create({
      ...params,
      statusCallbackEvent: ["completed"],
      statusCallbackMethod: "POST",
    });
}

export interface AppDeps {
  config: Config;
  agent: Agent;
  placeCall: PlaceCall;
  store?: ConversationStore;
}

const MAX_SILENT_GATHERS = 2;

export function createApp({ config, agent, placeCall, store = new ConversationStore() }: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const url = (path: string, conversationId: string) =>
    `${config.publicBaseUrl}${path}?cid=${encodeURIComponent(conversationId)}`;

  const sayAttributes: SayAttributes = {
    // Not limited to the voices typed in the SDK; Twilio adds new ones over time.
    voice: config.voice.ttsVoice as NonNullable<SayAttributes>["voice"],
    language: "bg-BG",
  };

  /** Speak `text`, then listen for the callee's answer. */
  const sayAndListen = (conversation: Conversation, text: string) => {
    const twiml = new VoiceResponse();
    const gather = twiml.gather({
      input: ["speech"],
      language: "bg-BG",
      action: url("/twilio/gather", conversation.id),
      method: "POST",
      actionOnEmptyResult: true,
      speechTimeout: config.voice.speechTimeout,
      ...(config.voice.speechModel ? { speechModel: config.voice.speechModel } : {}),
    });
    gather.say(sayAttributes, text);
    return twiml;
  };

  const sayAndHangUp = (text: string) => {
    const twiml = new VoiceResponse();
    twiml.say(sayAttributes, text);
    twiml.hangup();
    return twiml;
  };

  const sendTwiml = (res: Response, twiml: twilio.twiml.VoiceResponse) => {
    res.type("text/xml").send(twiml.toString());
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

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/test-call", async (req, res) => {
    if (req.header("Authorization") !== `Bearer ${config.testCallToken}`) {
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
      res.status(502).json({ error: "failed to place call" });
    }
  });

  // Twilio fetches this when the callee picks up.
  app.post("/twilio/voice", requireTwilioSignature, (req, res) => {
    const conversation = store.get(req.query.cid as string | undefined);
    if (!conversation) {
      sendTwiml(res, sayAndHangUp("Извинете, грешка в обаждането. Довиждане!"));
      return;
    }
    const greeting = conversation.transcript[0]!.text;
    sendTwiml(res, sayAndListen(conversation, greeting));
  });

  // Twilio posts the recognized speech here after each <Gather>.
  app.post("/twilio/gather", requireTwilioSignature, async (req, res) => {
    const conversation = store.get(req.query.cid as string | undefined);
    if (!conversation) {
      sendTwiml(res, sayAndHangUp("Извинете, грешка в обаждането. Довиждане!"));
      return;
    }

    const speech = typeof req.body.SpeechResult === "string" ? req.body.SpeechResult.trim() : "";
    if (!speech) {
      conversation.silentStreak += 1;
      if (conversation.silentStreak > MAX_SILENT_GATHERS) {
        sendTwiml(res, sayAndHangUp("Не ви чувам добре. Ще се обадим отново. Довиждане!"));
        return;
      }
      sendTwiml(res, sayAndListen(conversation, "Извинете, не ви чух. Бихте ли повторили?"));
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

    conversation.messages.push({ role: "user", content: speech });
    conversation.turns += 1;

    const reply = await agent.reply(conversation);
    conversation.transcript.push({ speaker: "agent", text: reply.say });
    console.log(`[call] ${conversation.id} agent: ${reply.say}${reply.endCall ? " [end_call]" : ""}`);

    if (reply.endCall) {
      sendTwiml(res, sayAndHangUp(reply.say));
    } else if (conversation.turns >= config.agent.maxTurns) {
      const closing = "Ще трябва да приключа разговора. Благодаря ви, довиждане!";
      conversation.transcript.push({ speaker: "agent", text: closing });
      sendTwiml(res, sayAndHangUp(`${reply.say} ${closing}`));
    } else {
      sendTwiml(res, sayAndListen(conversation, reply.say));
    }
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
