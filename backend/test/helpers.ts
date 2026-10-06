import { loadConfig } from "../src/config.js";

export const testConfig = (overrides: Record<string, string> = {}) =>
  loadConfig({
    ANTHROPIC_API_KEY: "sk-test",
    PUBLIC_BASE_URL: "https://example.ngrok.app/",
    TEST_CALL_TOKEN: "secret",
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "twilio-token",
    TWILIO_PHONE_NUMBER: "+15550001111",
    TEST_PHONE_NUMBER: "+359888000000",
    TWILIO_VALIDATE_SIGNATURE: "false",
    AGENT_MAX_TURNS: "3",
    ...overrides,
  });
