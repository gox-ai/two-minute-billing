import { describe, expect, it } from "vitest";
import { MASK, redactString, redactValue } from "@/modules/request-log/redact";

const tail = "abcdefghijklmnopqrstuvwxyz012345";

describe("request-log redaction: every token prefix we mint", () => {
  const prefixes = [
    "sk_live_",
    "whsec_",
    "pstk_",
    "psst_",
    "cstk_",
    "sess_",
    "invt_",
    "prst_",
    "mfas_",
    "mfac_",
    "mfrc_",
    "sgni_",
    "sgnp_",
    "tb_",
    "uwt_",
    "ndc_",
    "tmo_at_",
    "tmo_rt_",
    "tmo_cd_",
  ];

  it.each(prefixes)("masks %s inside a string under a harmless key", (prefix) => {
    const out = redactValue({ link: `https://app.example.com/x?t=${prefix}${tail}` }) as {
      link: string;
    };
    expect(out.link).toBe(`https://app.example.com/x?t=${prefix}${MASK}`);
  });

  it("leaves ids and short values alone", () => {
    expect(redactString("cus_XXXXXXXXXXXXXXXXXXXX01")).toBe("cus_XXXXXXXXXXXXXXXXXXXX01");
    expect(redactString("tb_short")).toBe("tb_short");
  });
});
