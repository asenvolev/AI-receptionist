import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";

export interface TranscriptLine {
  speaker: "agent" | "callee";
  text: string;
  /** Speech-recognition confidence (0–1), only for callee lines. */
  confidence?: number;
}

export interface Conversation {
  id: string;
  task: string;
  userName: string;
  /** Claude history. Append-only: never edit earlier entries. */
  messages: Anthropic.Beta.BetaMessageParam[];
  transcript: TranscriptLine[];
  /** Number of callee turns answered by the agent. */
  turns: number;
  /** What the callee heard of the agent's last reply before talking over it. */
  pendingInterruption?: string;
  /** Gather mode: consecutive turns where the callee said nothing. */
  silentStreak?: number;
  callSid?: string;
  createdAt: number;
  status: CallStatus;
  /** The agent's summary from end_call, e.g. "Записан вторник 15:00". */
  outcome?: string;
  /** Why the call ended when there is no outcome from the agent. */
  endReason?: string;
}

export type CallStatus = "calling" | "in-progress" | "ended";

/** Marks the call as over; the first recorded outcome/reason wins. */
export function finishCall(conversation: Conversation, details: { outcome?: string; endReason?: string }): void {
  conversation.status = "ended";
  conversation.outcome ??= details.outcome;
  if (!conversation.outcome) conversation.endReason ??= details.endReason;
}

export function greetingFor(userName: string): string {
  // Fixed text, not model output: the AI disclosure (EU AI Act) must be said
  // on every call regardless of what the model does.
  return (
    `Здравейте! Обаждам се от името на ${userName}. ` +
    "Искам да уточня, че съм AI асистент, а не човек, и разговорът не се записва. " +
    "Удобно ли ви е да говорим?"
  );
}

export function createConversation(task: string, userName: string): Conversation {
  const greeting = greetingFor(userName);
  return {
    id: randomUUID(),
    task,
    userName,
    messages: [
      {
        role: "user",
        content:
          "[Обаждането е свързано. Отсреща вдигна регистратурата. " +
          "Следващите съобщения са думите на човека отсреща, разпознати от реч.]",
      },
      { role: "assistant", content: greeting },
    ],
    transcript: [{ speaker: "agent", text: greeting }],
    turns: 0,
    createdAt: Date.now(),
    status: "calling",
  };
}

/**
 * Adds the callee's words as the next user turn. If the previous reply was
 * aborted (so no assistant turn followed), the words join the trailing user
 * turn instead; that turn has no later thinking blocks, so changing it keeps
 * the rest of the history append-only.
 */
export function addCalleeTurn(conversation: Conversation, speech: string): void {
  let text = speech;
  if (conversation.pendingInterruption !== undefined) {
    const heard = conversation.pendingInterruption.trim();
    text = heard
      ? `[Прекъснаха те. От последната ти реплика чуха само: „${heard}“] ${speech}`
      : `[Прекъснаха те, преди да чуят последната ти реплика.] ${speech}`;
    conversation.pendingInterruption = undefined;
  }
  const last = conversation.messages.at(-1);
  if (last?.role === "user" && typeof last.content === "string") {
    last.content = `${last.content} ${text}`;
  } else {
    conversation.messages.push({ role: "user", content: text });
  }
}

const MAX_AGE_MS = 60 * 60 * 1000;

/** In-memory store. Good enough for single-process testing (MVP step 1). */
export class ConversationStore {
  private readonly items = new Map<string, Conversation>();

  add(conversation: Conversation): void {
    this.prune();
    this.items.set(conversation.id, conversation);
  }

  get(id: string | undefined): Conversation | undefined {
    return id ? this.items.get(id) : undefined;
  }

  delete(id: string): void {
    this.items.delete(id);
  }

  private prune(): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const [id, conversation] of this.items) {
      if (conversation.createdAt < cutoff) this.items.delete(id);
    }
  }
}
