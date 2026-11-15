import { describe, expect, it } from "vitest";
import { actionHeadline, actionTitle } from "../../dashboard/components/audit/labels";

// Every action the engine writes to the audit log, as the list shows it.
const TITLES: Array<[string, string]> = [
  ["api_key.create", "API key created"],
  ["api_key.revoke", "API key revoked"],
  ["api_key.rotate", "API key rotated"],
  ["api_key.update", "API key updated"],
  ["business.remove_currency", "Business currency removed"],
  ["business.set_currency_rate_source", "Exchange rate source changed"],
  ["business.settings_update", "Business settings updated"],
  ["coupon.archive", "Coupon archived"],
  ["coupon.create", "Coupon created"],
  ["coupon.restore", "Coupon restored"],
  ["coupon.update", "Coupon updated"],
  ["coupon_set.add_codes", "Coupon codes added"],
  ["coupon_set.archive", "Coupon set archived"],
  ["coupon_set.archive_code", "Coupon code archived"],
  ["coupon_set.create", "Coupon set created"],
  ["coupon_set.delete_unused_codes", "Unused coupon codes deleted"],
  ["coupon_set.rename", "Coupon set renamed"],
  ["coupon_set.update", "Coupon set updated"],
  ["credit.large_grant", "Large credit grant recorded"],
  ["credit_note.create", "Credit note issued"],
  ["credit_note.record_refund", "Credit note offline refund recorded"],
  ["credit_note.refund", "Credit note refunded"],
  ["credit_note.resolve_payout", "Credit note payout resolved"],
  ["credit_note.void", "Credit note voided"],
  ["customer.add_payment_method", "Customer payment method added"],
  ["customer.archive", "Customer archived"],
  ["customer.change_billing_date", "Customer billing date changed"],
  ["customer.clear_personal_data", "Customer personal data erased (GDPR)"],
  ["customer.create", "Customer created"],
  ["customer.payment_method_orphaned_at_gateway", "Payment method left active at the gateway"],
  ["customer.payment_method_role", "Customer payment method role changed"],
  ["customer.remove_payment_method", "Customer payment method removed"],
  ["customer.restore", "Customer restored"],
  ["customer.update", "Customer updated"],
  ["data.export", "Data exported"],
  ["dispute.mark_lost", "Dispute marked as lost"],
  ["dispute.mark_won", "Dispute marked as won"],
  ["dispute.record", "Dispute recorded"],
  ["dunning_policy.archive", "Dunning policy archived"],
  ["dunning_policy.create", "Dunning policy created"],
  ["dunning_policy.update", "Dunning policy updated"],
  ["gateway_account.create", "Gateway account created"],
  ["gateway_account.delete", "Gateway account deleted"],
  ["gateway_account.provision_webhook", "Gateway webhook created"],
  ["gateway_account.rotate_webhook_secret", "Gateway webhook secret rotated"],
  ["gateway_account.set_webhook_secret", "Gateway webhook secret set"],
  ["gateway_account.update", "Gateway account updated"],
  ["integration.hubspot.connect", "HubSpot connected"],
  ["integration.hubspot.disconnect", "HubSpot disconnected"],
  ["invoice.apply_credits", "Invoice credits applied"],
  ["invoice.close", "Invoice closed"],
  ["invoice.collect", "Invoice collection attempted"],
  ["invoice.pause_dunning", "Invoice dunning paused"],
  ["invoice.record_payment", "Invoice offline payment recorded"],
  ["invoice.regenerate", "Invoice regenerated"],
  ["invoice.resume_dunning", "Invoice dunning resumed"],
  ["invoice.stop_dunning", "Invoice dunning stopped"],
  ["invoice.update", "Invoice details changed"],
  ["invoice.void", "Invoice voided"],
  ["invoice.write_off", "Invoice written off as bad debt"],
  ["mail_transport.ses.update", "SES email settings updated"],
  ["mail_transport.smtp.update", "SMTP email settings updated"],
  ["mandatory_addon.skipped", "Mandatory addon skipped"],
  ["model_cost_override.create", "Model cost override created"],
  ["model_cost_override.delete", "Model cost override deleted"],
  ["model_cost_override.end", "Model cost override ended"],
  ["organization.session_policy.update", "Session policy updated"],
  ["organization.two_factor.disable", "Two-factor requirement disabled"],
  ["organization.two_factor.enable", "Two-factor requirement enabled"],
  ["payment.cancel_pending_debit", "Pending debit cancelled"],
  ["price.archive", "Price archived"],
  ["price.create", "Price created"],
  ["price.restore", "Price restored"],
  ["price.update", "Price updated"],
  ["product.archive", "Product archived"],
  ["product.create", "Product created"],
  ["product.restore", "Product restored"],
  ["product.update", "Product updated"],
  ["product_group.archive", "Product group archived"],
  ["product_group.create", "Product group created"],
  ["product_group.restore", "Product group restored"],
  ["product_group.update", "Product group updated"],
  ["role.create", "Role created"],
  ["role.delete", "Role deleted"],
  ["role.update", "Role updated"],
  ["subscription.activate", "Subscription activated"],
  ["subscription.cancel", "Subscription cancelled"],
  ["subscription.change", "Subscription changed"],
  ["subscription.change_term_end", "Subscription term end changed"],
  ["subscription.change_trial_end", "Subscription trial end changed"],
  ["subscription.commitment_change", "Subscription commitment changed"],
  ["subscription.create", "Subscription created"],
  ["subscription.delete", "Subscription deleted"],
  ["subscription.end_trial", "Subscription trial ended"],
  ["subscription.pause", "Subscription paused"],
  ["subscription.reactivate", "Subscription reactivated"],
  ["subscription.remove_scheduled_cancellation", "Subscription scheduled cancellation removed"],
  ["subscription.renew", "Subscription renewed"],
  ["subscription.renewal_skipped", "Subscription renewal skipped"],
  ["subscription.resume", "Subscription resumed"],
  ["subscription.selling_price_change", "Subscription selling price changed"],
  ["subscription.skip_renewal", "Subscription renewal skip scheduled"],
  ["subscription.unskip_renewal", "Subscription renewal skip removed"],
  ["subscription.update", "Subscription updated"],
  ["subscription_cancel_scheduled", "Subscription cancellation scheduled"],
  ["team.accept_invite", "Team invite accepted"],
  ["team.decline_invite", "Team invite declined"],
  ["team.invite", "Teammate invited"],
  ["team.remove", "Teammate removed"],
  ["team.resend_invite", "Team invite sent again"],
  ["team.role_change", "Teammate role changed"],
  ["transfer.apply", "Data transfer applied"],
  ["transfer.cancel", "Data transfer cancelled"],
  ["transfer.live_override", "Data transfer run in live mode"],
  ["transfer.retry", "Data transfer retried"],
  ["transfer.run", "Data transfer run"],
  ["webhook_endpoint.create", "Webhook endpoint created"],
  ["webhook_endpoint.delete", "Webhook endpoint deleted"],
  ["webhook_endpoint.rotate_secret", "Webhook endpoint secret rotated"],
  ["webhook_endpoint.update", "Webhook endpoint updated"],
];

describe("actionTitle", () => {
  it.each(TITLES)("%s → %s", (action, title) => {
    expect(actionTitle(action)).toBe(title);
  });

  it("reads as <Noun> <past participle>, never the bare verb", () => {
    for (const [action] of TITLES) {
      const t = actionTitle(action);
      expect(t).toMatch(/^[A-Z]/);
      expect(t).not.toMatch(/ (create|update|archive|restore|delete|change|remove)$/);
      expect(t).not.toMatch(/\bApi\b|\b(?:ses|smtp)\b/);
    }
  });

  it("conjugates an action it does not know", () => {
    expect(actionTitle("tax_rate.create")).toBe("Tax rate created");
    expect(actionTitle("api_key.archive")).toBe("API key archived");
    expect(actionTitle("widget")).toBe("Widget");
  });
});

describe("actionHeadline", () => {
  it("takes the verb from the title when the noun matches", () => {
    expect(actionHeadline("coupon_set.rename", "coupon_set")).toEqual({
      noun: "Coupon set",
      verb: "renamed.",
    });
    expect(actionHeadline("api_key.rotate", "api_key")).toEqual({
      noun: "API key",
      verb: "rotated.",
    });
    expect(actionHeadline("invoice.void", "invoice")).toEqual({ noun: "Invoice", verb: "voided." });
  });
});
