import type { ExternalApp } from "@superset/local-db";
import { useParams } from "@tanstack/react-router";
import {
	DEFAULT_SIDEBAR_WIDTH,
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	SidebarMode,
	useSidebarStore,
} from "renderer/stores/sidebar-state";
import { useTabsStore } from "renderer/stores/tabs/store";
import { extractPaneIdsFromLayout } from "renderer/stores/tabs/utils";
import { ResizablePanel } from "../../ResizablePanel";
import { ChangesContent, ScrollProvider } from "../ChangesContent";
import { ContentView } from "../ContentView";
import { useBrowserLifecycle } from "../hooks/useBrowserLifecycle";
import { RightSidebar } from "../RightSidebar";

interface WorkspaceLayoutProps {
	defaultExternalApp?: ExternalApp | null;
	onOpenInApp: () => void;
	onOpenQuickOpen: () => void;
}

export function WorkspaceLayout({
	defaultExternalApp,
	onOpenInApp,
	onOpenQuickOpen,
}: WorkspaceLayoutProps) {
	useBrowserLifecycle();
	const { workspaceId } = useParams({ strict: false });
	const isSidebarOpen = useSidebarStore((s) => s.isSidebarOpen);
	const sidebarWidth = useSidebarStore((s) => s.sidebarWidth);
	const setSidebarWidth = useSidebarStore((s) => s.setSidebarWidth);
	const isResizing = useSidebarStore((s) => s.isResizing);
	const setIsResizing = useSidebarStore((s) => s.setIsResizing);
	const currentMode = useSidebarStore((s) => s.currentMode);

	const isExpanded = currentMode === SidebarMode.Changes;

	// VS Code has its own file explorer + source-control panel, so the right
	// sidebar is redundant when a VS Code tab is active. Suppress it without
	// mutating persisted sidebar state so switching tabs restores the panel.
	const hasActiveVscodeTab = useTabsStore((s) => {
		if (!workspaceId) return false;
		const activeTabId = s.activeTabIds[workspaceId];
		if (!activeTabId) return false;
		const tab = s.tabs.find((t) => t.id === activeTabId);
		if (!tab) return false;
		for (const paneId of extractPaneIdsFromLayout(tab.layout)) {
			if (s.panes[paneId]?.type === "vscode") return true;
		}
		return false;
	});
	const showRightSidebar = isSidebarOpen && !hasActiveVscodeTab;

	return (
		<ScrollProvider>
			<div className="flex-1 min-w-0 overflow-hidden">
				{isExpanded ? (
					<ChangesContent />
				) : (
					<ContentView
						defaultExternalApp={defaultExternalApp}
						onOpenInApp={onOpenInApp}
						onOpenQuickOpen={onOpenQuickOpen}
					/>
				)}
			</div>
			{showRightSidebar && (
				<ResizablePanel
					width={sidebarWidth}
					onWidthChange={setSidebarWidth}
					isResizing={isResizing}
					onResizingChange={setIsResizing}
					minWidth={MIN_SIDEBAR_WIDTH}
					maxWidth={MAX_SIDEBAR_WIDTH}
					handleSide="left"
					className={isExpanded ? "border-l-0" : undefined}
					onDoubleClickHandle={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
				>
					<RightSidebar />
				</ResizablePanel>
			)}
		</ScrollProvider>
	);
}
