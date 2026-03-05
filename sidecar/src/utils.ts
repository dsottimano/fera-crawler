import type { ResourceType } from "./types.js";

export function classifyResource(contentType: string): ResourceType {
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml")) return "HTML";
  if (ct.includes("text/css")) return "CSS";
  if (ct.includes("javascript") || ct.includes("ecmascript")) return "JavaScript";
  if (ct.includes("image/")) return "Image";
  if (ct.includes("font/") || ct.includes("application/font") || ct.includes("woff") || ct.includes("opentype")) return "Font";
  if (ct.includes("application/pdf")) return "PDF";
  return "Other";
}
