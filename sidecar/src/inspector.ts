import fs from "node:fs";
import { chromium, type Page } from "patchright";
import { writeLine } from "./pipeline.js";
import {
  ensureChromiumExecutable,
  getBrowserProfileDir,
  ensureProtocol,
  killChromeForProfile,
  STEALTH_ARGS,
} from "./crawler.js";

const INSPECTOR_SCRIPT = `(() => {
  if (window.__feraInspectorActive) return;
  window.__feraInspectorActive = true;

  var host = document.createElement("div");
  host.id = "__fera-inspector-host";
  host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
  document.documentElement.appendChild(host);
  var shadow = host.attachShadow({ mode: "open" });

  var overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;pointer-events:none;background:rgba(86,156,214,0.3);border:2px solid rgba(86,156,214,0.8);border-radius:2px;transition:all 0.05s ease;display:none;z-index:2147483647;";
  shadow.appendChild(overlay);

  var tooltip = document.createElement("div");
  tooltip.style.cssText = "position:fixed;pointer-events:none;background:#1e1e2e;color:#fff;font:600 11px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);box-shadow:0 4px 12px rgba(0,0,0,0.4);white-space:nowrap;display:none;z-index:2147483647;max-width:400px;overflow:hidden;text-overflow:ellipsis;";
  shadow.appendChild(tooltip);

  var currentEl = null;

  function getSelector(el) {
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) {
      return "#" + CSS.escape(el.id);
    }
    var tag = el.tagName.toLowerCase();
    if (el.classList.length > 0) {
      for (var i = 0; i < el.classList.length; i++) {
        var sel = tag + "." + CSS.escape(el.classList[i]);
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      var fullSel = tag + "." + Array.from(el.classList).map(function(c) { return CSS.escape(c); }).join(".");
      if (document.querySelectorAll(fullSel).length === 1) return fullSel;
    }
    if (document.querySelectorAll(tag).length === 1) return tag;
    var attrs = ["name", "role", "type", "data-testid", "aria-label"];
    for (var j = 0; j < attrs.length; j++) {
      var attrVal = el.getAttribute(attrs[j]);
      if (attrVal) {
        var attrSel = tag + "[" + attrs[j] + '="' + CSS.escape(attrVal) + '"]';
        if (document.querySelectorAll(attrSel).length === 1) return attrSel;
      }
    }
    var parts = [];
    var current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      var cTag = current.tagName.toLowerCase();
      var parent = current.parentElement;
      if (!parent) break;
      var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === current.tagName; });
      if (siblings.length > 1) {
        var idx = siblings.indexOf(current) + 1;
        parts.unshift(cTag + ":nth-child(" + idx + ")");
      } else {
        parts.unshift(cTag);
      }
      var partial = parts.join(" > ");
      if (document.querySelectorAll(partial).length === 1) return partial;
      current = parent;
    }
    return parts.join(" > ");
  }

  document.addEventListener("mouseover", function(e) {
    var el = e.target;
    if (!el || el === document.body || el === document.documentElement) {
      overlay.style.display = "none";
      tooltip.style.display = "none";
      currentEl = null;
      return;
    }
    currentEl = el;
    var rect = el.getBoundingClientRect();
    overlay.style.left = rect.left + "px";
    overlay.style.top = rect.top + "px";
    overlay.style.width = rect.width + "px";
    overlay.style.height = rect.height + "px";
    overlay.style.display = "block";

    var tag = el.tagName.toLowerCase();
    var classes = el.classList.length > 0 ? "." + Array.from(el.classList).join(".") : "";
    var dims = Math.round(rect.width) + " \\u00d7 " + Math.round(rect.height);
    tooltip.textContent = tag + classes + "  " + dims;
    tooltip.style.display = "block";

    var tTop = rect.bottom + 8;
    if (tTop + 30 > window.innerHeight) tTop = rect.top - 36;
    tooltip.style.top = tTop + "px";
    tooltip.style.left = Math.min(rect.left, window.innerWidth - 350) + "px";
  }, true);

  document.addEventListener("mouseout", function(e) {
    if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
      overlay.style.display = "none";
      tooltip.style.display = "none";
      currentEl = null;
    }
  }, true);

  document.addEventListener("click", function(e) {
    if (!currentEl) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    var el = currentEl;
    var selector = getSelector(el);
    var tag = el.tagName.toLowerCase();
    var text = (el.textContent || "").trim().substring(0, 200);
    var rect = el.getBoundingClientRect();
    var dims = Math.round(rect.width) + " \\u00d7 " + Math.round(rect.height);

    overlay.style.background = "rgba(78,201,176,0.4)";
    overlay.style.borderColor = "rgba(78,201,176,0.9)";
    setTimeout(function() {
      overlay.style.background = "rgba(86,156,214,0.3)";
      overlay.style.borderColor = "rgba(86,156,214,0.8)";
    }, 300);

    window.__feraPickSelector(selector, tag, text, dims);
  }, true);
})()`;

export async function openInspector(rawUrl: string, profileDir?: string): Promise<void> {
  const url = ensureProtocol(rawUrl);
  const executablePath = await ensureChromiumExecutable("inspect");
  const userDataDir = getBrowserProfileDir(profileDir);

  fs.mkdirSync(userDataDir, { recursive: true });
  await killChromeForProfile(userDataDir);

  writeLine({ event: "browser-opened", url } as any);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ...(executablePath ? { executablePath } : {}),
    args: [...STEALTH_ARGS, "--start-maximized"],
    ignoreDefaultArgs: ["--enable-automation"],
    viewport: null,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  await page.exposeFunction("__feraPickSelector", (selector: string, tag: string, text: string, dimensions: string) => {
    writeLine({ event: "selector-picked", selector, tag, text, dimensions } as any);
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.evaluate(INSPECTOR_SCRIPT);

  page.on("domcontentloaded", async () => {
    try { await page.evaluate(INSPECTOR_SCRIPT); } catch {}
  });

  context.on("page", async (newPage: Page) => {
    try {
      await newPage.exposeFunction("__feraPickSelector", (selector: string, tag: string, text: string, dimensions: string) => {
        writeLine({ event: "selector-picked", selector, tag, text, dimensions } as any);
      });
      newPage.on("domcontentloaded", async () => {
        try { await newPage.evaluate(INSPECTOR_SCRIPT); } catch {}
      });
      try { await newPage.evaluate(INSPECTOR_SCRIPT); } catch {}
    } catch {}
  });

  await new Promise<void>((resolve) => {
    context.on("close", () => resolve());
  });

  writeLine({ event: "browser-closed" } as any);
}
