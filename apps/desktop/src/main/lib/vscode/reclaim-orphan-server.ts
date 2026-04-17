import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";

export interface ReclaimOrphanDeps {
	pidFilePath: string;
	readPidFile?: () => string | null;
	deletePidFile?: () => void;
	isProcessAlive?: (pid: number) => boolean;
	getProcessCommand?: (pid: number) => string | null;
	kill?: (pid: number) => void;
	/** Substring that must appear in the process command for a kill to be safe. */
	commandMarker?: string;
}

/**
 * Reclaims an orphaned `code serve-web` child from a prior main-process
 * lifetime. Dev hot-reload or an Electron crash can leave the server running;
 * when that happens it still holds the pinned port, forcing the next launch
 * to pick a different one — which changes the origin and wipes IndexedDB-
 * backed VS Code UI state.
 *
 * Returns true if a matching process was killed.
 *
 * Safe against PID reuse: verifies the live process's command line contains
 * the marker substring before signalling. If the marker is missing, the PID
 * belongs to an unrelated process and the function silently clears the
 * stale file without killing.
 */
export function reclaimOrphanServer(deps: ReclaimOrphanDeps): boolean {
	const pidFilePath = deps.pidFilePath;
	const readPidFile =
		deps.readPidFile ??
		(() => {
			try {
				return readFileSync(pidFilePath, "utf8");
			} catch {
				return null;
			}
		});
	const deletePidFile =
		deps.deletePidFile ??
		(() => {
			try {
				unlinkSync(pidFilePath);
			} catch {
				// already gone
			}
		});
	const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
	const getProcessCommand = deps.getProcessCommand ?? defaultGetProcessCommand;
	const kill = deps.kill ?? defaultKill;
	const marker = deps.commandMarker ?? "serve-web";

	const raw = readPidFile();
	if (!raw) return false;
	const pid = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(pid) || pid <= 0) {
		deletePidFile();
		return false;
	}
	if (!isProcessAlive(pid)) {
		deletePidFile();
		return false;
	}
	const cmd = getProcessCommand(pid);
	if (!cmd || !cmd.includes(marker)) {
		// PID was recycled by an unrelated process — don't signal it.
		deletePidFile();
		return false;
	}
	kill(pid);
	deletePidFile();
	return true;
}

function defaultIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function defaultGetProcessCommand(pid: number): string | null {
	try {
		const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.trim() || null;
	} catch {
		return null;
	}
}

function defaultKill(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// already exited
	}
}
