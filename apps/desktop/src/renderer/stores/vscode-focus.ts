import { create } from "zustand";

/**
 * Tracks the paneId of whichever embedded VS Code WebContentsView currently
 * owns OS-level keyboard focus. Populated from the main process's focus/blur
 * events on each WebContentsView's webContents (see `vscode-manager.ts`).
 *
 * `useHotkey` reads this to gate Superset hotkeys: while VS Code has OS focus,
 * the host `document` still receives keydown events (that's how Electron
 * surfaces them to the renderer), so `react-hotkeys-hook` would otherwise
 * intercept Cmd+P before the IDE sees it.
 */
interface VscodeFocusState {
	focusedPaneId: string | null;
	setFocused: (paneId: string, focused: boolean) => void;
	clearPane: (paneId: string) => void;
}

export const useVscodeFocusStore = create<VscodeFocusState>((set) => ({
	focusedPaneId: null,
	setFocused: (paneId, focused) =>
		set((s) => {
			if (focused) return { focusedPaneId: paneId };
			if (s.focusedPaneId === paneId) return { focusedPaneId: null };
			return s;
		}),
	clearPane: (paneId) =>
		set((s) => (s.focusedPaneId === paneId ? { focusedPaneId: null } : s)),
}));
