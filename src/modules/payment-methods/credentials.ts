/** Whether a fresh read changes the card's number or expiry (unreported fields don't count). */
export function credentialsChanged(
  existing: { last4: string | null; expMonth: number | null; expYear: number | null },
  next: { last4?: string | null; expMonth?: number | null; expYear?: number | null },
): boolean {
  return (
    (next.last4 != null && next.last4 !== existing.last4) ||
    (next.expMonth != null && next.expMonth !== existing.expMonth) ||
    (next.expYear != null && next.expYear !== existing.expYear)
  );
}
