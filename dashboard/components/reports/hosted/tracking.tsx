import * as React from "react";
import { RecordCard } from "@/components/patterns/record-page";
import { BarList } from "@/components/analytics/home/parts";
import { EmptyState } from "@/components/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { todayInBusinessZone } from "@/components/reports/cancellations/window";
import type {
  CheckoutTracking,
  PortalTracking,
  TrackedRow,
  VisitDevice,
} from "@/lib/api/hosted-page-reports";
import { regionName } from "@/lib/countries";
import { fmtDate } from "@/lib/format-date";
import { money } from "@/lib/format";
import { count, fmtDuration, rate } from "./parts";
import type { ReportFilter } from "./report-filters";

/**
 * The cards that read first-party visit tracking (storefront-analytics): no cookies, GPC and
 * DNT honoured, only pages that ran in a browser. Server components, plain helpers.
 */

export const DEVICE_LABEL: Record<VisitDevice, string> = {
  desktop: "Desktop",
  mobile: "Mobile",
  tablet: "Tablet",
};

const CHECKOUT_STEP_LABEL: Record<string, string> = {
  details: "Your details",
  confirm: "Review",
  card: "Payment details",
  pay: "Payment",
  done: "Confirmation",
};

export const PORTAL_SECTION_LABEL: Record<string, string> = {
  invoices: "Invoices",
  methods: "Payment methods",
  details: "Billing details",
  plan: "Plan",
};

const countryLabel = (c: string | null) => (c ? regionName(c) : "Unknown country");
const deviceLabel = (d: string | null) =>
  d && d in DEVICE_LABEL ? DEVICE_LABEL[d as VisitDevice] : "Unknown device";

/** The Country and Device filters, from the countries tracked for this business. */
export function trackingFilters(
  options: { countries: string[]; devices: VisitDevice[] },
  value: { country: string; device: string },
): ReportFilter[] {
  return [
    {
      param: "country",
      ariaLabel: "Country",
      value: value.country,
      options: [
        { value: "", label: "All countries" },
        ...options.countries.map((c) => ({ value: c, label: regionName(c) })),
      ],
    },
    {
      param: "device",
      ariaLabel: "Device",
      value: value.device,
      options: [
        { value: "", label: "All devices" },
        ...options.devices.map((d) => ({ value: d, label: DEVICE_LABEL[d] })),
      ],
    },
  ];
}

/**
 * "Collecting data since <date>." when the window starts before the first tracked view; null
 * when the whole window is tracked.
 */
export function collectingNote(since: string | null, start: string, tz: string | null) {
  if (!since) return null;
  if (todayInBusinessZone(tz, new Date(since)) <= start) return null;
  return `Collecting data since ${fmtDate(since, tz)}. Earlier days have no tracked visits.`;
}

function Footer({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

function NoVisits() {
  return (
    <EmptyState
      compact
      title="No tracked visits in this period"
      description="We count a visit when a buyer opens the page in a browser."
    />
  );
}

/** Checkout: "Where buyers come from", by channel, source, medium and campaign. */
export function WhereBuyersCome({
  tracking,
  currency,
  note,
}: {
  tracking: CheckoutTracking;
  currency: string;
  note: string | null;
}) {
  const revenue = tracking.channels.reduce((a, c) => a + c.revenue_minor, 0);
  return (
    <RecordCard
      title="Where buyers come from"
      meta="From the referrer and the UTM tags on the checkout link"
      flush
      footer={
        <Footer>
          {note ? `${note} ` : ""}
          Views are checkouts that opened in a browser. Direct: no referrer and no UTM tag.
        </Footer>
      }
    >
      {tracking.channels.length === 0 ? (
        <NoVisits />
      ) : (
        <Table phone="stack">
          <TableHeader>
            <TableRow>
              <TableHead phone="title">Channel</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Medium</TableHead>
              <TableHead>Campaign</TableHead>
              <TableHead className="text-right">Views</TableHead>
              <TableHead className="text-right">Completed</TableHead>
              <TableHead className="text-right">Conversion</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">Share of revenue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tracking.channels.map((c) => (
              <TableRow key={`${c.channel}|${c.source}|${c.medium}|${c.campaign ?? ""}`}>
                <TableCell>{c.channel}</TableCell>
                <TableCell>{c.source}</TableCell>
                <TableCell>{c.medium}</TableCell>
                <TableCell>{c.campaign ?? "—"}</TableCell>
                <TableCell className="text-right">{count(c.views)}</TableCell>
                <TableCell className="text-right">{count(c.completed)}</TableCell>
                <TableCell className="text-right">{rate(c.conversion_bps)}</TableCell>
                <TableCell className="text-right">{money(c.revenue_minor, currency)}</TableCell>
                <TableCell className="text-right">
                  {rate(revenue > 0 ? Math.round((c.revenue_minor / revenue) * 10_000) : null)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </RecordCard>
  );
}

/** Visitor conversion of one country, for the Billing country card's second column. */
export function visitorConversion(tracking: CheckoutTracking, country: string) {
  return tracking.countries.find((c) => c.key === country)?.conversion_bps ?? null;
}

function ConvertedTable({
  rows,
  label,
  head,
}: {
  rows: TrackedRow[];
  label: (k: string | null) => string;
  head: string;
}) {
  return (
    <Table phone="stack">
      <TableHeader>
        <TableRow>
          <TableHead phone="title">{head}</TableHead>
          <TableHead className="text-right">Views</TableHead>
          <TableHead className="text-right">Completed</TableHead>
          <TableHead className="text-right">Conversion</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key ?? "unknown"}>
            <TableCell>{label(r.key)}</TableCell>
            <TableCell className="text-right">{count(r.views)}</TableCell>
            <TableCell className="text-right">{count(r.completed)}</TableCell>
            <TableCell className="text-right">{rate(r.conversion_bps)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Checkout: devices with conversion, and browsers. */
export function CheckoutDevices({
  tracking,
  note,
}: {
  tracking: CheckoutTracking;
  note: string | null;
}) {
  return (
    <RecordCard
      title="Devices"
      meta={`${count(tracking.views)} checkout views`}
      flush
      footer={
        <Footer>
          {note ?? "Read from the browser's user agent. We do not keep the user agent."}
        </Footer>
      }
    >
      {tracking.devices.length === 0 ? (
        <NoVisits />
      ) : (
        <ConvertedTable rows={tracking.devices} label={deviceLabel} head="Device" />
      )}
    </RecordCard>
  );
}

export function CheckoutBrowsers({
  tracking,
  note,
}: {
  tracking: CheckoutTracking;
  note: string | null;
}) {
  return (
    <RecordCard
      title="Browsers"
      meta="Checkout views by browser"
      footer={note ? <Footer>{note}</Footer> : undefined}
    >
      {tracking.browsers.length === 0 ? (
        <NoVisits />
      ) : (
        <BarList
          rows={tracking.browsers.slice(0, 6).map((b) => ({
            key: b.key ?? "unknown",
            label: b.key ?? "Unknown browser",
            total: b.views,
          }))}
          format={count}
        />
      )}
    </RecordCard>
  );
}

export function CheckoutStepTime({
  tracking,
  note,
}: {
  tracking: CheckoutTracking;
  note: string | null;
}) {
  return (
    <RecordCard
      title="Time on each step"
      meta="Median time the step was on screen"
      flush
      footer={note ? <Footer>{note}</Footer> : undefined}
    >
      {tracking.step_time.length === 0 ? (
        <NoVisits />
      ) : (
        <Table phone="stack">
          <TableHeader>
            <TableRow>
              <TableHead phone="title">Step</TableHead>
              <TableHead className="text-right">Views</TableHead>
              <TableHead className="text-right">Median time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tracking.step_time.map((s) => (
              <TableRow key={s.step}>
                <TableCell>{CHECKOUT_STEP_LABEL[s.step] ?? s.step}</TableCell>
                <TableCell className="text-right">{count(s.visits)}</TableCell>
                <TableCell className="text-right">{fmtDuration(s.median_ms / 1000)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </RecordCard>
  );
}

/** Portal: sections viewed, as a share of tracked visits. */
export function PortalSections({
  tracking,
  note,
}: {
  tracking: PortalTracking;
  note: string | null;
}) {
  return (
    <RecordCard
      title="Portal sections viewed"
      meta={`${count(tracking.visits)} tracked visits`}
      footer={
        <Footer>
          {note ? `${note} ` : ""}
          Share of tracked visits that showed the section for at least a second.
        </Footer>
      }
    >
      {tracking.sections.length === 0 ? (
        <NoVisits />
      ) : (
        <BarList
          share={false}
          rows={tracking.sections.map((s) => ({
            key: s.section,
            label: PORTAL_SECTION_LABEL[s.section] ?? s.section,
            total: s.visits,
          }))}
          format={(n) =>
            `${count(n)} · ${rate(tracking.visits > 0 ? Math.round((n / tracking.visits) * 10_000) : null)}`
          }
        />
      )}
    </RecordCard>
  );
}

export function PortalCountries({
  tracking,
  note,
}: {
  tracking: PortalTracking;
  note: string | null;
}) {
  return (
    <RecordCard
      title="Countries"
      meta="Portal visits by the visitor's country"
      footer={note ? <Footer>{note}</Footer> : undefined}
    >
      {tracking.countries.length === 0 ? (
        <NoVisits />
      ) : (
        <BarList
          rows={tracking.countries.slice(0, 8).map((c) => ({
            key: c.key ?? "unknown",
            label: countryLabel(c.key),
            total: c.visits,
          }))}
          format={count}
        />
      )}
    </RecordCard>
  );
}

export function PortalDevices({
  tracking,
  note,
}: {
  tracking: PortalTracking;
  note: string | null;
}) {
  return (
    <RecordCard
      title="Devices"
      meta="Portal visits by device"
      footer={note ? <Footer>{note}</Footer> : undefined}
    >
      {tracking.devices.length === 0 ? (
        <NoVisits />
      ) : (
        <BarList
          rows={tracking.devices.map((d) => ({
            key: d.key ?? "unknown",
            label: deviceLabel(d.key),
            total: d.visits,
          }))}
          format={count}
        />
      )}
    </RecordCard>
  );
}
