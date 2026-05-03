// Send push notifications via Expo's push service
export async function sendPush(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<void> {
  const valid = tokens.filter((t) => t && t.startsWith('ExponentPushToken'));
  if (!valid.length) return;

  const messages = valid.map((to) => ({ to, title, body, data: data ?? {}, sound: 'default' }));

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch {
    // Push failures are non-fatal — don't propagate
  }
}
