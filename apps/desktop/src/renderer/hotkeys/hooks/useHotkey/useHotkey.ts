import { useRef } from "react";
import { type Options, useHotkeys } from "react-hotkeys-hook";
import { useVscodeFocusStore } from "renderer/stores/vscode-focus";
import { formatHotkeyDisplay } from "../../display";
import type { HotkeyId } from "../../registry";
import { PLATFORM } from "../../registry";
import type { HotkeyDisplay } from "../../types";
import { useBinding } from "../useBinding";

export function useHotkey(
	id: HotkeyId,
	callback: (e: KeyboardEvent) => void,
	options?: Options,
): HotkeyDisplay {
	const keys = useBinding(id);
	const callbackRef = useRef(callback);
	callbackRef.current = callback;
	// While an embedded VS Code WebContentsView has OS focus, the host document
	// still receives keydown events via Electron's IPC, so react-hotkeys-hook's
	// document listener would otherwise intercept shortcuts like Cmd+P before
	// VS Code sees them. Gate all Superset hotkeys until the IDE blurs.
	const isVscodeFocused = useVscodeFocusStore((s) => s.focusedPaneId !== null);
	const callerEnabled = options?.enabled;
	const enabled = isVscodeFocused ? false : (callerEnabled ?? true);
	useHotkeys(
		keys ?? "",
		(e, _h) => callbackRef.current(e),
		{
			enableOnFormTags: true,
			enableOnContentEditable: true,
			...options,
			enabled,
		},
		[keys, enabled],
	);
	return formatHotkeyDisplay(keys, PLATFORM);
}
