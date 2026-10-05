import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  ANTHROPIC_API_KEY: "k",
  TEST_CALL_TOKEN: "t",
  TWILIO_ACCOUNT_SID: "AC",
  TWILIO_AUTH_TOKEN: "a",
  TWILIO_PHONE_NUMBER: "+1",
  TEST_PHONE_NUMBER: "+359",
};

describe("loadConfig", () => {
  it("falls back to Render's external URL", () => {
    expect(loadConfig({ ...base, RENDER_EXTERNAL_URL: "https://x.onrender.com" }).publicBaseUrl).toBe(
      "https://x.onrender.com",
    );
  });

  it("requires a public URL", () => {
    expect(() => loadConfig(base)).toThrow(/PUBLIC_BASE_URL/);
  });
});
