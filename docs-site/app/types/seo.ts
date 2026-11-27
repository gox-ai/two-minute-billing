/** One question and answer for an FAQ block and its FAQPage schema. Plain type: `app/utils` and
 *  `nuxt.config.ts` import it, so it must not live beside Nuxt-only code. */
export interface FaqItem {
  label: string;
  content: string;
}
