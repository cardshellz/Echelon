import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; text: string; html: string }>);
vi.mock("../../../notifications/email.service", () => ({
  sendEmail: async (input: { to: string; subject: string; text: string; html: string }) => { sent.push(input); },
}));

import { SmtpDropshipNotificationEmailSender } from "../../infrastructure/dropship-notification-email.sender";

/** The dropship notification email's body (review DUX1: a publish run lists its sizes one per line). */
describe("SmtpDropshipNotificationEmailSender", () => {
  beforeEach(() => { sent.length = 0; });

  it("keeps a message's lines as lines in the HTML body, escaped, and as they are in the text body", async () => {
    await new SmtpDropshipNotificationEmailSender().send({
      toEmail: "vendor@example.com", eventType: "dropship_listing_push_failed", title: "Some listings didn't publish",
      message: "2 of 3 listings didn't publish to marz_cards.\nToploader <25>: It couldn't be sent.", payload: {},
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain("<p>2 of 3 listings didn't publish to marz_cards.<br>Toploader &lt;25&gt;: It couldn't be sent.</p>");
    expect(sent[0].text).toContain("2 of 3 listings didn't publish to marz_cards.\nToploader <25>: It couldn't be sent.");
  });
});
