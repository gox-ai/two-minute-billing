/**
 * The embed loader, served at `/js/v1/embed.js`. Plain ES2017, no dependencies. It frames a
 * checkout session the business minted with `embed_origin`, as an overlay or inline, and passes
 * the frame's events to the page. Messages are accepted only from that frame and its origin.
 *
 *   const c = TMB.checkout.open({ url });          // overlay
 *   TMB.checkout.mount("#checkout", { url });      // inline
 *   TMB.portal.open({ url });                      // the customer portal, as an overlay
 *   c.on("success", (e) => …); c.close();
 *
 * Text the buyer reads follows ASD-STE100. If the frame does not load (a browser that refuses
 * the partitioned session cookie, or a blocked frame), the panel offers the same link in a new tab.
 */
import { createHash } from "node:crypto";

export const EMBED_SCRIPT = String.raw`(function () {
  "use strict";
  if (window.TMB && window.TMB.checkout && window.TMB.portal) return;
  var LOAD_TIMEOUT_MS = 12000;
  var CSS = [
    ":host{all:initial}",
    ".scrim{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,18,32,.55);font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;opacity:0;transition:opacity .2s cubic-bezier(.32,.72,0,1)}",
    ".scrim.on{opacity:1}",
    ".panel{position:relative;width:min(480px,100%);height:min(760px,100%);border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 24px 64px rgba(0,0,0,.28);transform:translateY(12px) scale(.98);transition:transform .26s cubic-bezier(.32,.72,0,1)}",
    ".scrim.on .panel{transform:none}",
    ".panel.portal{width:min(720px,100%);height:min(860px,100%)}",
    "@media (max-width:599px){.scrim{padding:0}.panel{width:100%;height:100%;border-radius:0}}",
    "iframe{display:block;width:100%;height:100%;border:0;background:#fff}",
    ".state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;color:#1b1b2b;background:#fff}",
    ".spin{width:28px;height:28px;border-radius:50%;border:3px solid #e3e4ee;border-top-color:#4e4eda;animation:r .8s linear infinite}",
    "@keyframes r{to{transform:rotate(360deg)}}",
    ".btn{font:600 14px system-ui,sans-serif;padding:9px 14px;border-radius:8px;border:1px solid #4e4eda;background:#4e4eda;color:#fff;cursor:pointer;text-decoration:none}",
    ".btn.ghost{background:#fff;color:#1b1b2b;border-color:#d6d7e3}",
    ".x{position:absolute;top:10px;right:10px;z-index:2;width:32px;height:32px;border-radius:50%;border:1px solid #e3e4ee;background:#fff;color:#1b1b2b;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.08)}",
    ".x:hover{background:#f4f4f8}.x:focus-visible{outline:3px solid #4e4eda;outline-offset:2px}",
    "@media (prefers-reduced-motion:reduce){.scrim,.panel{transition:none}.spin{animation-duration:2s}}"
  ].join("");

  function Handle(url) {
    this.url = url;
    this.origin = new URL(url).origin;
    this.listeners = {};
    this.closed = false;
  }
  Handle.prototype.on = function (type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
    return this;
  };
  Handle.prototype.emit = function (type, detail) {
    var list = (this.listeners[type] || []).slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i](detail || {}); } catch (e) { setTimeout(function () { throw e; }); }
    }
  };

  function frameFor(handle, mode, kind) {
    var f = document.createElement("iframe");
    f.src = handle.url;
    f.name = "tmb-" + (kind || "checkout") + "-" + mode;
    f.title = kind === "portal" ? "Billing" : "Checkout";
    f.setAttribute("allow", "payment *");
    return f;
  }

  /** Messages from OUR frame only: its window, its origin, our envelope. */
  function listen(handle, frame, onMessage) {
    function receive(e) {
      if (e.source !== frame.contentWindow || e.origin !== handle.origin) return;
      var d = e.data;
      if (!d || d.source !== "tmb-embed" || typeof d.type !== "string") return;
      onMessage(d);
    }
    window.addEventListener("message", receive);
    return function () { window.removeEventListener("message", receive); };
  }

  function fallback(box, handle, text) {
    var s = document.createElement("div");
    s.className = "state";
    var p = document.createElement("p");
    p.textContent = text;
    var a = document.createElement("a");
    a.className = "btn";
    a.href = handle.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Open in a new tab";
    s.appendChild(p);
    s.appendChild(a);
    box.appendChild(s);
    return a;
  }

  function open(opts, kind) {
    kind = kind || "checkout";
    if (!opts || !opts.url) throw new Error("TMB." + kind + ".open needs { url }");
    var handle = new Handle(opts.url);
    var closeOnSuccess = kind === "checkout" && opts.closeOnSuccess !== false;
    var host = document.createElement("div");
    var root = host.attachShadow({ mode: "closed" });
    var style = document.createElement("style");
    style.textContent = CSS;
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.setAttribute("role", "dialog");
    scrim.setAttribute("aria-modal", "true");
    scrim.setAttribute("aria-label", kind === "portal" ? "Billing" : "Checkout");
    var panel = document.createElement("div");
    panel.className = kind === "portal" ? "panel portal" : "panel";
    var loading = document.createElement("div");
    loading.className = "state";
    loading.innerHTML = '<div class="spin" aria-hidden="true"></div>';
    var frame = frameFor(handle, "overlay", kind);
    // The close button is the loader's, so it is there in every state: loading, a notice, the
    // checkout itself, or the new-tab fallback.
    var x = document.createElement("button");
    x.className = "x";
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    x.onclick = function () { handle.close("user"); };
    panel.appendChild(frame);
    panel.appendChild(loading);
    panel.appendChild(x);
    scrim.appendChild(panel);
    root.appendChild(style);
    root.appendChild(scrim);
    document.body.appendChild(host);
    var overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    // Fit what the buyer SEES: on a page wider than the phone, a fixed element sized to the
    // layout viewport runs off the screen, close button included.
    var vv = window.visualViewport;
    function fit() {
      if (!vv) return;
      scrim.style.cssText =
        "inset:auto;left:" + vv.offsetLeft + "px;top:" + vv.offsetTop + "px;width:" + vv.width + "px;height:" + vv.height + "px";
    }
    fit();
    if (vv) { vv.addEventListener("resize", fit); vv.addEventListener("scroll", fit); }
    requestAnimationFrame(function () { scrim.classList.add("on"); });
    var loaded = false;
    var timer = setTimeout(function () {
      if (loaded || handle.closed) return;
      loading.remove();
      showFallback(
        (kind === "portal" ? "Your billing page" : "The checkout") + " did not open here. Open it in a new tab.",
        "frame_blocked"
      );
    }, LOAD_TIMEOUT_MS);
    function showFallback(text, code) {
      frame.style.visibility = "hidden";
      var a = fallback(panel, handle, text);
      var cancel = document.createElement("button");
      cancel.className = "btn ghost";
      cancel.type = "button";
      cancel.textContent = "Close";
      cancel.onclick = function () { handle.close("user"); };
      a.parentNode.appendChild(cancel);
      a.focus();
      handle.emit("error", { code: code });
    }
    function onKey(e) { if (e.key === "Escape") handle.close("user"); }
    document.addEventListener("keydown", onKey);
    var stop = listen(handle, frame, function (d) {
      if (d.type === "loaded") {
        loaded = true;
        clearTimeout(timer);
        loading.remove();
        frame.focus();
      }
      if (d.type === "close") return handle.close((d.detail && d.detail.reason) || "user");
      if (d.type === "error" && d.code === "cookies_blocked") {
        loaded = true;
        clearTimeout(timer);
        loading.remove();
        return showFallback(
          "Your browser blocks " + (kind === "portal" ? "your billing page" : "the checkout") + " here. Open it in a new tab.",
          "cookies_blocked"
        );
      }
      if (d.type === "resize") return;
      handle.emit(d.type, d.detail);
      // Only a paid completion closes by itself, as the hosted page redirects only then: a
      // payment that did not collect leaves its card (amount, next step) open for the buyer.
      if (d.type === "success" && closeOnSuccess && d.detail && d.detail.paid !== false)
        setTimeout(function () { handle.close("success"); }, 2000);
    });
    handle.close = function (reason) {
      if (handle.closed) return;
      handle.closed = true;
      clearTimeout(timer);
      stop();
      document.removeEventListener("keydown", onKey);
      if (vv) { vv.removeEventListener("resize", fit); vv.removeEventListener("scroll", fit); }
      document.documentElement.style.overflow = overflow;
      host.remove();
      handle.emit("close", { reason: reason || "user" });
    };
    return handle;
  }

  function mount(target, opts) {
    var el = typeof target === "string" ? document.querySelector(target) : target;
    if (!el) throw new Error("TMB.checkout.mount: no element " + String(target));
    if (!opts || !opts.url) throw new Error("TMB.checkout.mount needs { url }");
    var handle = new Handle(opts.url);
    var frame = frameFor(handle, "inline");
    frame.style.cssText = "display:block;width:100%;height:640px;border:0;background:transparent";
    el.appendChild(frame);
    var stop = listen(handle, frame, function (d) {
      if (d.type === "resize" && d.detail && d.detail.height > 0) {
        frame.style.height = Math.ceil(d.detail.height) + "px";
        return;
      }
      if (d.type === "error" && d.code === "cookies_blocked") {
        frame.remove();
        var box = document.createElement("div");
        box.style.cssText = "padding:24px;text-align:center;font:14px/1.5 system-ui,sans-serif";
        var root = box.attachShadow({ mode: "closed" });
        var style = document.createElement("style");
        style.textContent = CSS;
        root.appendChild(style);
        var wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:12px";
        root.appendChild(wrap);
        fallback(wrap, handle, "Your browser blocks the checkout here. Open it in a new tab.");
        el.appendChild(box);
        return handle.emit("error", { code: "cookies_blocked" });
      }
      handle.emit(d.type, d.detail);
    });
    handle.close = function () {
      if (handle.closed) return;
      handle.closed = true;
      stop();
      frame.remove();
      handle.emit("close", { reason: "removed" });
    };
    return handle;
  }

  window.TMB = window.TMB || {};
  window.TMB.checkout = { open: function (o) { return open(o, "checkout"); }, mount: mount };
  window.TMB.portal = { open: function (o) { return open(o, "portal"); } };
})();
`;

export const EMBED_SCRIPT_INTEGRITY = `sha384-${createHash("sha384")
  .update(EMBED_SCRIPT, "utf8")
  .digest("base64")}`;
