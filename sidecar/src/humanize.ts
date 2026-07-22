import type { Page } from "patchright";

/**
 * Light, randomized human-like interaction on a freshly-loaded page:
 *   - 2–4 mouse moves to random viewport points (stepped, so it's a path
 *     rather than a teleport)
 *   - 1–2 scroll steps to a random depth
 *   - a short randomized reading dwell (400–1500ms)
 *
 * Why: behavioral anti-bot walls (DataDome, PerimeterX, Akamai BMP) score a
 * session on the PRESENCE of pointer/scroll events and non-instant page
 * transitions, not just RPS. A crawler that navigates → extracts → teleports
 * to the next URL with zero interaction is a strong bot signal even when it's
 * pacing politely. This adds the missing behavioral surface.
 *
 * Best-effort by contract: every action is caught and the whole thing is
 * wrapped, because a detached page / closed context (mid-crawl stop, a nav
 * that swapped the document) must NEVER fail the crawl. Adds ~1–1.5s/page.
 *
 * Works headless too: mouse.move / mouse.wheel dispatch real pointer + wheel
 * events through CDP regardless of whether a cursor is rendered, so the
 * JS-visible event stream a wall inspects is the same.
 */
export async function humanizePage(page: Page): Promise<void> {
  try {
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };

    // A few mouse moves along a rough path. `steps` makes each move a series
    // of intermediate points (a drag-like path) instead of an instantaneous
    // jump, which is what a real pointer produces.
    const moves = randInt(2, 4);
    for (let i = 0; i < moves; i++) {
      const x = rand(0, vp.width);
      const y = rand(0, vp.height);
      await page.mouse.move(x, y, { steps: randInt(3, 8) }).catch(() => {});
      await sleep(rand(40, 140));
    }

    // Scroll down to a random depth in 1–2 wheel steps.
    const scrolls = randInt(1, 2);
    for (let i = 0; i < scrolls; i++) {
      await page.mouse.wheel(0, randInt(200, 800)).catch(() => {});
      await sleep(rand(120, 320));
    }

    // Reading dwell — the dominant, most variable pause.
    await sleep(rand(400, 1500));
  } catch {
    // Best-effort: never fail the crawl over interaction jitter.
  }
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
