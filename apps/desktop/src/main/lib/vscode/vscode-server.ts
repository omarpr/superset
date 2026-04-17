import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface VscodeServerOptions {
	/** Path or name of the `code` binary. Pass "code" in production. */
	command: string;
	worktreePath: string;
	port: number;
	env?: NodeJS.ProcessEnv;
	/**
	 * Isolate `code serve-web`'s state to a dedicated directory so
	 * concurrent panes don't share one data dir. Provide a path to override,
	 * `false` to skip, or omit for a fresh temp dir.
	 */
	serverDataDir?: string | false;
	/**
	 * Optional on-disk path where the child PID is recorded after spawn and
	 * removed on exit. Lets the next main-process lifetime reclaim an
	 * orphaned child (dev hot-reload, Electron crash) before binding to the
	 * pinned port. Omit to disable the PID file.
	 */
	pidFilePath?: string;
}

export interface VscodeServerReadyEvent {
	url: string;
}

export interface VscodeServerExitEvent {
	code: number | null;
	signal: NodeJS.Signals | null;
	reason: "exited" | "killed";
	outputTail: string;
}

const READY_REGEX = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?[^\s]*/i;
const OUTPUT_TAIL_MAX = 4000;

/**
 * Wraps a `code serve-web` child process. Emits:
 *  - "ready"  { url }                          once a localhost URL is surfaced
 *  - "exit"   { code, signal, reason, outputTail }
 *  - "stderr" string                           raw stderr chunks (for diagnostics)
 *  - "stdout" string                           raw stdout chunks (for diagnostics)
 */
export class VscodeServer extends EventEmitter {
	private child: ChildProcess | null = null;
	private readyResolved = false;
	private outputTail = "";

	constructor(private readonly options: VscodeServerOptions) {
		super();
	}

	async start(): Promise<void> {
		if (this.child) return;
		const { command, port, env } = this.options;
		const serverDataDir = this.resolveServerDataDir();
		const args = [
			"serve-web",
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"--without-connection-token",
			"--accept-server-license-terms",
			...(serverDataDir ? ["--server-data-dir", serverDataDir] : []),
		];
		this.child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: env ?? process.env,
			detached: false,
		});

		this.writePidFile(this.child.pid);

		this.child.stdout?.on("data", (buf: Buffer) => {
			const text = buf.toString();
			this.appendOutputTail(text);
			this.emit("stdout", text);
			this.tryResolveReady(text);
		});

		this.child.stderr?.on("data", (buf: Buffer) => {
			const text = buf.toString();
			this.appendOutputTail(text);
			this.emit("stderr", text);
			this.tryResolveReady(text);
		});

		this.child.once("exit", (code, signal) => {
			const event: VscodeServerExitEvent = {
				code,
				signal,
				reason: signal ? "killed" : "exited",
				outputTail: this.outputTail,
			};
			this.child = null;
			this.removePidFile();
			this.emit("exit", event);
		});
	}

	/** SIGTERM then force-kill after 500ms if the child is still alive. */
	stop(): void {
		const child = this.child;
		if (!child) return;
		try {
			child.kill("SIGTERM");
		} catch {
			// process may already be gone
		}
		const pid = child.pid;
		setTimeout(() => {
			if (pid && this.child) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// already exited
				}
			}
		}, 500).unref();
	}

	private tryResolveReady(text: string): void {
		if (this.readyResolved) return;
		const match = text.match(READY_REGEX);
		if (match) {
			this.readyResolved = true;
			this.emit("ready", { url: match[0] } satisfies VscodeServerReadyEvent);
		}
	}

	private appendOutputTail(chunk: string): void {
		this.outputTail = (this.outputTail + chunk).slice(-OUTPUT_TAIL_MAX);
	}

	private resolveServerDataDir(): string | null {
		if (this.options.serverDataDir === false) return null;
		if (typeof this.options.serverDataDir === "string") {
			return this.options.serverDataDir;
		}
		return mkdtempSync(path.join(tmpdir(), "superset-vscode-"));
	}

	private writePidFile(pid: number | undefined): void {
		if (!this.options.pidFilePath || !pid) return;
		try {
			writeFileSync(this.options.pidFilePath, String(pid));
		} catch {
			// Non-fatal: reclaim will just fall back to ephemeral port next launch.
		}
	}

	private removePidFile(): void {
		if (!this.options.pidFilePath) return;
		try {
			unlinkSync(this.options.pidFilePath);
		} catch {
			// already gone
		}
	}
}
