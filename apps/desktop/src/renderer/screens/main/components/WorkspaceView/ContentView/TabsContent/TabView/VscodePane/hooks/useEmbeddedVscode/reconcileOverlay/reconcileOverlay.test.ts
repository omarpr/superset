import { describe, expect, it } from "bun:test";
import { reconcileOverlay } from "./reconcileOverlay";

/**
 * Minimal DOMRect factory — bun:test doesn't run in a browser, so we fabricate
 * enough of the DOMRect shape that `reconcileOverlay` relies on.
 */
const rect = (x: number, y: number, width: number, height: number): DOMRect =>
	({
		x,
		y,
		width,
		height,
		top: y,
		left: x,
		right: x + width,
		bottom: y + height,
		toJSON: () => ({}),
	}) as DOMRect;

const PANE = rect(100, 100, 400, 300);

describe("reconcileOverlay", () => {
	it("returns visible when there are no overlays", () => {
		const result = reconcileOverlay({ paneRect: PANE, overlays: [] });
		expect(result).toEqual({ visible: true, tooltipOnly: false });
	});

	it("hides native view when a non-tooltip overlay intersects the pane", () => {
		const result = reconcileOverlay({
			paneRect: PANE,
			overlays: [{ rect: rect(120, 120, 100, 100), isTooltip: false }],
		});
		expect(result).toEqual({ visible: false, tooltipOnly: false });
	});

	it("hides native view and flags tooltipOnly when only a tooltip intersects", () => {
		const result = reconcileOverlay({
			paneRect: PANE,
			overlays: [{ rect: rect(150, 150, 80, 30), isTooltip: true }],
		});
		expect(result).toEqual({ visible: false, tooltipOnly: true });
	});

	it("prefers non-tooltip reason when a tooltip and a menu both intersect", () => {
		const result = reconcileOverlay({
			paneRect: PANE,
			overlays: [
				{ rect: rect(150, 150, 80, 30), isTooltip: true },
				{ rect: rect(200, 200, 120, 80), isTooltip: false },
			],
		});
		expect(result).toEqual({ visible: false, tooltipOnly: false });
	});

	it("keeps the native view visible when overlays sit entirely outside the pane", () => {
		const result = reconcileOverlay({
			paneRect: PANE,
			overlays: [
				{ rect: rect(0, 0, 50, 50), isTooltip: false },
				{ rect: rect(600, 600, 100, 100), isTooltip: true },
			],
		});
		expect(result).toEqual({ visible: true, tooltipOnly: false });
	});

	it("treats non-intersecting non-tooltip as absent for tooltipOnly classification", () => {
		const result = reconcileOverlay({
			paneRect: PANE,
			overlays: [
				// Tooltip intersects the pane.
				{ rect: rect(150, 150, 80, 30), isTooltip: true },
				// Non-tooltip overlay sits entirely outside the pane.
				{ rect: rect(800, 800, 50, 50), isTooltip: false },
			],
		});
		expect(result).toEqual({ visible: false, tooltipOnly: true });
	});

	it("ignores zero-area overlays (e.g. display:none or unmounted)", () => {
		const result = reconcileOverlay({
			paneRect: PANE,
			overlays: [
				// Would intersect if it had area, but width=0 => skipped.
				{ rect: rect(200, 200, 0, 50), isTooltip: false },
				// Height=0 tooltip — also skipped.
				{ rect: rect(150, 150, 80, 0), isTooltip: true },
			],
		});
		expect(result).toEqual({ visible: true, tooltipOnly: false });
	});
});
