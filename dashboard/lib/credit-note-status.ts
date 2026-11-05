// The status a credit note's chip shows. Pure, so the unit tests can import it.

/** A `refunded` note applied to invoices with no cash back reads "Applied to invoices". */
export function creditNoteChipStatus(note: {
  status: string;
  settled_by?: "refund" | "allocation" | "mixed" | null;
}): string {
  return note.status === "refunded" && note.settled_by === "allocation"
    ? "applied_to_invoices"
    : note.status;
}
