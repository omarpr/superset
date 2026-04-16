import { EventEmitter } from "node:events";
import { type BrowserWindow, WebContentsView } from "electron";
import { getProcessEnvWithShellPath } from "../../../lib/trpc/routers/workspaces/utils/shell-env";
import { isCodeCliAvailable as defaultIsCodeCliAvailable } from "./check-code-cli";
import { findFreePort as defaultFindFreePort } from "./find-free-port";
import { VscodeServer } from "./vscode-server";

export type VscodeStartStatus = "ready" | "cli-missing" | "failed";

export interface VscodeStartResult {
	status: VscodeStartStatus;
	port?: number;
	error?: string;
}

export interface VscodeBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface VscodeStatusEvent {
	paneId: string;
	status: "starting" | "ready" | "exited" | "error";
	error?: string;
}

export interface VscodeManagerDeps {
	getWindow: () => BrowserWindow | null;
	findFreePort?: () => Promise<number>;
	isCodeCliAvailable?: () => Promise<boolean>;
	createServer?: (port: number, worktreePath: string) => VscodeServer;
	createView?: () => WebContentsView;
}

interface Entry {
	server: VscodeServer;
	view: WebContentsView;
	port: number;
	ready: boolean;
}

/**
 * One coordinator for the whole app. Keyed by paneId.
 * Not exported as a singleton — `main/windows/main.ts` instantiates it with `getWindow`.
 */
export class VscodeManager extends EventEmitter {
	private readonly entries = new Map<string, Entry>();
	private readonly pending = new Map<string, Promise<VscodeStartResult>>();

	constructor(private readonly deps: VscodeManagerDeps) {
		super();
	}

	async start(args: {
		paneId: string;
		worktreePath: string;
	}): Promise<VscodeStartResult> {
		const { paneId, worktreePath } = args;
		const existing = this.entries.get(paneId);
		if (existing) {
			return { status: "ready", port: existing.port };
		}
		const inflight = this.pending.get(paneId);
		if (inflight) return inflight;

		const promise = this.doStart(paneId, worktreePath);
		this.pending.set(paneId, promise);
		try {
			return await promise;
		} finally {
			this.pending.delete(paneId);
		}
	}

	private async doStart(
		paneId: string,
		worktreePath: string,
	): Promise<VscodeStartResult> {
		const isAvailable = this.deps.isCodeCliAvailable ?? defaultIsCodeCliAvailable;
		if (!(await isAvailable())) {
			this.emitStatus({ paneId, status: "error", error: "cli-missing" });
			return { status: "cli-missing" };
		}

		const window = this.deps.getWindow();
		if (!window || window.isDestroyed()) {
			return { status: "failed", error: "no-window" };
		}

		const findPort = this.deps.findFreePort ?? defaultFindFreePort;
		const port = await findPort();

		const server =
			this.deps.createServer?.(port, worktreePath) ??
			new VscodeServer({
				command: "code",
				worktreePath,
				port,
				env: await getProcessEnvWithShellPath(),
			});

		const view =
			this.deps.createView?.() ??
			new WebContentsView({
				webPreferences: { backgroundThrottling: false },
			});
		view.setVisible(false);
		view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
		window.contentView.addChildView(view);

		const entry: Entry = { server, view, port, ready: false };
		this.entries.set(paneId, entry);
		this.emitStatus({ paneId, status: "starting" });

		const result = await new Promise<VscodeStartResult>((resolve) => {
			const onReady = (info: { url: string }) => {
				entry.ready = true;
				view.webContents.loadURL(info.url);
				this.emitStatus({ paneId, status: "ready" });
				resolve({ status: "ready", port });
			};
			const onExit = (info: {
				code: number | null;
				signal: NodeJS.Signals | null;
			}) => {
				server.off("ready", onReady);
				this.cleanup(paneId);
				this.emitStatus({
					paneId,
					status: "exited",
					error: `exited (code=${info.code ?? "null"})`,
				});
				if (!entry.ready) {
					resolve({
						status: "failed",
						error: `child exited before ready (code=${info.code ?? "null"})`,
					});
				}
			};
			server.once("ready", onReady);
			server.once("exit", onExit);
			void server.start();
		});

		return result;
	}

	setBounds(paneId: string, bounds: VscodeBounds): void {
		const entry = this.entries.get(paneId);
		if (!entry) return;
		entry.view.setBounds({
			x: Math.round(bounds.x),
			y: Math.round(bounds.y),
			width: Math.max(0, Math.round(bounds.width)),
			height: Math.max(0, Math.round(bounds.height)),
		});
	}

	setVisible(paneId: string, visible: boolean): void {
		const entry = this.entries.get(paneId);
		if (!entry) return;
		entry.view.setVisible(visible);
	}

	stop(paneId: string): void {
		this.cleanup(paneId);
	}

	stopAll(): void {
		for (const paneId of [...this.entries.keys()]) {
			this.cleanup(paneId);
		}
	}

	has(paneId: string): boolean {
		return this.entries.has(paneId);
	}

	private cleanup(paneId: string): void {
		const entry = this.entries.get(paneId);
		if (!entry) return;
		this.entries.delete(paneId);
		const window = this.deps.getWindow();
		try {
			if (window && !window.isDestroyed()) {
				window.contentView.removeChildView(entry.view);
			}
		} catch {
			// view may already be detached
		}
		try {
			entry.view.webContents.close();
		} catch {
			// webContents may already be destroyed
		}
		try {
			entry.server.stop();
		} catch {
			// process may already be gone
		}
	}

	private emitStatus(event: VscodeStatusEvent): void {
		this.emit("status", event);
		this.emit(`status:${event.paneId}`, event);
	}
}
