"use client";

import * as React from "react";

/**
 * The checkout session this page shows (`view.id`). Every server action takes it, so a tab
 * keeps acting on its own session after another checkout link opens in the same browser.
 */
export const CheckoutSessionContext = React.createContext("");

export const useCheckoutSession = () => React.useContext(CheckoutSessionContext);
