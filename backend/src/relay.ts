import type { Agent } from "./agent.js";
import type { Config } from "./config.js";
import { addCalleeTurn, type Conversation, type ConversationStore } from "./conversation.js";

/** The subset of a `ws` WebSocket the relay session uses. */
export interface RelaySocket {
  send(data: string): void;
  close(): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

type IncomingMessage =
  | { type: "setup"; callSid?: string; customParameters?: Record<string, string> }
  | { type: "prompt"; voicePrompt?: string; last?: boolean; lang?: string }
  | { type: "interrupt"; utteranceUntilInterrupt?: string; durationUntilInterruptMs?: number }
  | { type: "dtmf"; digit?: string }
  | { type: "error"; description?: string }
  | { type: string };

export interface RelayDeps {
  store: ConversationStore;
  agent: Agent;
  config: Config;
  /** Approximate TTS duration, used to let the goodbye finish before hanging up. */
  speechDurationMs?: (text: string) => number;
}

const MAX_TURNS_CLOSING = "Ще трябва да приключа разговора. Благодаря ви, довиждане!";

/** Rough speaking time for Bulgarian TTS: ~14 characters per second plus a margin. */
export const estimateSpeechMs = (text: string) => 1500 + text.length * 70;

/**
 * One ConversationRelay WebSocket session = one phone call. Twilio does
 * speech-to-text and text-to-speech; we exchange text with Claude, streaming
 * tokens back so the agent starts talking before the full reply is ready.
 */
export function handleRelaySocket(ws: RelaySocket, deps: RelayDeps): void {
  const { store, agent, config } = deps;
  const speechDurationMs = deps.speechDurationMs ?? estimateSpeechMs;
  let conversation: Conversation | undefined;
  let generation: AbortController | undefined;
  let endTimer: NodeJS.Timeout | undefined;
  let ending = false;

  const send = (message: object) => ws.send(JSON.stringify(message));
  const sendText = (token: string, last: boolean) => send({ type: "text", token, last });

  const endAfterSpeech = (spokenThisTurn: string, outcome?: string) => {
    ending = true;
    endTimer = setTimeout(() => {
      send({ type: "end", handoffData: JSON.stringify({ outcome: outcome ?? null }) });
    }, speechDurationMs(spokenThisTurn));
  };

  const onPrompt = async (speech: string) => {
    if (!conversation || ending) return;
    generation?.abort();
    const controller = new AbortController();
    generation = controller;

    conversation.transcript.push({ speaker: "callee", text: speech });
    console.log(`[relay] ${conversation.id} callee: ${speech}`);
    addCalleeTurn(conversation, speech);
    conversation.turns += 1;

    let streamed = "";
    const reply = await agent.respond(conversation, {
      signal: controller.signal,
      onText: (text) => {
        if (controller.signal.aborted) return;
        streamed += text;
        sendText(text, false);
      },
    });
    if (controller.signal.aborted || !reply) {
      if (streamed.trim()) {
        conversation.transcript.push({ speaker: "agent", text: `${streamed.trim()} …[прекъснат]` });
      }
      return;
    }
    generation = undefined;

    let spoken = reply.say;
    if (!reply.endCall && conversation.turns >= config.agent.maxTurns) {
      sendText(` ${MAX_TURNS_CLOSING}`, false);
      spoken = `${spoken} ${MAX_TURNS_CLOSING}`.trim();
    }
    sendText("", true);
    conversation.transcript.push({ speaker: "agent", text: spoken });
    console.log(`[relay] ${conversation.id} agent: ${spoken}${reply.endCall ? " [end_call]" : ""}`);

    if (reply.endCall || conversation.turns >= config.agent.maxTurns) {
      if (reply.outcome) console.log(`[relay] ${conversation.id} outcome: ${reply.outcome}`);
      endAfterSpeech(spoken, reply.outcome);
    }
  };

  ws.on("message", (data) => {
    let message: IncomingMessage;
    try {
      message = JSON.parse(String(data)) as IncomingMessage;
    } catch {
      console.warn("[relay] ignoring non-JSON message");
      return;
    }

    switch (message.type) {
      case "setup": {
        const setup = message as Extract<IncomingMessage, { type: "setup" }>;
        conversation = store.get(setup.customParameters?.cid);
        if (!conversation) {
          console.warn(`[relay] unknown conversation for call ${setup.callSid}; ending`);
          send({ type: "end", handoffData: JSON.stringify({ error: "unknown conversation" }) });
          return;
        }
        conversation.callSid = setup.callSid ?? conversation.callSid;
        console.log(`[relay] ${conversation.id} connected (CallSid=${setup.callSid})`);
        return;
      }
      case "prompt": {
        const prompt = message as Extract<IncomingMessage, { type: "prompt" }>;
        // With partialPrompts off (default) every prompt is final; skip partials if they appear.
        if (prompt.last === false) return;
        const speech = prompt.voicePrompt?.trim();
        if (speech) {
          onPrompt(speech).catch((error) => console.error("[relay] prompt handling failed:", error));
        }
        return;
      }
      case "interrupt": {
        const interrupt = message as Extract<IncomingMessage, { type: "interrupt" }>;
        if (!conversation || ending) return;
        generation?.abort();
        generation = undefined;
        conversation.pendingInterruption = interrupt.utteranceUntilInterrupt ?? "";
        console.log(`[relay] ${conversation.id} interrupted after: ${interrupt.utteranceUntilInterrupt ?? ""}`);
        return;
      }
      case "error": {
        const error = message as Extract<IncomingMessage, { type: "error" }>;
        console.error(`[relay] Twilio error: ${error.description}`);
        return;
      }
      default:
        return;
    }
  });

  ws.on("close", () => {
    generation?.abort();
    if (endTimer) clearTimeout(endTimer);
  });
}
