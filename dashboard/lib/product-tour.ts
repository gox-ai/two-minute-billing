/** Starts the product tour from anywhere; `ProductTour` listens for it. */
export const START_TOUR_EVENT = "tmb:tour:start";
export const startProductTour = () => window.dispatchEvent(new CustomEvent(START_TOUR_EVENT));
