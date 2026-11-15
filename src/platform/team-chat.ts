/**
 * Post one line to our team's chat: a Google Chat, Slack or Discord incoming webhook.
 *
 * The body is `{ text }` and nothing else. Google Chat parses it as a `Message` and rejects any
 * unknown key with a 400; Slack and Discord read `text` too. The URL is the credential: never log it.
 */
export async function postTeamChat(
  url: string,
  text: string,
  timeoutMs = 10_000,
): Promise<{ ok: true } | { ok: false; status: number | null; error: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true };
    return { ok: false, status: res.status, error: `chat answered ${res.status}` };
  } catch (e) {
    return { ok: false, status: null, error: (e as Error)?.message ?? String(e) };
  }
}
