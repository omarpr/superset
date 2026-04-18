import { describe, expect, it, mock } from "bun:test";
import { reclaimOrphanServer } from "./reclaim-orphan-server";

function makeDeps(
	overrides: Partial<{
		pidFileContents: string | null;
		alive: boolean;
		command: string | null;
	}> = {},
) {
	const pidFileContents: string | null =
		"pidFileContents" in overrides
			? (overrides.pidFileContents ?? null)
			: "4242";
	const alive = overrides.alive ?? true;
	const command: string | null =
		"command" in overrides
			? (overrides.command ?? null)
			: "/usr/local/bin/code serve-web --port 51851";
	const readPidFile = mock((): string | null => pidFileContents);
	const deletePidFile = mock(() => {});
	const isProcessAlive = mock((): boolean => alive);
	const getProcessCommand = mock((): string | null => command);
	const kill = mock((_pid: number) => {});
	return {
		deps: {
			pidFilePath: "/tmp/fake.pid",
			readPidFile,
			deletePidFile,
			isProcessAlive,
			getProcessCommand,
			kill,
		},
		readPidFile,
		deletePidFile,
		isProcessAlive,
		getProcessCommand,
		kill,
	};
}

describe("reclaimOrphanServer", () => {
	it("kills a live matching process and removes the PID file", () => {
		const { deps, kill, deletePidFile } = makeDeps();
		const result = reclaimOrphanServer(deps);
		expect(result).toBe(true);
		expect(kill).toHaveBeenCalledTimes(1);
		expect(kill.mock.calls.at(0)?.[0]).toBe(4242);
		expect(deletePidFile).toHaveBeenCalledTimes(1);
	});

	it("does nothing when the PID file is missing", () => {
		const { deps, kill, deletePidFile, isProcessAlive } = makeDeps({
			pidFileContents: null,
		});
		expect(reclaimOrphanServer(deps)).toBe(false);
		expect(kill).not.toHaveBeenCalled();
		expect(deletePidFile).not.toHaveBeenCalled();
		expect(isProcessAlive).not.toHaveBeenCalled();
	});

	it("clears a stale PID file without killing when the process is gone", () => {
		const { deps, kill, deletePidFile } = makeDeps({ alive: false });
		expect(reclaimOrphanServer(deps)).toBe(false);
		expect(kill).not.toHaveBeenCalled();
		expect(deletePidFile).toHaveBeenCalledTimes(1);
	});

	it("refuses to kill a recycled PID whose command lacks the marker", () => {
		// Real-world: PID was reused by a completely unrelated process like
		// a shell or editor. Signalling it would be disastrous.
		const { deps, kill, deletePidFile } = makeDeps({ command: "/bin/zsh" });
		expect(reclaimOrphanServer(deps)).toBe(false);
		expect(kill).not.toHaveBeenCalled();
		expect(deletePidFile).toHaveBeenCalledTimes(1);
	});

	it("treats unparseable PID file contents as stale", () => {
		const { deps, kill, deletePidFile } = makeDeps({
			pidFileContents: "not-a-number",
		});
		expect(reclaimOrphanServer(deps)).toBe(false);
		expect(kill).not.toHaveBeenCalled();
		expect(deletePidFile).toHaveBeenCalledTimes(1);
	});

	it("ignores a PID of 0 or negative", () => {
		const { deps, kill, deletePidFile } = makeDeps({
			pidFileContents: "0",
		});
		expect(reclaimOrphanServer(deps)).toBe(false);
		expect(kill).not.toHaveBeenCalled();
		expect(deletePidFile).toHaveBeenCalledTimes(1);
	});

	it("honours a custom commandMarker", () => {
		const { deps, kill } = makeDeps({ command: "custom-binary --flag" });
		const result = reclaimOrphanServer({
			...deps,
			commandMarker: "custom-binary",
		});
		expect(result).toBe(true);
		expect(kill).toHaveBeenCalledTimes(1);
	});
});
