import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContentsView } from "electron";
import { getProcessEnvWithShellPath } from "../../../lib/trpc/routers/workspaces/utils/shell-env";
import { isCodeCliAvailable as defaultIsCodeCliAvailable } from "./check-code-cli";
import { findFreePort as defaultFindFreePort } from "./find-free-port";
import { VscodeServer } from "./vscode-server";

async function createDefaultView(): Promise<WebContentsView> {
	const electron = await import("electron");
	return new electron.WebContentsView({
		webPreferences: {
			backgroundThrottling: false,
			// Persistent partition shared across all VS Code panes so
			// browser-side state (UI settings, installed extension cache,
			// theme prefs) survives pane restarts. `code serve-web` only
			// exposes --server-data-dir for server state; anything the
			// web UI persists lives in the Electron session storage.
			partition: "persist:vscode",
		},
	});
}

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
	/** Stable on-disk location for `code serve-web` state shared across panes. */
	serverDataDir?: string;
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
function appendFolderParam(url: string, folder: string): string {
	try {
		const parsed = new URL(url);
		parsed.searchParams.set("folder", folder);
		return parsed.toString();
	} catch {
		return url;
	}
}

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
		const isAvailable =
			this.deps.isCodeCliAvailable ?? defaultIsCodeCliAvailable;
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
				serverDataDir: this.deps.serverDataDir,
			});

		const view = this.deps.createView?.() ?? (await createDefaultView());
		view.setVisible(false);
		view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
		window.contentView.addChildView(view);

		const entry: Entry = { server, view, port, ready: false };
		this.entries.set(paneId, entry);
		this.emitStatus({ paneId, status: "starting" });

		const onStderr = (chunk: string) => {
			console.warn(`[vscode:${paneId}] stderr:`, chunk.trimEnd());
		};
		const onStdout = (chunk: string) => {
			console.log(`[vscode:${paneId}] stdout:`, chunk.trimEnd());
		};
		server.on("stderr", onStderr);
		server.on("stdout", onStdout);

		const result = await new Promise<VscodeStartResult>((resolve) => {
			const onReady = (info: { url: string }) => {
				entry.ready = true;
				const urlWithFolder = appendFolderParam(info.url, worktreePath);
				view.webContents.loadURL(urlWithFolder);
				this.emitStatus({ paneId, status: "ready" });
				resolve({ status: "ready", port });
			};
			const onExit = (info: {
				code: number | null;
				signal: NodeJS.Signals | null;
				outputTail?: string;
			}) => {
				server.off("ready", onReady);
				server.off("stderr", onStderr);
				server.off("stdout", onStdout);
				this.cleanup(paneId);
				const tail = info.outputTail?.trim();
				const detail = `code=${info.code ?? "null"}${tail ? `\n${tail}` : ""}`;
				this.emitStatus({
					paneId,
					status: "exited",
					error: `exited (${detail})`,
				});
				if (!entry.ready) {
					resolve({
						status: "failed",
						error: `child exited before ready (${detail})`,
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

	/**
	 * Transfer OS-level keyboard focus to the embedded webContents. Needed
	 * because the main window's document-level keydown listeners (react-
	 * hotkeys-hook) keep swallowing VS Code shortcuts like `Cmd+P` unless
	 * the child view is explicitly made first responder.
	 */
	focus(paneId: string): void {
		const entry = this.entries.get(paneId);
		if (!entry) return;
		if (!entry.ready) return;
		try {
			entry.view.webContents.focus();
		} catch {
			// webContents may be destroyed mid-teardown
		}
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
