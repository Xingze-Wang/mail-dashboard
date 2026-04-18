import { Resend } from "resend";

// When RESEND_STUB=1, send() logs the payload and returns a fake id instead
// of hitting the Resend API. All other methods (emails.get, emails.list,
// webhooks, etc.) pass through to the real client unchanged.
const STUB = process.env.RESEND_STUB === "1";

const realClient = new Resend(process.env.RESEND_API_KEY);

type SendFn = typeof realClient.emails.send;

async function stubSend(...args: Parameters<SendFn>): ReturnType<SendFn> {
  const [payload] = args;
  const id = `stub_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  console.log("[RESEND_STUB] send", {
    id,
    to: (payload as { to?: string | string[] }).to,
    from: (payload as { from?: string }).from,
    subject: (payload as { subject?: string }).subject,
    bytes: (payload as { html?: string }).html?.length ?? 0,
  });
  return { data: { id }, error: null } as Awaited<ReturnType<SendFn>>;
}

// Build the exported client: same shape as the real Resend client, with send()
// swapped out when STUB is on. Everything else (emails.get/list, webhooks, …)
// comes straight from the real client.
export const resend = new Proxy(realClient, {
  get(target, prop, receiver) {
    if (STUB && prop === "emails") {
      return new Proxy(target.emails, {
        get(emailsTarget, emailsProp, emailsReceiver) {
          if (emailsProp === "send") return stubSend;
          return Reflect.get(emailsTarget, emailsProp, emailsReceiver);
        },
      });
    }
    return Reflect.get(target, prop, receiver);
  },
}) as Resend;
