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
				setErrorMessage(
					error instanceof Error ? error.message : String(error),
				);
			});
		return () => {
			cancelled = true;
			setVisibleMutation.mutate({ paneId, visible: false });
		};
	}, [paneId, worktreePath]);

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
		setVisibleMutation.mutate({ paneId, visible: true });

		const ro = new ResizeObserver(push);
		ro.observe(el);
		window.addEventListener("resize", push);
		window.addEventListener("scroll", push, true);
		return () => {
			ro.disconnect();
			window.removeEventListener("resize", push);
			window.removeEventListener("scroll", push, true);
		};
	}, [paneId, phase]);

	return { containerRef, phase, errorMessage };
}
