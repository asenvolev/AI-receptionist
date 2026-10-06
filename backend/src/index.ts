import { ClaudeAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { captureConsole } from "./logs.js";
import { createAppServer, RELAY_PATH, twilioPlaceCall } from "./server.js";

captureConsole();
const config = loadConfig();
const server = createAppServer({
  config,
  agent: new ClaudeAgent(config.anthropic),
  placeCall: twilioPlaceCall(config.twilio),
});

server.listen(config.port, () => {
  console.log(`AI Call Agent backend listening on :${config.port}`);
  console.log(`Twilio webhooks expected at ${config.publicBaseUrl}/twilio/*`);
  console.log(`ConversationRelay WebSocket at ${config.publicBaseUrl.replace(/^http/, "ws")}${RELAY_PATH}`);
});
