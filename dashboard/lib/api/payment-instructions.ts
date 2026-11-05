import { apiGet, apiPost, apiPatch, apiDelete } from "@/lib/api";

/**
 * Payment instructions — how an offline payer is told where to send the money.
 * Engine: `/v1/businesses/:biz/payment_instructions` (0241).
 */
export interface PaymentInstruction {
  object: "payment_instruction";
  id: string;
  kind: "bank_transfer" | "paypal";
  section_title: string;
  section_id: string | null;
  description: string | null;
  /** Ordered label/value pairs, e.g. Account name / IFSC / SWIFT. */
  fields: Array<{ label: string; value: string }>;
  /** Empty = shown on every invoice. Non-empty narrows to these ISO currency codes. */
  currencies: string[];
  /** Empty = every country. Non-empty narrows to these alpha-2 billing countries. */
  countries: string[];
  position: number;
  archived: boolean;
  resource_version?: number;
}

export const PAYMENT_INSTRUCTION_KIND_LABELS: Record<PaymentInstruction["kind"], string> = {
  bank_transfer: "Bank transfer",
  paypal: "PayPal",
};

export async function listPaymentInstructions(biz: string): Promise<PaymentInstruction[]> {
  const { data } = await apiGet<{ data: PaymentInstruction[] }>(
    `/v1/businesses/${biz}/payment_instructions`,
  );
  return data ?? [];
}

export const createPaymentInstruction = (
  biz: string,
  body: {
    kind: PaymentInstruction["kind"];
    section_title: string;
    section_id?: string | null;
    description?: string | null;
    fields?: Array<{ label: string; value: string }>;
    currencies?: string[];
    countries?: string[];
    position?: number;
  },
) => apiPost(`/v1/businesses/${biz}/payment_instructions`, body);

export const updatePaymentInstruction = (
  biz: string,
  id: string,
  body: {
    section_title?: string;
    section_id?: string | null;
    description?: string | null;
    fields?: Array<{ label: string; value: string }>;
    currencies?: string[];
    countries?: string[];
    position?: number;
    archived?: boolean;
    expected_version?: number;
  },
) => apiPatch(`/v1/businesses/${biz}/payment_instructions/${id}`, body);

/**
 * Archive, not delete — the engine keeps the row so an invoice that already printed this
 * instruction can still be explained.
 */
export const archivePaymentInstruction = (biz: string, id: string) =>
  apiDelete(`/v1/businesses/${biz}/payment_instructions/${id}`);
