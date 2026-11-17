import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; text: string; html: string }>);
vi.mock("../../../notifications/email-delivery.api", () => ({
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

  it("never shows the internal event type, in the text body or the HTML body", async () => {
    await new SmtpDropshipNotificationEmailSender().send({
      toEmail: "vendor@example.com", eventType: "dropship_ebay_listing_action_needed", title: "A title", message: "A message.", payload: {},
    });
    expect(sent[0].text).toBe("A title\n\nA message.");
    expect(sent[0].html).toBe("<h1>A title</h1><p>A message.</p>");
    for (const body of [sent[0].text, sent[0].html]) {
      expect(body).not.toContain("Event");
      expect(body).not.toContain("dropship_ebay_listing_action_needed");
    }
  });

  it("makes a message's URLs real links in HTML and keeps them plain in the text body", async () => {
    const message = "- Toploader (SKU TL-1), eBay item 123456789012: https://www.ebay.com/itm/123456789012\n"
      + "2. Or choose one in Listing settings: https://cardshellz.io/catalog/setup?a=1&b=2.";
    await new SmtpDropshipNotificationEmailSender().send({ toEmail: "vendor@example.com", eventType: "x", title: "T", message, payload: {} });
    expect(sent[0].text).toContain("eBay item 123456789012: https://www.ebay.com/itm/123456789012\n");
    expect(sent[0].text).toContain("Listing settings: https://cardshellz.io/catalog/setup?a=1&b=2.");
    expect(sent[0].html).toContain('<a href="https://www.ebay.com/itm/123456789012">https://www.ebay.com/itm/123456789012</a><br>');
    // Escaped once, and the sentence's full stop stays outside the link.
    expect(sent[0].html).toContain('<a href="https://cardshellz.io/catalog/setup?a=1&amp;b=2">https://cardshellz.io/catalog/setup?a=1&amp;b=2</a>.</p>');
  });

  it("never turns markup in a message into a link or a tag", async () => {
    await new SmtpDropshipNotificationEmailSender().send({ toEmail: "v@example.com", eventType: "x", title: "T",
      message: 'See https://evil.example/"><script>x</script> now', payload: {} });
    expect(sent[0].html).not.toContain("<script>");
    expect(sent[0].html).toContain('<a href="https://evil.example/">https://evil.example/</a>&quot;&gt;&lt;script&gt;');
  });
});
