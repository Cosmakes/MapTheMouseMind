// ──────────────────────────────────────────────────────────────────────────────
// atlas/index.ts  —  AtlasProvider singleton factory.
//
// Returns a lazily-constructed singleton mouse provider so call sites just
// need `getProvider(app)` without importing the concrete implementation.
// ──────────────────────────────────────────────────────────────────────────────

import type { App } from "obsidian";
import type { AtlasProvider } from "./provider";
import { createMouseProvider } from "./mouseProvider";

let cached: AtlasProvider | null = null;

export function getProvider(app: App): AtlasProvider {
	if (!cached) cached = createMouseProvider(app);
	return cached;
}

export type { AtlasProvider } from "./provider";
