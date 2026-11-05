import { describe, expect, it } from "vitest";
import { renderMembershipInviteEmail } from "@/modules/emails/templates";

describe("invite email for an existing account", () => {
  const mail = renderMembershipInviteEmail({
    name: "Sam",
    organizationName: "Kestrel Ledger <b>",
    link: "https://dash.example.com/invitations",
  });

  it("links to the signed-in invites page, never to a password link", () => {
    expect(mail.text).toContain("https://dash.example.com/invitations");
    expect(mail.text).not.toContain("invt_");
    expect(mail.html).not.toMatch(/password/i);
  });

  it("says nothing changes until the person accepts", () => {
    expect(mail.subject).toBe("You are invited to join Kestrel Ledger <b> on tmbilling");
    expect(mail.text).toContain("Nothing changes until you accept.");
  });

  it("escapes the organization name in the HTML", () => {
    expect(mail.html).toContain("Kestrel Ledger &lt;b&gt;");
    expect(mail.html).not.toContain("Kestrel Ledger <b>");
  });
});
