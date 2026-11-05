import type { GatewayFixture } from "./types";
import { adyenFixture } from "./fixtures/adyen";
import { authorizenetFixture } from "./fixtures/authorizenet";
import { braintreeFixture } from "./fixtures/braintree";
import { cashfreeFixture } from "./fixtures/cashfree";
import { checkoutcomFixture } from "./fixtures/checkoutcom";
import { gocardlessFixture } from "./fixtures/gocardless";
import { mollieFixture } from "./fixtures/mollie";
import { paypalFixture } from "./fixtures/paypal";
import { payuFixture } from "./fixtures/payu";
import { razorpayFixture } from "./fixtures/razorpay";
import { squareFixture } from "./fixtures/square";
import { stripeFixture } from "./fixtures/stripe";

/** Every gateway fixture module. A new adapter adds its module here (see README.md). */
export const FIXTURES: GatewayFixture[] = [
  stripeFixture,
  gocardlessFixture,
  squareFixture,
  paypalFixture,
  razorpayFixture,
  cashfreeFixture,
  adyenFixture,
  checkoutcomFixture,
  mollieFixture,
  braintreeFixture,
  authorizenetFixture,
  payuFixture,
];
