/**
 * Pure, testable overlay reconciliation logic for the embedded VS Code pane.
 *
 * A `WebContentsView` is a native OS-level view composited above ALL HTML in
 * the Electron window — no CSS `z-index` can put DOM overlays on top. The
 * workaround is to hide the native view whenever a blocking Radix (or cmdk /
 * sonner) overlay visually intersects the pane rect.
 *
 * This module answers: given the pane rect and a list of candidate overlays,
 * should the native view be visible, and is the ONLY reason for hiding it a
 * tooltip? The caller uses the tooltip-only signal to apply a longer debounce
 * so rapid cursor-transit tooltip flashes don't flicker the native view.
 */

export interface ReconcileOverlayInput {
	paneRect: DOMRect;
	overlays: Array<{ rect: DOMRect; isTooltip: boolean }>;
}

export interface ReconcileOverlayResult {
	visible: boolean;
	/** True when the only reason the native view is hidden is a tooltip. */
	tooltipOnly: boolean;
}

const rectsIntersect = (a: DOMRect, b: DOMRect): boolean =>
	a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;

const hasArea = (r: DOMRect): boolean => r.width > 0 && r.height > 0;

export function reconcileOverlay(
	input: ReconcileOverlayInput,
): ReconcileOverlayResult {
	const { paneRect, overlays } = input;

	let blockedByNonTooltip = false;
	let blockedByTooltip = false;

	for (const overlay of overlays) {
		if (!hasArea(overlay.rect)) continue;
		if (!rectsIntersect(overlay.rect, paneRect)) continue;
		if (overlay.isTooltip) {
			blockedByTooltip = true;
		} else {
			blockedByNonTooltip = true;
		}
	}

	if (blockedByNonTooltip) {
		return { visible: false, tooltipOnly: false };
	}
	if (blockedByTooltip) {
		return { visible: false, tooltipOnly: true };
	}
	return { visible: true, tooltipOnly: false };
}
