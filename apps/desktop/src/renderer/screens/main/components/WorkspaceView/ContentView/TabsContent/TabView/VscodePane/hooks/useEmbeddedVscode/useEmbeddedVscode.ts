import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { reconcileOverlay } from "./reconcileOverlay";

export type VscodePhase =
	| "idle"
	| "starting"
	| "ready"
	| "cli-missing"
	| "failed";

interface Options {
	paneId: string;
	tabId: string;
	worktreePath: string;
}

interface Result {
	containerRef: React.RefObject<HTMLDivElement | null>;
	phase: VscodePhase;
	errorMessage: string | null;
}

export function useEmbeddedVscode({
	paneId,
	tabId,
	worktreePath,
}: Options): Result {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [phase, setPhase] = useState<VscodePhase>("idle");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const isPaneFocused = useTabsStore((s) => s.focusedPaneIds[tabId] === paneId);

	const startMutation = electronTrpc.vscode.start.useMutation();
	const setBoundsMutation = electronTrpc.vscode.setBounds.useMutation();
	const setVisibleMutation = electronTrpc.vscode.setVisible.useMutation();
	const focusMutation = electronTrpc.vscode.focus.useMutation();

	useEffect(() => {
		let cancelled = false;
		setPhase("starting");
		setErrorMessage(null);
		startMutation
			.mutateAsync({ paneId, worktreePath })
			.then((result) => {
				if (cancelled) return;
				if (result.status === "ready") {
					setPhase("ready");
				} else if (result.status === "cli-missing") {
					setPhase("cli-missing");
				} else {
					setPhase("failed");
					setErrorMessage(result.error ?? "Failed to start VS Code server");
				}
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setPhase("failed");
				setErrorMessage(error instanceof Error ? error.message : String(error));
			});
		return () => {
			cancelled = true;
			setVisibleMutation.mutate({ paneId, visible: false });
		};
	}, [
		paneId,
		worktreePath,
		setVisibleMutation.mutate,
		startMutation.mutateAsync,
	]);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		if (phase !== "ready") return;

		const push = () => {
			const rect = el.getBoundingClientRect();
			setBoundsMutation.mutate({
				paneId,
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
			});
		};
		push();

		// WebContentsView is a native OS-level view composited above all HTML in
		// the window, so no CSS z-index can put overlays on top of it. Hide the
		// view whenever a blocking Radix / cmdk / sonner overlay is open and
		// visually intersects the pane rect. Tooltips are included too, but
		// hiding-due-to-tooltip-only uses a longer debounce so cursor-transit
		// flashes don't flicker the native view.
		let currentVisible = false;
		let pendingVisible: boolean | null = null;
		let flushTimer: number | null = null;
		let rafHandle: number | null = null;
		const HIDE_DEBOUNCE_MS = 16;
		const TOOLTIP_HIDE_DEBOUNCE_MS = 100;
		const flush = () => {
			flushTimer = null;
			if (pendingVisible === null || pendingVisible === currentVisible) return;
			currentVisible = pendingVisible;
			setVisibleMutation.mutate({ paneId, visible: currentVisible });
		};
		const scheduleVisible = (visible: boolean, delayMs: number) => {
			pendingVisible = visible;
			if (flushTimer !== null) return;
			// Coalesce bursts of mutations (e.g. popper position/style updates)
			// into a single IPC call on the next tick.
			flushTimer = window.setTimeout(flush, delayMs);
		};
		// Broad selector: Radix poppers (dropdowns/popovers/menus/selects),
		// open dialogs, cmdk command menus, sonner toast items, and tooltips
		// (handled with a longer hide delay below).
		const OVERLAY_SELECTOR = [
			"[data-radix-popper-content-wrapper]",
			'[role="dialog"][data-state="open"]',
			'[role="tooltip"]',
			"[cmdk-root]",
			"[data-sonner-toast]",
		].join(", ");
		const isTooltipOverlay = (overlay: HTMLElement): boolean =>
			overlay.matches('[role="tooltip"]') ||
			overlay.querySelector('[role="tooltip"]') !== null;
		const reconcile = () => {
			const paneRect = el.getBoundingClientRect();
			const overlayEls =
				document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR);
			const overlays = Array.from(overlayEls, (overlay) => ({
				rect: overlay.getBoundingClientRect(),
				isTooltip: isTooltipOverlay(overlay),
			}));
			const result = reconcileOverlay({ paneRect, overlays });
			if (!result.visible) {
				scheduleVisible(
					false,
					result.tooltipOnly ? TOOLTIP_HIDE_DEBOUNCE_MS : HIDE_DEBOUNCE_MS,
				);
			} else {
				scheduleVisible(true, HIDE_DEBOUNCE_MS);
			}
		};
		// Two-pass reconcile: run immediately, then again after the next layout
		// frame. Radix poppers emit multiple style mutations while positioning;
		// the rAF pass catches the FINAL rect after layout/animation settle,
		// which eliminates the partial-clip bug where the native view hid
		// before the popper reached its final position.
		const reconcileTwoPass = () => {
			reconcile();
			if (rafHandle !== null) cancelAnimationFrame(rafHandle);
			rafHandle = requestAnimationFrame(() => {
				rafHandle = null;
				reconcile();
			});
		};
		reconcileTwoPass();

		const ro = new ResizeObserver(() => {
			push();
			reconcileTwoPass();
		});
		ro.observe(el);
		const onResize = () => {
			push();
			reconcileTwoPass();
		};
		const onScroll = () => {
			push();
			reconcileTwoPass();
		};
		window.addEventListener("resize", onResize);
		window.addEventListener("scroll", onScroll, true);

		const mo = new MutationObserver(reconcileTwoPass);
		mo.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-state"],
		});

		return () => {
			ro.disconnect();
			mo.disconnect();
			if (flushTimer !== null) window.clearTimeout(flushTimer);
			if (rafHandle !== null) cancelAnimationFrame(rafHandle);
			window.removeEventListener("resize", onResize);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [paneId, phase, setBoundsMutation.mutate, setVisibleMutation.mutate]);

	// Whenever the mosaic marks this pane as focused (e.g. via a click on the
	// pane chrome or a keyboard pane-switch), hand keyboard focus back to the
	// embedded webContents so VS Code receives shortcuts.
	useEffect(() => {
		if (phase !== "ready") return;
		if (!isPaneFocused) return;
		focusMutation.mutate({ paneId });
	}, [paneId, phase, isPaneFocused, focusMutation.mutate]);

	return { containerRef, phase, errorMessage };
}
