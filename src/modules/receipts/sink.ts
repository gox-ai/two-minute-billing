// Side effect: registers the receipt sink, so every `payment_succeeded` leaves a receipt.
import { registerEventSink } from "@/modules/events/emit";
import { receiptSink } from "./service";

registerEventSink(receiptSink);
