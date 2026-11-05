import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { authenticate } from "@/platform/auth";
import { csvRow } from "@/platform/csv";
import { listBusinesses } from "@/modules/tenancy/service";
import { computeBusinessMetrics } from "@/modules/metrics/service";
import {
  buildBuckets,
  cachedBusinessAnalytics,
  ANALYTICS_RANGES,
  type AnalyticsRange,
} from "@/modules/metrics/analytics";
import {
  computePaymentsAnalytics,
  CALENDAR_RANGES,
  isCalendarRange,
  type CalendarRange,
} from "@/modules/metrics/payments-analytics";
import {
  REPORTS,
  CATEGORY_LABELS,
  TAG_LABELS,
  GRANULARITIES,
  acceptsGranularity,
  acceptsAgingInterval,
} from "@/modules/metrics/reports/registry";
import { AR_AGING_INTERVALS } from "@/modules/invoicing/ar-aging";
import { resolveReport, ReportError } from "@/modules/metrics/reports/resolve";
import {
  RAW_DATASETS,
  RawExportError,
  isRawDataset,
  readRawPage,
  streamRawCsv,
  MAX_PAGE,
} from "@/modules/metrics/export/datasets";
import { computeCancellationAnalytics } from "@/modules/metrics/cancellations";
import { resolveBusiness, badRequest, requirePerm } from "./helpers";
import { writeAuditLog } from "@/modules/audit/service";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// SaaS metrics (MRR/ARR/ARPU/churn) — read-only, RLS-scoped.
export async function registerMetricsRoutes(app: FastifyInstance) {
  // Business Home analytics: KPIs + bucketed time-series + plan mix.
  app.get(
    "/v1/businesses/:biz/analytics",
    { preHandler: [authenticate, requirePerm("reports:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as Record<string, string | undefined>;
      if (q.range != null && !ANALYTICS_RANGES.includes(q.range as AnalyticsRange)) {
        return badRequest(reply, `range must be one of: ${ANALYTICS_RANGES.join(", ")}`);
      }
      const analytics = await cachedBusinessAnalytics(req.organization!.id, business.id, {
        range: q.range as AnalyticsRange | undefined,
        currency: q.currency,
      });
      return { object: "business_analytics", business: business.publicId, ...analytics };
    },
  );

  /**
   * The report catalogue (Phase 3a) — what can be asked, before asking it.
   *
   * Declarations, not results: the UI renders the explorer from this rather than keeping its
   * own list, which is how a catalogue and its reports drift apart.
   */
  app.get(
    "/v1/businesses/:biz/reports",
    { preHandler: [authenticate, requirePerm("reports:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      return {
        object: "list",
        data: REPORTS.map((r) => ({
          key: r.key,
          name: r.name,
          description: r.description,
          category: r.category,
          category_label: CATEGORY_LABELS[r.category],
          kind: r.kind,
          shape: r.shape,
          dimensions: r.dimensions,
          /**
           * The granularities this report's series may be re-cut at — empty where it has no
           * series, so a catalogue reader knows before asking which reports take the
           * parameter and which would refuse it.
           */
          granularities: acceptsGranularity(r) ? GRANULARITIES : [],
          /**
           * The rung widths this report's ageing ladder may be rebuilt at — empty on every
           * report that is not an ageing ladder, for the same reason as `granularities`.
           */
          aging_intervals: acceptsAgingInterval(r) ? AR_AGING_INTERVALS : [],
          /**
           * Cross-cutting tags, with their labels, so the client renders filter chips without
           * keeping its own copy of the vocabulary — a copy is how a catalogue ends up
           * offering a filter the engine has dropped.
           */
          tags: (r.tags ?? []).map((t) => ({ id: t, label: TAG_LABELS[t] })),
          variants: r.variants ?? [],
        })),
      };
    },
  );

  /**
   * One report. Uniform shape for every key, because the point of the registry is that the
   * client renders a report it has never heard of.
   */
  app.get(
    "/v1/businesses/:biz/reports/:key",
    { preHandler: [authenticate, requirePerm("reports:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { key } = req.params as { key: string };
      const q = req.query as Record<string, string | undefined>;
      try {
        const report = await resolveReport(req.organization!.id, business.id, key, {
          range: q.range,
          currency: q.currency,
          /**
           * How finely to cut the series, INDEPENDENTLY of how far back the range reaches.
           * Every preset keeps its own default, so an untouched URL answers as before; a
           * report with no series to re-cut refuses the parameter rather than ignoring it.
           */
          granularity: q.granularity,
          /**
           * How wide the ageing ladder's rungs are. The rung NAMES carry their own
           * boundaries, so a row printed at any interval drills into the invoices behind it
           * through the same `ar_bucket` filter. Refused on a report with no ageing ladder.
           */
          agingInterval: q.aging_interval,
          groupBy: q.group_by,
          /**
           * Narrow the CUSTOMERS a figure is computed from — `country:DE`, `country:DE,IN`,
           * `country:unknown`. A predicate over a stored dimension, never a stored segment:
           * anything the dimensions cannot express is refused by name rather than answered by
           * rebuilding the book per slice on every read.
           */
          customerFilter: q.customer_filter,
        });
        /**
         * `format=csv` returns the SAME answer as a file — one resolver, two renderings, so a
         * downloaded report and the screen it came from cannot disagree.
         *
         * Rows when the report has them, points otherwise: those are the two shapes a report
         * takes, and a CSV of a single headline figure would be a file with one number in it.
         */
        if ((q.format ?? "").toLowerCase() === "csv") {
          const rows = report.table
            ? [
                // A waterfall exports as itself: the period, then every column in the order
                // the table shows them, so the exported row reconciles like the on-screen one.
                ["period", ...report.table.columns.map((c) => c.label)],
                ...report.table.rows.map((r) => [r.period, ...r.values.map(String)]),
              ]
            : report.matrix
              ? [
                  // A cohort exports as its grid: intake month, opening size, then one column
                  // per month since. An empty cell is a month that has not happened — not a 0,
                  // which would read as total churn.
                  ["cohort", "starting", ...report.matrix.columns],
                  ...report.matrix.rows.map((r) => [
                    r.group,
                    String(r.base),
                    ...r.values.map((v) => (v == null ? "" : String(v / 100))),
                  ]),
                ]
              : report.rows
                ? [["group", report.name], ...report.rows.map((r) => [r.group, String(r.value)])]
                : [["period", report.name], ...report.points.map((p) => [p.label, String(p.v)])];
          const csv = rows.map(csvRow).join("\n");
          return reply
            .header("content-type", "text/csv; charset=utf-8")
            .header("content-disposition", `attachment; filename="${key}.csv"`)
            .send(csv);
        }
        /**
         * The half-open window the figures cover, stated as instants.
         *
         * Why it is on the envelope at all: a reader who clicks a bucket has to land on the
         * list of rows behind that figure, and the rows a windowed report counts are the ones
         * inside THIS span. Without it the client would have to re-derive the span from the
         * range name — a second copy of the range arithmetic, which is how a drill-down ends
         * up disagreeing with the figure it was drilled from.
         *
         * `buildBuckets` is the same function the report layer builds its buckets with, and a
         * re-cut series is clipped to this span, so the span is the window at every
         * granularity.
         */
        const span = buildBuckets(
          report.range,
          new Date(),
          report.shape === "forward" ? "forward" : "back",
        );
        return {
          ...report,
          window_start: span[0]!.start.toISOString(),
          window_end: span[span.length - 1]!.end.toISOString(),
        };
      } catch (e) {
        // A bad key or an unsupported breakdown is the caller's mistake, not a 500 — and the
        // message names what IS supported, because a client discovering the catalogue
        // programmatically has nothing else to go on.
        if (e instanceof ReportError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  /**
   * What raw data can be exported, and which report figure each set reconciles with.
   *
   * Declared rather than documented, for the same reason the report catalogue is: a client
   * that keeps its own list of exports will eventually offer one the engine has dropped.
   */
  app.get(
    "/v1/businesses/:biz/raw_export",
    { preHandler: [authenticate, requirePerm("reports:export")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      return { object: "list", data: RAW_DATASETS };
    },
  );

  /**
   * The rows behind a figure.
   *
   * A report says the quarter billed $1.44M; this says which invoices. The window comes from
   * `buildBuckets` — the report layer's own bucket builder — because an export cut on a
   * second calendar would explain a number it does not equal.
   *
   * Every money column stays in the currency it was earned in, with the conversion the
   * report applied stated beside it (`reporting_rate`, `reporting_amount_minor`), and the
   * only totals offered are per currency. A row no rate reaches is left out, exactly as the
   * report leaves it out.
   */
  app.get(
    "/v1/businesses/:biz/raw_export/:dataset",
    { preHandler: [authenticate, requirePerm("reports:export")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { dataset } = req.params as { dataset: string };
      if (!isRawDataset(dataset)) {
        return badRequest(
          reply,
          `dataset must be one of: ${RAW_DATASETS.map((d) => d.key).join(", ")}`,
        );
      }
      const q = req.query as Record<string, string | undefined>;
      if (q.limit != null && !/^\d+$/.test(q.limit)) {
        return badRequest(reply, "limit must be a positive integer");
      }
      const opts = {
        range: q.range,
        currency: q.currency,
        limit: q.limit != null ? Number(q.limit) : undefined,
        startingAfter: q.starting_after || undefined,
      };
      try {
        if ((q.format ?? "").toLowerCase() === "csv") {
          // A full row-level file leaving the system is a security event. JSON pages are not
          // audited: one export is many pages, and each would be a row.
          await writeAuditLog({
            organizationId: req.organization!.id,
            businessId: business.id,
            action: "data.export",
            resourceType: "raw_export",
            resourceId: dataset,
            after: {
              dataset,
              format: "csv",
              range: opts.range ?? null,
              currency: opts.currency ?? null,
            },
          });
          // Streamed page by page: the response is bounded by one page, not by the tenant.
          return reply
            .header("content-type", "text/csv; charset=utf-8")
            .header("content-disposition", `attachment; filename="${dataset}.csv"`)
            .send(Readable.from(streamRawCsv(req.organization!.id, business.id, dataset, opts)));
        }
        const page = await readRawPage(req.organization!.id, business.id, dataset, opts);
        return {
          object: "list",
          dataset: page.dataset.key,
          reconciles_with: page.dataset.reconciles_with,
          window_start: page.windowStart.toISOString(),
          window_end: page.windowEnd.toISOString(),
          reporting_currency: page.reportingCurrency,
          converted: page.converted,
          totals_by_currency: page.totalsByCurrency,
          columns: page.columns,
          data: page.rows,
          has_more: page.hasMore,
          next_cursor: page.nextCursor,
          limit: Math.min(opts.limit ?? 500, MAX_PAGE),
        };
      } catch (e) {
        if (e instanceof RawExportError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Payments analytics: gateway-side volume/refunds/chargebacks/declines over a
  // CALENDAR period. Separate from /analytics on purpose — different measures,
  // different ranges.
  app.get(
    "/v1/businesses/:biz/payments_analytics",
    { preHandler: [authenticate, requirePerm("reports:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as Record<string, string | undefined>;
      if (q.range != null && !isCalendarRange(q.range)) {
        return badRequest(reply, `range must be one of: ${CALENDAR_RANGES.join(", ")}`);
      }
      const analytics = await computePaymentsAnalytics(req.organization!.id, business.id, {
        range: q.range as CalendarRange | undefined,
        currency: q.currency,
        gateway: q.gateway ?? null,
        paymentMethod: q.payment_method ?? null,
      });
      return { object: "business_payments_analytics", business: business.publicId, ...analytics };
    },
  );

  /**
   * Cancellations over a window: kind (paying / trial not converted / free), cause, merchant
   * reason, tenure, a bucketed trend and the largest losses. The population is the
   * subscriptions list's own filters, so each figure matches the list it drills into.
   */
  app.get(
    "/v1/businesses/:biz/cancellation_analytics",
    {
      preHandler: [authenticate, requirePerm("reports:view")],
      config: { repeatableQuery: ["bucket"] },
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as Record<string, string | string[] | undefined>;
      const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
      const start = one(q.start);
      const end = one(q.end);
      if (!start || !DAY_RE.test(start) || !end || !DAY_RE.test(end) || start > end) {
        return badRequest(reply, "start and end are required dates (YYYY-MM-DD), start ≤ end");
      }
      const raw = q.bucket == null ? [] : Array.isArray(q.bucket) ? q.bucket : [q.bucket];
      if (raw.length > 60) return badRequest(reply, "at most 60 buckets");
      const buckets: Array<{ start: string; end: string }> = [];
      for (const b of raw) {
        const [s, e] = b.split(",");
        if (!s || !e || !DAY_RE.test(s) || !DAY_RE.test(e) || s > e) {
          return badRequest(reply, "bucket must be `YYYY-MM-DD,YYYY-MM-DD`");
        }
        buckets.push({ start: s, end: e });
      }
      const plan = one(q.plan);
      const interval = one(q.interval);
      if (interval && !["day", "week", "month", "year"].includes(interval)) {
        return badRequest(reply, "interval must be one of: day, week, month, year");
      }
      const filters = [
        { field: "status", op: "is", value: "cancelled" },
        { field: "canceled_at", op: "between", value: `${start},${end}` },
        ...(plan ? [{ field: "plan", op: "is", value: plan }] : []),
        ...(interval ? [{ field: "billing_period_unit", op: "is", value: interval }] : []),
      ];
      const analytics = await computeCancellationAnalytics(req.organization!.id, business.id, {
        filters,
        buckets,
      });
      return {
        object: "business_cancellation_analytics",
        business: business.publicId,
        start,
        end,
        ...analytics,
      };
    },
  );

  // Per-business metrics.
  app.get(
    "/v1/businesses/:biz/metrics",
    { preHandler: [authenticate, requirePerm("reports:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const metrics = await computeBusinessMetrics(req.organization!.id, business.id, new Date());
      return { object: "metrics", business: business.publicId, ...metrics };
    },
  );

  // Org-wide roll-up: each business's metrics + a combined MRR-by-currency total.
  app.get(
    "/v1/metrics",
    { preHandler: [authenticate, requirePerm("reports:view")] },
    async (req) => {
      const now = new Date();
      const businesses = await listBusinesses(req.organization!.id);
      const perBusiness = await Promise.all(
        businesses.map(async (b) => ({
          business: b.publicId,
          name: b.name,
          metrics: await computeBusinessMetrics(req.organization!.id, b.id, now),
        })),
      );
      // Combine MRR/ARR/active by currency across businesses.
      const totals = new Map<
        string,
        { mrr_minor: number; arr_minor: number; active: number; trialing: number }
      >();
      for (const pb of perBusiness) {
        for (const c of pb.metrics.currencies) {
          const t = totals.get(c.currency) ?? {
            mrr_minor: 0,
            arr_minor: 0,
            active: 0,
            trialing: 0,
          };
          t.mrr_minor += c.mrr_minor;
          t.arr_minor += c.arr_minor;
          t.active += c.active;
          t.trialing += c.trialing;
          totals.set(c.currency, t);
        }
      }
      return {
        object: "metrics_rollup",
        as_of: now.toISOString(),
        totals_by_currency: [...totals.entries()].map(([currency, t]) => ({ currency, ...t })),
        businesses: perBusiness,
      };
    },
  );
}
