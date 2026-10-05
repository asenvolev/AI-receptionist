import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import type { Conversation } from "./conversation.js";

export interface AgentReply {
  say: string;
  endCall: boolean;
}

export interface Agent {
  /** Generates the next spoken line. The callee's latest words must already be in conversation.messages. */
  reply(conversation: Conversation): Promise<AgentReply>;
}

const END_CALL_TOOL: Anthropic.Beta.BetaTool = {
  name: "end_call",
  description:
    "Затваря телефона. Извикай го, когато разговорът е приключил: часът е записан и потвърден, " +
    "няма подходящ час, или отсреща искат да приключат. Сбогуването кажи в текста на същия отговор.",
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
  strict: true,
};

export function systemPrompt(conversation: Conversation): string {
  return `Ти си AI асистент, който води телефонен разговор на български от името на ${conversation.userName}.

Задача: ${conversation.task}

Контекст:
- В началото на разговора вече си се представил като AI асистент. Ако те попитат дали си човек или робот, винаги отговаряй честно, че си AI асистент.
- Съобщенията от потребителя са думите на човека отсреща, автоматично разпознати от реч. Може да съдържат грешки. Ако нещо е неясно или звучи странно, помоли учтиво да повторят или потвърди какво си разбрал.
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

const FALLBACK_LINE = "Извинете, бихте ли повторили?";
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

  async reply(conversation: Conversation): Promise<AgentReply> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.config.model,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: this.config.effort },
        system: systemPrompt(conversation),
        tools: [END_CALL_TOOL],
        messages: conversation.messages,
      });
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        console.error(`[agent] Claude API error ${error.status}: ${error.message}`);
      } else {
        console.error("[agent] Claude request failed:", error);
      }
      return { say: ERROR_LINE, endCall: true };
    }

    if (response.stop_reason === "refusal") {
      console.error("[agent] Claude refused:", response.stop_details);
      return { say: ERROR_LINE, endCall: true };
    }

    // Keep the full content (thinking blocks included) so history stays append-only.
    conversation.messages.push({ role: "assistant", content: response.content });

    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text.trim()] : []))
      .filter(Boolean)
      .join(" ");
    const endCall = response.content.some(
      (block) => block.type === "tool_use" && block.name === "end_call",
    );

    if (endCall) {
      const outcome = response.content.find(
        (block): block is Anthropic.Beta.BetaToolUseBlock =>
          block.type === "tool_use" && block.name === "end_call",
      )?.input;
      console.log(`[agent] end_call ${conversation.id}:`, outcome);
    }

    return { say: text || (endCall ? GOODBYE_LINE : FALLBACK_LINE), endCall };
  }
}
