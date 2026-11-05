import type { PushHandler } from "./context";
import { pushCustomer } from "./customers";
import { pushSubscription } from "./deals";
import { pushInvoice } from "./invoices";
import { pushPrice } from "./products";

/** Queue `resource_type` → the handler that pushes it. */
export const HANDLERS: Record<string, PushHandler> = {
  customer: pushCustomer,
  subscription: pushSubscription,
  price: pushPrice,
  invoice: pushInvoice,
};
