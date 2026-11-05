/**
 * The embeddable usage widget script, served at `/widget/v1/usage.js`. Plain ES2017, no
 * dependencies, rendered in a shadow root with textContent only (no HTML from data).
 * Theme it with the `--uw-*` CSS variables on the host element.
 */
import { createHash } from "node:crypto";

export const USAGE_WIDGET_SCRIPT = String.raw`(function () {
  "use strict";
  if (window.UsageWidget) return;
  var current = document.currentScript;
  var defaultBase = current && current.src ? new URL(current.src).origin : "";
  var REFRESH_MS = 60000;

  function fmtMoney(minor, currency) {
    try {
      var f = new Intl.NumberFormat(undefined, { style: "currency", currency: currency });
      var digits = f.resolvedOptions().maximumFractionDigits;
      return f.format(minor / Math.pow(10, digits));
    } catch (e) {
      return String(minor) + " " + currency;
    }
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function row(label, value) {
    var r = el("div", "row");
    r.appendChild(el("span", "label", label));
    r.appendChild(el("span", "value", value));
    return r;
  }
  var INTERVAL = { day: "day", week: "week", month: "month", period: "billing period" };
  var CSS = [
    ":host{display:block;font:var(--uw-font,14px/1.5 system-ui,sans-serif);color:var(--uw-fg,#111827)}",
    ".card{background:var(--uw-bg,#fff);border:1px solid var(--uw-border,#e5e7eb);border-radius:var(--uw-radius,12px);padding:16px;display:flex;flex-direction:column;gap:12px}",
    ".title{font-weight:600;font-size:15px;margin:0}",
    ".big{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}",
    ".muted{color:var(--uw-muted,#6b7280);font-size:12px}",
    ".row{display:flex;justify-content:space-between;gap:12px;font-variant-numeric:tabular-nums}",
    ".label{color:var(--uw-muted,#6b7280)}",
    ".section{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--uw-border,#e5e7eb);padding-top:12px}",
    ".accent{color:var(--uw-accent,#4e4eda)}"
  ].join("");

  function render(root, data) {
    root.textContent = "";
    var style = el("style");
    style.textContent = CSS;
    root.appendChild(style);
    var card = el("div", "card");
    var bal = data.balance;
    card.appendChild(el("p", "title", "Credit balance"));
    card.appendChild(el("div", "big", fmtMoney(bal.available_minor, bal.currency)));
    var rw = data.runway;
    var runwayText = !rw || rw.runway_days == null
      ? "Not enough usage to estimate"
      : rw.runway_days === 1 ? "Runs out in about 1 day" : "Runs out in about " + rw.runway_days + " days";
    card.appendChild(el("div", "muted", runwayText));
    var at = data.auto_topup;
    if (at) {
      var line = at.status !== "active" ? "Automatic top-up is off"
        : at.trigger === "threshold" && at.threshold_minor != null
          ? (at.method === "target" && at.target_minor != null
              ? "Automatic top-up fills to " + fmtMoney(at.target_minor, bal.currency)
              : "Automatic top-up adds " + fmtMoney(at.amount_minor || 0, bal.currency)) +
            " when the balance is " + fmtMoney(at.threshold_minor, bal.currency)
          : "Automatic top-up is on a schedule";
      card.appendChild(el("div", "muted", line));
    }
    (data.usage || []).forEach(function (u) {
      var s = el("div", "section");
      s.appendChild(el("p", "title", "Usage this period"));
      u.items.forEach(function (i) {
        s.appendChild(row(i.name, fmtMoney(i.amount_minor, u.currency)));
      });
      if (u.projected_subtotal_minor != null)
        s.appendChild(row("Estimated bill for the period", fmtMoney(u.projected_subtotal_minor, u.currency)));
      card.appendChild(s);
    });
    if (data.limits && data.limits.length) {
      var l = el("div", "section");
      l.appendChild(el("p", "title", "Spend limits"));
      data.limits.forEach(function (x) {
        var what = x.scope === "property"
          ? x.property_key + (x.property_value ? " " + x.property_value : " (each value)")
          : "All usage";
        l.appendChild(row(what + " per " + (INTERVAL[x.interval] || x.interval),
          fmtMoney(x.amount_minor, x.currency) + (x.mode === "soft" ? " (alert only)" : "")));
      });
      card.appendChild(l);
    }
    root.appendChild(card);
  }

  function mount(target, options) {
    var host = typeof target === "string" ? document.querySelector(target) : target;
    if (!host) throw new Error("UsageWidget: no element to mount on.");
    if (!options || typeof options.getToken !== "function")
      throw new Error("UsageWidget: options.getToken must be a function.");
    var base = (options.apiBase || defaultBase).replace(/\/$/, "");
    var root = host.shadowRoot || host.attachShadow({ mode: "open" });
    var token = null;
    var timer = null;
    var stopped = false;
    function fetchView(retry) {
      var p = token ? Promise.resolve(token) : Promise.resolve(options.getToken());
      return p.then(function (t) {
        token = t;
        return fetch(base + "/widget/v1/usage", { headers: { Authorization: "Bearer " + t } });
      }).then(function (res) {
        if (res.status === 401 && retry) { token = null; return fetchView(false); }
        if (!res.ok) throw new Error("UsageWidget: the request failed (" + res.status + ").");
        return res.json();
      });
    }
    function load() {
      if (stopped) return;
      fetchView(true).then(function (data) {
        if (data) render(root, data);
      }).catch(function (e) {
        root.textContent = "";
        var s = el("style"); s.textContent = CSS; root.appendChild(s);
        root.appendChild(el("div", "card muted", "We could not load your usage. Try again later."));
        if (window.console) console.warn(e);
      }).then(function () {
        if (!stopped) timer = setTimeout(load, options.refreshMs || REFRESH_MS);
      });
    }
    load();
    return { refresh: function () { clearTimeout(timer); load(); }, unmount: function () { stopped = true; clearTimeout(timer); root.textContent = ""; } };
  }

  window.UsageWidget = { mount: mount };
})();
`;

/** Subresource Integrity for the snippet's `integrity` attribute. */
export const USAGE_WIDGET_SCRIPT_INTEGRITY = `sha384-${createHash("sha384")
  .update(USAGE_WIDGET_SCRIPT)
  .digest("base64")}`;
