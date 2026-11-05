import dates from "#tm-content-dates";

/** Hands the git dates (nuxt.config contentDates) to the Vue app's server render. */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("request", (event) => {
    event.context.tmContentDates = dates;
  });
});
