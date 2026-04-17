import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

export type VscodePhase =
	| "idle"
	| "starting"
	| "ready"
	| "cli-missing"
	| "failed";

interface Options {
	paneId: string;
	worktreePath: string;
}

interface Result {
	containerRef: React.RefObject<HTMLDivElement | null>;
	phase: VscodePhase;
	errorMessage: string | null;
}

export function useEmbeddedVscode({ paneId, worktreePath }: Options): Result {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [phase, setPhase] = useState<VscodePhase>("idle");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const startMutation = electronTrpc.vscode.start.useMutation();
	const setBoundsMutation = electronTrpc.vscode.setBounds.useMutation();
	const setVisibleMutation = electronTrpc.vscode.setVisible.useMutation();

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
		// view whenever a Radix popper (dropdown/popover/tooltip/menu) or a
		// role=dialog overlay is open and visually intersects the pane rect.
		let currentVisible = false;
		const setVisible = (visible: boolean) => {
			if (visible === currentVisible) return;
			currentVisible = visible;
			setVisibleMutation.mutate({ paneId, visible });
		};
		const OVERLAY_SELECTOR =
			'[data-radix-popper-content-wrapper], [role="dialog"][data-state="open"]';
		const rectsIntersect = (a: DOMRect, b: DOMRect) =>
			a.right > b.left &&
			a.left < b.right &&
			a.bottom > b.top &&
			a.top < b.bottom;
		const reconcile = () => {
			const paneRect = el.getBoundingClientRect();
			const overlays =
				document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR);
			for (const overlay of overlays) {
				const r = overlay.getBoundingClientRect();
				if (r.width === 0 || r.height === 0) continue;
				if (rectsIntersect(r, paneRect)) {
					setVisible(false);
					return;
				}
			}
			setVisible(true);
		};
		reconcile();

		const ro = new ResizeObserver(() => {
			push();
			reconcile();
		});
		ro.observe(el);
		const onResize = () => {
			push();
			reconcile();
		};
		const onScroll = () => {
			push();
			reconcile();
		};
		window.addEventListener("resize", onResize);
		window.addEventListener("scroll", onScroll, true);

		const mo = new MutationObserver(reconcile);
		mo.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-state", "style"],
		});

		return () => {
			ro.disconnect();
			mo.disconnect();
			window.removeEventListener("resize", onResize);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [paneId, phase, setBoundsMutation.mutate, setVisibleMutation.mutate]);

	return { containerRef, phase, errorMessage };
}
