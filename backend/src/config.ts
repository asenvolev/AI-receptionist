import "dotenv/config";

export interface Config {
  port: number;
  publicBaseUrl: string;
  testCallToken: string;
  twilio: {
    accountSid: string;
    authToken: string;
    fromNumber: string;
    validateSignature: boolean;
  };
  testPhoneNumber: string;
  anthropic: {
    model: string;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
  };
  voice: {
    /**
     * "gather": turn-based <Gather>/<Say>, works on Twilio trial accounts.
     * "relay": ConversationRelay (streaming, interruptible); needs a paid
     * account with the AI/ML features addendum accepted.
     */
    mode: "gather" | "relay";
    /** <Say> voice for gather mode. */
    gatherVoice: string;
    /** Optional ConversationRelay overrides; unset means Twilio's defaults for bg-BG. */
    ttsProvider?: string;
    voice?: string;
    transcriptionProvider?: string;
    speechModel?: string;
    hints?: string;
  };
  agent: {
    userName: string;
    defaultTask: string;
    maxTurns: number;
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  }
  return value;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const effort = env.ANTHROPIC_EFFORT ?? "low";
  if (!EFFORTS.includes(effort as Config["anthropic"]["effort"])) {
    throw new Error(`ANTHROPIC_EFFORT must be one of: ${EFFORTS.join(", ")}`);
  }
  // The Anthropic SDK reads ANTHROPIC_API_KEY itself; check it here so a
  // missing key fails at startup instead of mid-call.
  required(env, "ANTHROPIC_API_KEY");

  return {
    port: Number(env.PORT ?? 3000),
    // Render sets RENDER_EXTERNAL_URL automatically, so PUBLIC_BASE_URL is optional there.
    publicBaseUrl: required(
      env.PUBLIC_BASE_URL ? env : { PUBLIC_BASE_URL: env.RENDER_EXTERNAL_URL },
      "PUBLIC_BASE_URL",
    ).replace(/\/+$/, ""),
    testCallToken: required(env, "TEST_CALL_TOKEN"),
    twilio: {
      accountSid: required(env, "TWILIO_ACCOUNT_SID"),
      authToken: required(env, "TWILIO_AUTH_TOKEN"),
      fromNumber: required(env, "TWILIO_PHONE_NUMBER"),
      validateSignature: env.TWILIO_VALIDATE_SIGNATURE !== "false",
    },
    testPhoneNumber: required(env, "TEST_PHONE_NUMBER"),
    anthropic: {
      model: env.ANTHROPIC_MODEL || "claude-haiku-4-5",
      effort: effort as Config["anthropic"]["effort"],
    },
    voice: {
      mode: env.VOICE_MODE === "relay" ? "relay" : "gather",
      gatherVoice: env.GATHER_TTS_VOICE || "Google.bg-BG-Standard-A",
      ttsProvider: env.TTS_PROVIDER || undefined,
      voice: env.TTS_VOICE || undefined,
      transcriptionProvider: env.STT_PROVIDER || undefined,
      speechModel: env.STT_SPEECH_MODEL || undefined,
      hints: env.STT_HINTS || undefined,
    },
    agent: {
      userName: env.AGENT_USER_NAME ?? "Иван Петров",
      defaultTask:
        env.AGENT_DEFAULT_TASK ??
        "Запиши час при уролог. Свободен е вторник до четвъртък след 14:00.",
      maxTurns: Number(env.AGENT_MAX_TURNS ?? 12),
    },
  };
}
