import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LIMITS } from "./limits";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  TAX_REGIMES,
  TaxError,
  allowedTreatments,
  createTaxProfile,
  createTaxRegion,
  deleteTaxStateRegistration,
  getTaxRegion,
  listTaxProfiles,
  listTaxRegions,
  setTaxRateComponents,
  setTaxRegionEnabled,
  updateTaxRegion,
  upsertTaxStateRegistration,
  type TaxRegionDetail,
} from "@/modules/tax/service";
import type { taxProfiles, taxRateComponents, taxStateRegistrations } from "@db/schema";
import { resolveBusiness, badRequest, notFound, requirePerm } from "./helpers";
import { parseRequest } from "./strict-params";

function serializeProfile(r: typeof taxProfiles.$inferSelect) {
  return {
    object: "tax_profile",
    id: r.publicId,
    name: r.name,
    is_default: r.isDefault,
    active: r.active,
    created_at: r.createdAt,
  };
}

function serializeComponent(c: typeof taxRateComponents.$inferSelect) {
  return {
    object: "tax_rate_component",
    id: c.publicId,
    state_code: c.stateCode,
    name: c.name,
    rate_bps: c.rateBps,
    applies_to: c.appliesTo,
    sort_order: c.sortOrder,
  };
}

function serializeStateRegistration(s: typeof taxStateRegistrations.$inferSelect) {
  return {
    object: "tax_state_registration",
    id: s.publicId,
    state_code: s.stateCode,
    state_name: s.stateName,
    registration_number: s.registrationNumber,
  };
}

function serializeRegion(d: TaxRegionDetail) {
  const { region: r } = d;
  return {
    object: "tax_region",
    id: r.publicId,
    tax_profile_id: d.profile.publicId,
    country: r.country,
    regime: r.regime,
    price_type: r.priceType,
    home_state_code: r.homeStateCode,
    registration_label: r.registrationLabel,
    registration_number: r.registrationNumber,
    collect_registration_number: r.collectRegistrationNumber,
    reverse_charge_enabled: r.reverseChargeEnabled,
    show_reverse_charge_note: r.showReverseChargeNote,
    reverse_charge_note: r.reverseChargeNote,
    sez_igst_enabled: r.sezIgstEnabled,
    sez_igst_note: r.sezIgstNote,
    sez_zero_rated_enabled: r.sezZeroRatedEnabled,
    sez_zero_rated_note: r.sezZeroRatedNote,
    export_igst_enabled: r.exportIgstEnabled,
    export_igst_note: r.exportIgstNote,
    export_zero_rated_enabled: r.exportZeroRatedEnabled,
    export_zero_rated_note: r.exportZeroRatedNote,
    enabled: r.enabled,
    /**
     * The treatments a customer in this region may be assigned, derived from the gates
     * above. The customer form must offer exactly these — anything else would be a
     * control the engine cannot honour.
     */
    allowed_tax_treatments: allowedTreatments(r),
    components: d.components.map(serializeComponent),
    state_registrations: d.stateRegistrations.map(serializeStateRegistration),
    created_at: r.createdAt,
  };
}

/** Rates are basis points everywhere in this API — 900 = 9%. Max 10000 = 100%. */
const rateBps = z.number().int().min(0).max(10_000);

const createProfileBody = z.object({
  name: z.string().min(1).max(100),
  is_default: z.boolean().optional(),
});

const createRegionBody = z.object({
  country: z.string().length(2),
  regime: z.enum(TAX_REGIMES).optional(),
  price_type: z.enum(["exclusive", "inclusive"]).optional(),
  tax_profile_id: z.string().max(LIMITS.id).optional(),
  home_state_code: z.string().min(1).max(6).optional(),
  registration_label: z.string().max(30).optional(),
  registration_number: z.string().max(50).optional(),
});

const updateRegionBody = z.object({
  regime: z.enum(TAX_REGIMES).optional(),
  price_type: z.enum(["exclusive", "inclusive"]).optional(),
  home_state_code: z.string().min(1).max(6).nullable().optional(),
  registration_label: z.string().max(30).nullable().optional(),
  registration_number: z.string().max(50).nullable().optional(),
  collect_registration_number: z.boolean().optional(),
  reverse_charge_enabled: z.boolean().optional(),
  show_reverse_charge_note: z.boolean().optional(),
  // Reverse-charge text caps at 250 chars, treatment notes at 100.
  reverse_charge_note: z.string().max(250).nullable().optional(),
  sez_igst_enabled: z.boolean().optional(),
  sez_igst_note: z.string().max(100).nullable().optional(),
  sez_zero_rated_enabled: z.boolean().optional(),
  sez_zero_rated_note: z.string().max(100).nullable().optional(),
  export_igst_enabled: z.boolean().optional(),
  export_igst_note: z.string().max(100).nullable().optional(),
  export_zero_rated_enabled: z.boolean().optional(),
  export_zero_rated_note: z.string().max(100).nullable().optional(),
  enabled: z.boolean().optional(),
});

const setComponentsBody = z.object({
  /** null / omitted = the region's default vector; a code = that state's override. */
  state_code: z.string().min(1).max(6).nullable().optional(),
  components: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        rate_bps: rateBps,
        applies_to: z.enum(["intra", "inter", "both"]).optional(),
      }),
    )
    .max(10),
});

const stateRegistrationBody = z.object({
  state_code: z.string().min(1).max(6),
  state_name: z.string().max(80).optional(),
  registration_number: z.string().max(50).nullable().optional(),
});

/** Domain validation errors are the caller's fault → 400, not a 500. */
async function guard<T>(
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TaxError) {
      reply.code(400).send({ error: { type: "invalid_request", message: e.message } });
      return undefined;
    }
    throw e;
  }
}

export async function registerTaxRoutes(app: FastifyInstance) {
  /* ───────────────────────────── tax profiles ───────────────────────────── */

  app.get(
    "/v1/businesses/:biz/tax_profiles",
    { preHandler: [authenticate, requirePerm("taxes:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const rows = await listTaxProfiles(req.organization!.id, business.id);
      return { object: "list", data: rows.map(serializeProfile) };
    },
  );

  app.post(
    "/v1/businesses/:biz/tax_profiles",
    {
      preHandler: [authenticate, requirePerm("taxes:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createProfileBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const row = await guard(reply, () =>
        createTaxProfile({
          organizationId: req.organization!.id,
          businessId: business.id,
          name: parsed.data.name,
          isDefault: parsed.data.is_default,
        }),
      );
      if (!row) return;
      return reply.code(201).send(serializeProfile(row));
    },
  );

  /* ───────────────────────────── tax regions ────────────────────────────── */

  app.get(
    "/v1/businesses/:biz/tax_regions",
    { preHandler: [authenticate, requirePerm("taxes:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const rows = await listTaxRegions(req.organization!.id, business.id);
      return { object: "list", data: rows.map(serializeRegion) };
    },
  );

  app.get(
    "/v1/businesses/:biz/tax_regions/:txg",
    { preHandler: [authenticate, requirePerm("taxes:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { txg } = req.params as { txg: string };
      const detail = await getTaxRegion(req.organization!.id, business.id, txg);
      if (!detail) return notFound(reply, `No such tax region: ${txg}`);
      return serializeRegion(detail);
    },
  );

  app.post(
    "/v1/businesses/:biz/tax_regions",
    {
      preHandler: [authenticate, requirePerm("taxes:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createRegionBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const d = parsed.data;
      const region = await guard(reply, () =>
        createTaxRegion({
          organizationId: req.organization!.id,
          businessId: business.id,
          country: d.country,
          regime: d.regime,
          priceType: d.price_type,
          homeStateCode: d.home_state_code,
          registrationLabel: d.registration_label,
          registrationNumber: d.registration_number,
        }),
      );
      if (!region) return;
      const detail = await getTaxRegion(req.organization!.id, business.id, region.publicId);
      return reply.code(201).send(serializeRegion(detail!));
    },
  );

  app.patch(
    "/v1/businesses/:biz/tax_regions/:txg",
    {
      preHandler: [authenticate, requirePerm("taxes:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(updateRegionBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { txg } = req.params as { txg: string };
      const d = parsed.data;
      // Only keys actually present are written, so a PATCH never silently resets a
      // switch the caller did not mention.
      const patch: Record<string, unknown> = {};
      const map: Record<string, string> = {
        regime: "regime",
        price_type: "priceType",
        home_state_code: "homeStateCode",
        registration_label: "registrationLabel",
        registration_number: "registrationNumber",
        collect_registration_number: "collectRegistrationNumber",
        reverse_charge_enabled: "reverseChargeEnabled",
        show_reverse_charge_note: "showReverseChargeNote",
        reverse_charge_note: "reverseChargeNote",
        sez_igst_enabled: "sezIgstEnabled",
        sez_igst_note: "sezIgstNote",
        sez_zero_rated_enabled: "sezZeroRatedEnabled",
        sez_zero_rated_note: "sezZeroRatedNote",
        export_igst_enabled: "exportIgstEnabled",
        export_igst_note: "exportIgstNote",
        export_zero_rated_enabled: "exportZeroRatedEnabled",
        export_zero_rated_note: "exportZeroRatedNote",
        enabled: "enabled",
      };
      for (const [snake, camel] of Object.entries(map)) {
        if (snake in d) patch[camel] = (d as Record<string, unknown>)[snake];
      }
      const region = await guard(reply, () =>
        updateTaxRegion({
          organizationId: req.organization!.id,
          businessId: business.id,
          regionPublicId: txg,
          patch: patch as never,
        }),
      );
      if (region === undefined) return;
      if (!region) return notFound(reply, `No such tax region: ${txg}`);
      const detail = await getTaxRegion(req.organization!.id, business.id, txg);
      return serializeRegion(detail!);
    },
  );

  // Archive a region (soft — enabled=false; no longer applied to new invoices).
  app.delete(
    "/v1/businesses/:biz/tax_regions/:txg",
    {
      preHandler: [authenticate, requirePerm("taxes:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { txg } = req.params as { txg: string };
      const region = await setTaxRegionEnabled(req.organization!.id, business.id, txg, false);
      if (!region) return notFound(reply, `No such tax region: ${txg}`);
      const detail = await getTaxRegion(req.organization!.id, business.id, txg);
      return serializeRegion(detail!);
    },
  );

  /* ──────────────────────── components (the vector) ─────────────────────── */

  /**
   * Replace one state scope's component vector WHOLESALE. A PUT, not a POST-per-row:
   * CGST and SGST/UTGST are two halves of one decision, and a partial write would leave
   * the region taxing at a rate nobody chose.
   */
  app.put(
    "/v1/businesses/:biz/tax_regions/:txg/components",
    {
      preHandler: [authenticate, requirePerm("taxes:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(setComponentsBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { txg } = req.params as { txg: string };
      const rows = await guard(reply, () =>
        setTaxRateComponents({
          organizationId: req.organization!.id,
          businessId: business.id,
          regionPublicId: txg,
          stateCode: parsed.data.state_code ?? null,
          components: parsed.data.components.map((c) => ({
            name: c.name,
            rateBps: c.rate_bps,
            appliesTo: c.applies_to,
          })),
        }),
      );
      if (!rows) return;
      return { object: "list", data: rows.map(serializeComponent) };
    },
  );

  /* ────────────────────── per-state seller registrations ────────────────── */

  app.put(
    "/v1/businesses/:biz/tax_regions/:txg/state_registrations",
    {
      preHandler: [authenticate, requirePerm("taxes:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(stateRegistrationBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { txg } = req.params as { txg: string };
      const row = await guard(reply, () =>
        upsertTaxStateRegistration({
          organizationId: req.organization!.id,
          businessId: business.id,
          regionPublicId: txg,
          stateCode: parsed.data.state_code,
          stateName: parsed.data.state_name,
          registrationNumber: parsed.data.registration_number,
        }),
      );
      if (!row) return;
      return serializeStateRegistration(row);
    },
  );

  app.delete(
    "/v1/businesses/:biz/tax_regions/:txg/state_registrations/:txs",
    {
      preHandler: [authenticate, requirePerm("taxes:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { txg, txs } = req.params as { txg: string; txs: string };
      const ok = await deleteTaxStateRegistration(req.organization!.id, business.id, txg, txs);
      if (!ok) return notFound(reply, `No such tax state registration: ${txs}`);
      return { object: "tax_state_registration", id: txs, deleted: true };
    },
  );
}
