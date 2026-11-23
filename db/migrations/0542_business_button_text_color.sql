-- Brand Styles: an optional label colour for the merchant's filled buttons. NULL = automatic
-- (white, near-black or black, whichever reaches 4.5:1 on the brand colour). The hosted pages
-- use a set value only when it reaches 4.5:1 on the brand colour; see dashboard/lib/brand.ts.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS button_text_color text;

ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_button_text_color_hex;
ALTER TABLE businesses ADD CONSTRAINT businesses_button_text_color_hex
  CHECK (button_text_color IS NULL OR button_text_color ~ '^#[0-9A-Fa-f]{6}$');
