import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import type { Conversation } from "./conversation.js";

export interface AgentReply {
  /** Everything the agent said this turn (already streamed through onText). */
  say: string;
  endCall: boolean;
  /** Short result summary from end_call, when the agent ended the call. */
  outcome?: string;
}

export interface RespondOptions {
  /** Called with each text chunk as soon as Claude produces it. */
  onText: (text: string) => void;
  signal: AbortSignal;
}

export interface Agent {
  /**
   * Streams the next spoken reply. The callee's latest words must already be in
   * conversation.messages. Resolves to null when aborted (the callee interrupted).
   */
  respond(conversation: Conversation, options: RespondOptions): Promise<AgentReply | null>;
}

const END_CALL_TOOL: Anthropic.Beta.BetaTool = {
  name: "end_call",
  description:
    "Затваря телефона. Извикай го, когато разговорът е приключил: часът е записан и потвърден, " +
    "няма подходящ час, или отсреща искат да приключат. Сбогуването кажи в текста на същия отговор, преди извикването.",
  input_schema: {
    type: "object",
    properties: {
      outcome: {
        type: "string",
        description: "Кратко резюме на резултата, напр. 'Записан вторник 15:00 при д-р Иванов'.",
      },
    },
    required: ["outcome"],
    additionalProperties: false,
  },
  eager_input_streaming: true,
};

export function systemPrompt(conversation: Conversation): string {
  return `Ти си AI асистент, който води телефонен разговор на български от името на ${conversation.userName}.

Задача: ${conversation.task}

Контекст:
- В началото на разговора вече си се представил като AI асистент. Ако те попитат дали си човек или робот, винаги отговаряй честно, че си AI асистент.
- Съобщенията от потребителя са думите на човека отсреща, автоматично разпознати от реч. Може да съдържат грешки. Ако нещо е неясно или звучи странно, помоли учтиво да повторят или потвърди какво си разбрал.
- Ако отсреща те прекъснат, в съобщението ще има бележка в квадратни скоби коя част от репликата ти са чули. Продължи естествено оттам.
- В този тест нямаш достъп до календара. Приемай час само ако е в рамките на наличността от задачата.

Как говориш:
- Говори само на естествен, разговорен български. Отговорът ти се чете на глас от синтезатор.
- По едно-две кратки изречения на реплика. Без списъци, markdown, емоджита и съкращения.
- Часовете и датите казвай с думи, например „във вторник в петнайсет часа“.
- Когато договорите час, повтори ясно деня и часа и поискай потвърждение.

Ограничения:
- Не казвай ЕГН, номер на направление, здравна информация или други чувствителни данни. Ако ги поискат, кажи, че ${conversation.userName} ще ги предостави лично.
- Не измисляй факти за ${conversation.userName}, като телефон или адрес. Ако ги поискат, кажи, че ще ги предаде допълнително.
- Когато разговорът приключи, кажи кратко сбогуване и извикай end_call в същия отговор.`;
}

/**
 * Haiku 4.5 rejects `effort` and has no refusal fallbacks; the newer models
 * get both (low effort keeps phone latency down).
 */
export function modelOptions(config: Config["anthropic"]) {
  if (config.model.startsWith("claude-haiku")) return {};
  return {
    betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[],
    fallbacks: "default" as const,
    output_config: { effort: config.effort },
  };
}

const GOODBYE_LINE = "Благодаря ви, довиждане!";
const ERROR_LINE = "Извинете, имам технически проблем. Ще се обадим отново. Довиждане!";

export class ClaudeAgent implements Agent {
  private readonly client: Anthropic;

  constructor(
    private readonly config: Config["anthropic"],
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic();
  }

  async respond(conversation: Conversation, { onText, signal }: RespondOptions): Promise<AgentReply | null> {
    let spoken = "";
    let response: Anthropic.Beta.BetaMessage;
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.config.model,
          max_tokens: 4000,
          ...modelOptions(this.config),
          system: systemPrompt(conversation),
          tools: [END_CALL_TOOL],
          messages: conversation.messages,
        },
        { signal },
      );
      stream.on("text", (text) => {
        spoken += text;
        onText(text);
      });
      response = await stream.finalMessage();
    } catch (error) {
      if (signal.aborted || error instanceof Anthropic.APIUserAbortError) return null;
      if (error instanceof Anthropic.APIError) {
        console.error(`[agent] Claude API error ${error.status}: ${error.message}`);
      } else {
        console.error("[agent] Claude request failed:", error);
      }
      return this.speak(spoken, ERROR_LINE, onText, true);
    }

    if (response.stop_reason === "refusal") {
      console.error("[agent] Claude refused:", response.stop_details);
      return this.speak(spoken, ERROR_LINE, onText, true);
    }

    // Keep the full content (thinking blocks included) so history stays append-only.
    conversation.messages.push({ role: "assistant", content: response.content });

    const endCallBlock = response.content.find(
      (block): block is Anthropic.Beta.BetaToolUseBlock =>
        block.type === "tool_use" && block.name === "end_call",
    );
    if (!endCallBlock) {
      return { say: spoken.trim(), endCall: false };
    }
    const input = endCallBlock.input as { outcome?: unknown } | null;
    const outcome = typeof input?.outcome === "string" ? input.outcome : undefined;
    if (!spoken.trim()) return { ...this.speak(spoken, GOODBYE_LINE, onText, true), outcome };
    return { say: spoken.trim(), endCall: true, outcome };
  }

  /** Appends a fixed line to whatever was already streamed this turn. */
  private speak(spoken: string, line: string, onText: (text: string) => void, endCall: boolean): AgentReply {
    const chunk = spoken.trim() ? ` ${line}` : line;
    onText(chunk);
    return { say: (spoken + chunk).trim(), endCall };
  }
}
