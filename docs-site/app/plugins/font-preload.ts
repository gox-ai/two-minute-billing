// Inter's Latin file, preloaded the way next/font does: otherwise it is found only after the CSS.
// The same asset the @fontsource CSS points at, so the browser fetches it once.
import interLatin from "@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2?url";

export default defineNuxtPlugin(() => {
  useHead({
    link: [
      {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        href: interLatin,
        crossorigin: "anonymous",
      },
    ],
  });
});
