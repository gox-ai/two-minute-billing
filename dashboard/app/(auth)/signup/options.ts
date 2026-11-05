import { forwardedFor } from "@/lib/forwarded-for";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

export const VOLUMES = [
  { value: "none", label: "Not billing yet" },
  { value: "under_10k", label: "Less than $10,000 a month" },
  { value: "10k_100k", label: "$10,000 to $100,000 a month" },
  { value: "100k_500k", label: "$100,000 to $500,000 a month" },
  { value: "over_500k", label: "More than $500,000 a month" },
];
export const GATEWAYS = [
  { value: "stripe", label: "Stripe" },
  { value: "razorpay", label: "Razorpay" },
  { value: "paypal", label: "PayPal" },
  { value: "other", label: "Another gateway" },
  { value: "none", label: "No gateway yet" },
];

export async function countryOptions(): Promise<
  { value: string; label: string; keywords: string }[]
> {
  try {
    const res = await fetch(`${BASE}/v1/countries`, {
      headers: await forwardedFor(),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { data?: { code: string; name: string }[] };
    return (j.data ?? []).map((c) => ({ value: c.code, label: c.name, keywords: c.code }));
  } catch {
    return [];
  }
}
