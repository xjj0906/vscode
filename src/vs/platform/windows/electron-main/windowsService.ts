/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as nls from 'vs/nls';
import { TPromise } from 'vs/base/common/winjs.base';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { assign } from 'vs/base/common/objects';
import URI from 'vs/base/common/uri';
import product from 'vs/platform/node/product';
import { IWindowsService, OpenContext, INativeOpenDialogOptions, IEnterWorkspaceResult, IMessageBoxResult } from 'vs/platform/windows/common/windows';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { shell, crashReporter, app, Menu, clipboard } from 'electron';
import Event, { chain, fromNodeEventEmitter } from 'vs/base/common/event';
import { IURLService } from 'vs/platform/url/common/url';
import { ILifecycleService } from 'vs/platform/lifecycle/electron-main/lifecycleMain';
import { IWindowsMainService, ISharedProcess } from 'vs/platform/windows/electron-main/windows';
import { IHistoryMainService, IRecentlyOpened } from 'vs/platform/history/common/history';
import { IWorkspaceIdentifier, IWorkspaceFolderCreationData } from 'vs/platform/workspaces/common/workspaces';
import { ICommandAction } from 'vs/platform/actions/common/actions';
import { Schemas } from 'vs/base/common/network';
import { mnemonicButtonLabel } from 'vs/base/common/labels';
import { isWindows } from 'vs/base/common/platform';

export class WindowsService implements IWindowsService, IDisposable {

	_serviceBrand: any;

	private disposables: IDisposable[] = [];

	readonly onWindowOpen: Event<number> = fromNodeEventEmitter(app, 'browser-window-created', (_, w: Electron.BrowserWindow) => w.id);
	readonly onWindowFocus: Event<number> = fromNodeEventEmitter(app, 'browser-window-focus', (_, w: Electron.BrowserWindow) => w.id);
	readonly onWindowBlur: Event<number> = fromNodeEventEmitter(app, 'browser-window-blur', (_, w: Electron.BrowserWindow) => w.id);

	constructor(
		private sharedProcess: ISharedProcess,
		@IWindowsMainService private windowsMainService: IWindowsMainService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@IURLService urlService: IURLService,
		@ILifecycleService private lifecycleService: ILifecycleService,
		@IHistoryMainService private historyService: IHistoryMainService
	) {
		// Catch file URLs
		chain(urlService.onOpenURL)
			.filter(uri => uri.authority === Schemas.file && !!uri.path)
			.map(uri => URI.file(uri.fsPath))
			.on(this.openFileForURI, this, this.disposables);

		// Catch extension URLs when there are no windows open
		chain(urlService.onOpenURL)
			.filter(uri => /^extension/.test(uri.path))
			.filter(() => this.windowsMainService.getWindowCount() === 0)
			.on(this.openExtensionForURI, this, this.disposables);
	}

	pickFileFolderAndOpen(options: INativeOpenDialogOptions): TPromise<void> {
		this.windowsMainService.pickFileFolderAndOpen(options);

		return TPromise.as(null);
	}

	pickFileAndOpen(options: INativeOpenDialogOptions): TPromise<void> {
		this.windowsMainService.pickFileAndOpen(options);

		return TPromise.as(null);
	}

	pickFolderAndOpen(options: INativeOpenDialogOptions): TPromise<void> {
		this.windowsMainService.pickFolderAndOpen(options);

		return TPromise.as(null);
	}

	pickWorkspaceAndOpen(options: INativeOpenDialogOptions): TPromise<void> {
		this.windowsMainService.pickWorkspaceAndOpen(options);

		return TPromise.as(null);
	}

	showMessageBox(windowId: number, options: Electron.MessageBoxOptions): TPromise<IMessageBoxResult> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		return this.windowsMainService.showMessageBox(options, codeWindow);
	}

	showSaveDialog(windowId: number, options: Electron.SaveDialogOptions): TPromise<string> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		return this.windowsMainService.showSaveDialog(options, codeWindow);
	}

	showOpenDialog(windowId: number, options: Electron.OpenDialogOptions): TPromise<string[]> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		return this.windowsMainService.showOpenDialog(options, codeWindow);
	}

	reloadWindow(windowId: number): TPromise<void> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			this.windowsMainService.reload(codeWindow);
		}

		return TPromise.as(null);
	}

	openDevTools(windowId: number): TPromise<void> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			codeWindow.win.webContents.openDevTools();
		}

		return TPromise.as(null);
	}

	toggleDevTools(windowId: number): TPromise<void> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			const contents = codeWindow.win.webContents;
			if (codeWindow.hasHiddenTitleBarStyle() && !codeWindow.win.isFullScreen() && !contents.isDevToolsOpened()) {
				contents.openDevTools({ mode: 'undocked' }); // due to https://github.com/electron/electron/issues/3647
			} else {
				contents.toggleDevTools();
			}
		}

		return TPromise.as(null);
	}

	updateTouchBar(windowId: number, items: ICommandAction[][]): TPromise<void> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			codeWindow.updateTouchBar(items);
		}

		return TPromise.as(null);
	}

	closeWorkspace(windowId: number): TPromise<void> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			this.windowsMainService.closeWorkspace(codeWindow);
		}

		return TPromise.as(null);
	}

	createAndEnterWorkspace(windowId: number, folders?: IWorkspaceFolderCreationData[], path?: string): TPromise<IEnterWorkspaceResult> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			return this.windowsMainService.createAndEnterWorkspace(codeWindow, folders, path);
		}

		return TPromise.as(null);
	}

	saveAndEnterWorkspace(windowId: number, path: string): TPromise<IEnterWorkspaceResult> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			return this.windowsMainService.saveAndEnterWorkspace(codeWindow, path);
		}

		return TPromise.as(null);
	}

	toggleFullScreen(windowId: number): TPromise<void> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			codeWindow.toggleFullScreen();
		}

		return TPromise.as(null);
	}

	setRepresentedFilename(windowId: number, fileName: string): TPromise<void> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			codeWindow.setRepresentedFilename(fileName);
		}

		return TPromise.as(null);
	}

	addRecentlyOpened(files: string[]): TPromise<void> {
		this.historyService.addRecentlyOpened(void 0, files);

		return TPromise.as(null);
	}

	removeFromRecentlyOpened(paths: string[]): TPromise<void> {
		this.historyService.removeFromRecentlyOpened(paths);

		return TPromise.as(null);
	}

	clearRecentlyOpened(): TPromise<void> {
		this.historyService.clearRecentlyOpened();

		return TPromise.as(null);
	}

	getRecentlyOpened(windowId: number): TPromise<IRecentlyOpened> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			return TPromise.as(this.historyService.getRecentlyOpened(codeWindow.config.workspace || codeWindow.config.folderPath, codeWindow.config.filesToOpen));
		}

		return TPromise.as(this.historyService.getRecentlyOpened());
	}

	showPreviousWindowTab(): TPromise<void> {
		Menu.sendActionToFirstResponder('selectPreviousTab:');

		return TPromise.as(void 0);
	}

	showNextWindowTab(): TPromise<void> {
		Menu.sendActionToFirstResponder('selectNextTab:');

		return TPromise.as(void 0);
	}

	moveWindowTabToNewWindow(): TPromise<void> {
		Menu.sendActionToFirstResponder('moveTabToNewWindow:');

		return TPromise.as(void 0);
	}

	mergeAllWindowTabs(): TPromise<void> {
		Menu.sendActionToFirstResponder('mergeAllWindows:');

		return TPromise.as(void 0);
	}

	toggleWindowTabsBar(): TPromise<void> {
		Menu.sendActionToFirstResponder('toggleTabBar:');

		return TPromise.as(void 0);
	}

	focusWindow(windowId: number): TPromise<void> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			codeWindow.win.focus();
		}

		return TPromise.as(null);
	}

	closeWindow(windowId: number): TPromise<void> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			codeWindow.win.close();
		}

		return TPromise.as(null);
	}

	isFocused(windowId: number): TPromise<boolean> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			return TPromise.as(codeWindow.win.isFocused());
		}

		return TPromise.as(null);
	}

	isMaximized(windowId: number): TPromise<boolean> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			return TPromise.as(codeWindow.win.isMaximized());
		}

		return TPromise.as(null);
	}

	maximizeWindow(windowId: number): TPromise<void> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			codeWindow.win.maximize();
		}

		return TPromise.as(null);
	}

	unmaximizeWindow(windowId: number): TPromise<void> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			codeWindow.win.unmaximize();
		}

		return TPromise.as(null);
	}

	onWindowTitleDoubleClick(windowId: number): TPromise<void> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			codeWindow.onWindowTitleDoubleClick();
		}

		return TPromise.as(null);
	}

	setDocumentEdited(windowId: number, flag: boolean): TPromise<void> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow && codeWindow.win.isDocumentEdited() !== flag) {
			codeWindow.win.setDocumentEdited(flag);
		}

		return TPromise.as(null);
	}

	openWindow(paths: string[], options?: { forceNewWindow?: boolean, forceReuseWindow?: boolean, forceOpenWorkspaceAsFile?: boolean }): TPromise<void> {
		if (!paths || !paths.length) {
			return TPromise.as(null);
		}

		this.windowsMainService.open({
			context: OpenContext.API,
			cli: this.environmentService.args,
			pathsToOpen: paths,
			forceNewWindow: options && options.forceNewWindow,
			forceReuseWindow: options && options.forceReuseWindow,
			forceOpenWorkspaceAsFile: options && options.forceOpenWorkspaceAsFile
		});

		return TPromise.as(null);
	}

	openNewWindow(): TPromise<void> {
		this.windowsMainService.openNewWindow(OpenContext.API);
		return TPromise.as(null);
	}

	showWindow(windowId: number): TPromise<void> {
		const codeWindow = this.windowsMainService.getWindowById(windowId);

		if (codeWindow) {
			codeWindow.win.show();
		}

		return TPromise.as(null);
	}

	getWindows(): TPromise<{ id: number; workspace?: IWorkspaceIdentifier; folderPath?: string; title: string; filename?: string; }[]> {
		const windows = this.windowsMainService.getWindows();
		const result = windows.map(w => ({ id: w.id, workspace: w.openedWorkspace, openedFolderPath: w.openedFolderPath, title: w.win.getTitle(), filename: w.getRepresentedFilename() }));

		return TPromise.as(result);
	}

	getWindowCount(): TPromise<number> {
		return TPromise.as(this.windowsMainService.getWindows().length);
	}

	log(severity: string, ...messages: string[]): TPromise<void> {
		console[severity].apply(console, ...messages);
		return TPromise.as(null);
	}

	showItemInFolder(path: string): TPromise<void> {
		shell.showItemInFolder(path);
		return TPromise.as(null);
	}

	openExternal(url: string): TPromise<boolean> {
		return TPromise.as(shell.openExternal(url));
	}

	startCrashReporter(config: Electron.CrashReporterStartOptions): TPromise<void> {
		crashReporter.start(config);
		return TPromise.as(null);
	}

	quit(): TPromise<void> {
		this.windowsMainService.quit();
		return TPromise.as(null);
	}

	relaunch(options: { addArgs?: string[], removeArgs?: string[] }): TPromise<void> {
		this.lifecycleService.relaunch(options);

		return TPromise.as(null);
	}

	whenSharedProcessReady(): TPromise<void> {
		return this.sharedProcess.whenReady();
	}

	toggleSharedProcess(): TPromise<void> {
		this.sharedProcess.toggle();
		return TPromise.as(null);
	}

	openAboutDialog(): TPromise<void> {
		const lastActiveWindow = this.windowsMainService.getFocusedWindow() || this.windowsMainService.getLastActiveWindow();

		const detail = nls.localize('aboutDetail',
			"Version {0}\nCommit {1}\nDate {2}\nShell {3}\nRenderer {4}\nNode {5}\nArchitecture {6}",
			app.getVersion(),
			product.commit || 'Unknown',
			product.date || 'Unknown',
			process.versions['electron'],
			process.versions['chrome'],
			process.versions['node'],
			process.arch
		);

		const buttons = [nls.localize('okButton', "OK")];
		if (isWindows) {
			buttons.push(mnemonicButtonLabel(nls.localize({ key: 'copy', comment: ['&& denotes a mnemonic'] }, "&&Copy"))); // https://github.com/Microsoft/vscode/issues/37608
		}

		this.windowsMainService.showMessageBox({
			title: product.nameLong,
			type: 'info',
			message: product.nameLong,
			detail: `\n${detail}`,
			buttons,
			noLink: true
		}, lastActiveWindow).then(result => {
			if (isWindows && result.button === 1) {
				clipboard.writeText(detail);
			}
		});

		return TPromise.as(null);
	}

	private openFileForURI(uri: URI): TPromise<void> {
		const cli = assign(Object.create(null), this.environmentService.args, { goto: true });
		const pathsToOpen = [uri.fsPath];

		this.windowsMainService.open({ context: OpenContext.API, cli, pathsToOpen });
		return TPromise.as(null);
	}

	/**
	 * This should only fire whenever an extension URL is open
	 * and there are no windows to handle it.
	 */
	private async openExtensionForURI(uri: URI): TPromise<void> {
		const cli = assign(Object.create(null), this.environmentService.args);
		const window = await this.windowsMainService.open({ context: OpenContext.API, cli })[0];

		if (!window) {
			return;
		}

		window.win.show();
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
	}
}