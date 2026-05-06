// Lightweight email sender using Resend's HTTP API. No npm dependency — just
// fetch. Configure on Railway with:
//   RESEND_API_KEY=re_xxxxxxxx
//   EMAIL_FROM="Sacari <noreply@yourdomain.com>"     ← must be a verified sender on Resend
//
// In development (no key set) emails are logged to the console so the flow
// still works locally.

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? 'Sacari <onboarding@resend.dev>';

  if (!apiKey) {
    // Dev fallback so the flow still works locally without a configured key.
    // eslint-disable-next-line no-console
    console.log('[email] (no RESEND_API_KEY set, logging instead)', {
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
    });
    return { ok: true };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: [opts.to],
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      // eslint-disable-next-line no-console
      console.error('[email] Resend error', res.status, errText);
      return { ok: false, error: `email_send_failed_${res.status}` };
    }
    return { ok: true };
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error('[email] fetch error', err?.message ?? err);
    return { ok: false, error: 'email_send_failed' };
  }
}
