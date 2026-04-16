import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface VscodeServerOptions {
	/** Path or name of the `code` binary. Pass "code" in production. */
	command: string;
	worktreePath: string;
	port: number;
	env?: NodeJS.ProcessEnv;
}

export interface VscodeServerReadyEvent {
	url: string;
}

export interface VscodeServerExitEvent {
	code: number | null;
	signal: NodeJS.Signals | null;
	reason: "exited" | "killed";
}

const READY_REGEX = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?[^\s]*/i;

/**
 * Wraps a `code serve-web` child process. Emits:
 *  - "ready"    { url }               once stdout surfaces a localhost URL
 *  - "exit"     { code, signal, reason } when the process dies
 *  - "stderr"   string                raw stderr chunks (for diagnostics)
 */
export class VscodeServer extends EventEmitter {
	private child: ChildProcess | null = null;
	private readyResolved = false;

	constructor(private readonly options: VscodeServerOptions) {
		super();
	}

	async start(): Promise<void> {
		if (this.child) return;
		const { command, worktreePath, port, env } = this.options;
		const args = [
			"serve-web",
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"--without-connection-token",
			"--accept-server-license-terms",
			worktreePath,
		];
		this.child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: env ?? process.env,
			detached: false,
		});

		this.child.stdout?.on("data", (buf: Buffer) => {
			const text = buf.toString();
			if (!this.readyResolved) {
				const match = text.match(READY_REGEX);
				if (match) {
					this.readyResolved = true;
					this.emit("ready", { url: match[0] } satisfies VscodeServerReadyEvent);
				}
			}
		});

		this.child.stderr?.on("data", (buf: Buffer) => {
			this.emit("stderr", buf.toString());
		});

		this.child.once("exit", (code, signal) => {
			const event: VscodeServerExitEvent = {
				code,
				signal,
				reason: signal ? "killed" : "exited",
			};
			this.child = null;
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
}
