import { ClaudeAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { createApp, twilioPlaceCall } from "./server.js";

const config = loadConfig();
const app = createApp({
  config,
  agent: new ClaudeAgent(config.anthropic),
  placeCall: twilioPlaceCall(config.twilio),
});

app.listen(config.port, () => {
  console.log(`AI Call Agent backend listening on :${config.port}`);
  console.log(`Twilio webhooks expected at ${config.publicBaseUrl}/twilio/*`);
});
