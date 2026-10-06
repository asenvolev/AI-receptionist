/** Minimal phone-friendly page for triggering a test call from a browser. */
export function testCallPage(defaultTask: string): string {
  const escapedTask = defaultTask
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="bg">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Call Agent</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 16px; }
  label { display: block; margin: 16px 0 6px; font-weight: 600; }
  input, textarea, button { width: 100%; box-sizing: border-box; font-size: 16px; padding: 12px; border-radius: 10px; border: 1px solid #8888; }
  textarea { min-height: 120px; }
  button { margin-top: 20px; background: #2563eb; color: #fff; border: 0; font-weight: 600; }
  button:disabled { opacity: .6; }
  #status { margin-top: 16px; white-space: pre-wrap; }
  #logs { margin-top: 8px; min-height: 320px; font: 12px/1.4 ui-monospace, monospace; white-space: pre; }
</style>
</head>
<body>
<h1>📞 AI Call Agent</h1>
<p>Агентът ще звъни на тестовия номер от настройките. Ти играеш регистратурата.</p>
<form id="form">
  <label for="token">Token (TEST_CALL_TOKEN)</label>
  <input id="token" type="password" autocomplete="current-password" required>
  <label for="task">Задача</label>
  <textarea id="task">${escapedTask}</textarea>
  <button id="go" type="submit">Звънни ми</button>
</form>
<div id="status"></div>
<label for="logs">Логове: грешки от Twilio + сървър (обновяват се сами)</label>
<textarea id="logs" readonly placeholder="Въведи token, за да виждаш логовете."></textarea>
<script>
  const token = document.getElementById("token");
  try { token.value = localStorage.getItem("testCallToken") || ""; } catch {}
  const logs = document.getElementById("logs");
  async function refreshLogs() {
    if (!token.value) return;
    try {
      const res = await fetch("/logs", { headers: { Authorization: "Bearer " + token.value } });
      if (res.status === 401) { logs.value = "Грешен token."; return; }
      const body = await res.json();
      const atBottom = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 20;
      const alerts = body.twilioAlerts && body.twilioAlerts.length
        ? "=== Последни грешки от Twilio ===\\n" + body.twilioAlerts.join("\\n") + "\\n\\n"
        : "";
      logs.value = alerts + "=== Сървър ===\\n" + body.lines.join("\\n");
      if (atBottom) logs.scrollTop = logs.scrollHeight;
    } catch {}
  }
  refreshLogs();
  setInterval(refreshLogs, 3000);
  document.getElementById("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.getElementById("go");
    const status = document.getElementById("status");
    button.disabled = true;
    status.textContent = "Звъня...";
    try {
      try { localStorage.setItem("testCallToken", token.value); } catch {}
      const res = await fetch("/test-call", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token.value },
        body: JSON.stringify({ task: document.getElementById("task").value }),
      });
      const body = await res.json().catch(() => ({}));
      status.textContent = res.ok
        ? "✅ Обаждането тръгна. Вдигни телефона.\\nCallSid: " + body.callSid
        : "❌ Грешка " + res.status + ": " + (body.error || "неуспешно") +
          (body.twilioMessage ? "\\nTwilio" + (body.twilioCode ? " " + body.twilioCode : "") + ": " + body.twilioMessage : "") +
          (body.twilioCode ? "\\nhttps://www.twilio.com/docs/errors/" + body.twilioCode : "");
    } catch (error) {
      status.textContent = "❌ Няма връзка със сървъра.";
    } finally {
      button.disabled = false;
    }
  });
</script>
</body>
</html>`;
}
