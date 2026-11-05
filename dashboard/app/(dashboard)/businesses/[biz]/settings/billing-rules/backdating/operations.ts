// Shared by the server page and the client fields, so it lives outside both.
export type BackdateAction = "create" | "change" | "cancel" | "reactivate";

// The label says the operation; the hint says what unchecking it starts rejecting.
export const ACTIONS: Array<{ value: BackdateAction; label: string; hint: string }> = [
  {
    value: "create",
    label: "Create subscription",
    hint: "Rejects a signup whose start date is before today.",
  },
  {
    value: "change",
    label: "Change subscription",
    hint: "Rejects a plan, quantity or add-on change prorated as of a past date.",
  },
  {
    value: "cancel",
    label: "Cancel subscription",
    hint: "Rejects a cancellation with a date in the past.",
  },
  {
    value: "reactivate",
    label: "Reactivate subscription",
    hint: "Rejects a reactivation link whose new term starts before today.",
  },
];
