"use client";

import * as React from "react";

/**
 * True inside a modal Dialog or Sheet. A modal locks scrolling outside its own content, and
 * a portalled popover is outside it, so a non-modal popover's list does not scroll under the
 * wheel or a touch drag. `Popover` reads this and turns modal itself, which gives its content
 * its own scroll lock.
 */
export const InModalContext = React.createContext(false);
export const useInModal = () => React.useContext(InModalContext);
