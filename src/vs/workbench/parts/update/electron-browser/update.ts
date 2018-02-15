/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import nls = require('vs/nls');
import severity from 'vs/base/common/severity';
import { TPromise } from 'vs/base/common/winjs.base';
import { IAction, Action } from 'vs/base/common/actions';
import { IDisposable, dispose, empty as EmptyDisposable } from 'vs/base/common/lifecycle';
import { Separator } from 'vs/base/browser/ui/actionbar/actionbar';
import { IMessageService, CloseAction, Severity } from 'vs/platform/message/common/message';
import pkg from 'vs/platform/node/package';
import product from 'vs/platform/node/product';
import URI from 'vs/base/common/uri';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IActivityService, NumberBadge, IBadge, ProgressBadge } from 'vs/workbench/services/activity/common/activity';
import { IInstantiationService, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { ReleaseNotesInput } from 'vs/workbench/parts/update/electron-browser/releaseNotesInput';
import { IGlobalActivity } from 'vs/workbench/common/activity';
import { IRequestService } from 'vs/platform/request/node/request';
import { asText } from 'vs/base/node/request';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { KeybindingIO } from 'vs/workbench/services/keybinding/common/keybindingIO';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IUpdateService, State as UpdateState, StateType, IUpdate } from 'vs/platform/update/common/update';
import * as semver from 'semver';
import { OS } from 'vs/base/common/platform';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';

const NotNowAction = new Action(
	'update.later',
	nls.localize('later', "Later"),
	null,
	true,
	() => TPromise.as(true)
);

const releaseNotesCache: { [version: string]: TPromise<string>; } = Object.create(null);

export function loadReleaseNotes(accessor: ServicesAccessor, version: string): TPromise<string> {
	const requestService = accessor.get(IRequestService);
	const keybindingService = accessor.get(IKeybindingService);
	const match = /^(\d+\.\d+)\./.exec(version);

	if (!match) {
		return TPromise.wrapError<string>(new Error('not found'));
	}

	const versionLabel = match[1].replace(/\./g, '_');
	const baseUrl = 'https://code.visualstudio.com/raw';
	const url = `${baseUrl}/v${versionLabel}.md`;
	const unassigned = nls.localize('unassigned', "unassigned");

	const patchKeybindings = (text: string): string => {
		const kb = (match: string, kb: string) => {
			const keybinding = keybindingService.lookupKeybinding(kb);

			if (!keybinding) {
				return unassigned;
			}

			return keybinding.getLabel();
		};

		const kbstyle = (match: string, kb: string) => {
			const keybinding = KeybindingIO.readKeybinding(kb, OS);

			if (!keybinding) {
				return unassigned;
			}

			const resolvedKeybindings = keybindingService.resolveKeybinding(keybinding);

			if (resolvedKeybindings.length === 0) {
				return unassigned;
			}

			return resolvedKeybindings[0].getLabel();
		};

		return text
			.replace(/kb\(([a-z.\d\-]+)\)/gi, kb)
			.replace(/kbstyle\(([^\)]+)\)/gi, kbstyle);
	};

	if (!releaseNotesCache[version]) {
		releaseNotesCache[version] = requestService.request({ url })
			.then(asText)
			.then(text => patchKeybindings(text));
	}

	return releaseNotesCache[version];
}

export class OpenLatestReleaseNotesInBrowserAction extends Action {

	constructor(
		@IOpenerService private openerService: IOpenerService
	) {
		super('update.openLatestReleaseNotes', nls.localize('releaseNotes', "Release Notes"), null, true);
	}

	run(): TPromise<any> {
		const uri = URI.parse(product.releaseNotesUrl);
		return this.openerService.open(uri);
	}
}

export abstract class AbstractShowReleaseNotesAction extends Action {

	constructor(
		id: string,
		label: string,
		private version: string,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@IInstantiationService private instantiationService: IInstantiationService
	) {
		super(id, label, null, true);
	}

	run(): TPromise<boolean> {
		if (!this.enabled) {
			return TPromise.as(false);
		}

		this.enabled = false;

		return this.instantiationService.invokeFunction(loadReleaseNotes, this.version)
			.then(text => this.editorService.openEditor(this.instantiationService.createInstance(ReleaseNotesInput, this.version, text), { pinned: true }))
			.then(() => true)
			.then(null, () => {
				const action = this.instantiationService.createInstance(OpenLatestReleaseNotesInBrowserAction);
				return action.run().then(() => false);
			});
	}
}

export class ShowReleaseNotesAction extends AbstractShowReleaseNotesAction {

	constructor(
		version: string,
		@IWorkbenchEditorService editorService: IWorkbenchEditorService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super('update.showReleaseNotes', nls.localize('releaseNotes', "Release Notes"), version, editorService, instantiationService);
	}
}

export class ShowCurrentReleaseNotesAction extends AbstractShowReleaseNotesAction {

	static readonly ID = 'update.showCurrentReleaseNotes';
	static LABEL = nls.localize('showReleaseNotes', "Show Release Notes");

	constructor(
		id = ShowCurrentReleaseNotesAction.ID,
		label = ShowCurrentReleaseNotesAction.LABEL,
		@IWorkbenchEditorService editorService: IWorkbenchEditorService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super(id, label, pkg.version, editorService, instantiationService);
	}
}

const LinkAction = (id: string, message: string, licenseUrl: string) => new Action(
	id, message, null, true,
	() => { window.open(licenseUrl); return TPromise.as(null); }
);

export class ProductContribution implements IWorkbenchContribution {

	private static readonly KEY = 'releaseNotes/lastVersion';

	constructor(
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IMessageService messageService: IMessageService,
		@IWorkbenchEditorService editorService: IWorkbenchEditorService,
		@IEnvironmentService environmentService: IEnvironmentService
	) {
		const lastVersion = storageService.get(ProductContribution.KEY, StorageScope.GLOBAL, '');

		// was there an update? if so, open release notes
		if (!environmentService.skipReleaseNotes && product.releaseNotesUrl && lastVersion && pkg.version !== lastVersion) {
			instantiationService.invokeFunction(loadReleaseNotes, pkg.version).then(
				text => editorService.openEditor(instantiationService.createInstance(ReleaseNotesInput, pkg.version, text), { pinned: true }),
				() => {
					messageService.show(Severity.Info, {
						message: nls.localize('read the release notes', "Welcome to {0} v{1}! Would you like to read the Release Notes?", product.nameLong, pkg.version),
						actions: [
							instantiationService.createInstance(OpenLatestReleaseNotesInBrowserAction),
							CloseAction
						]
					});
				});
		}

		// should we show the new license?
		if (product.licenseUrl && lastVersion && semver.satisfies(lastVersion, '<1.0.0') && semver.satisfies(pkg.version, '>=1.0.0')) {
			messageService.show(Severity.Info, {
				message: nls.localize('licenseChanged', "Our license terms have changed, please go through them.", product.nameLong, pkg.version),
				actions: [
					LinkAction('update.showLicense', nls.localize('license', "Read License"), product.licenseUrl),
					CloseAction
				]
			});
		}

		storageService.store(ProductContribution.KEY, pkg.version, StorageScope.GLOBAL);
	}
}

class NeverShowAgain {

	private readonly key: string;

	readonly action = new Action(`neverShowAgain:${this.key}`, nls.localize('neveragain', "Don't Show Again"), undefined, true, () => {
		return TPromise.wrap(this.storageService.store(this.key, true, StorageScope.GLOBAL));
	});

	constructor(key: string, @IStorageService private storageService: IStorageService) {
		this.key = `neverShowAgain:${key}`;
	}

	shouldShow(): boolean {
		return !this.storageService.getBoolean(this.key, StorageScope.GLOBAL, false);
	}
}

export class Win3264BitContribution implements IWorkbenchContribution {

	private static readonly KEY = 'update/win32-64bits';
	private static readonly URL = 'https://code.visualstudio.com/updates/v1_15#_windows-64-bit';
	private static readonly INSIDER_URL = 'https://github.com/Microsoft/vscode-docs/blob/vnext/release-notes/v1_15.md#windows-64-bit';

	constructor(
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IMessageService messageService: IMessageService,
		@IWorkbenchEditorService editorService: IWorkbenchEditorService,
		@IEnvironmentService environmentService: IEnvironmentService
	) {
		if (environmentService.disableUpdates) {
			return;
		}

		const neverShowAgain = new NeverShowAgain(Win3264BitContribution.KEY, storageService);

		if (!neverShowAgain.shouldShow()) {
			return;
		}

		const url = product.quality === 'insider'
			? Win3264BitContribution.INSIDER_URL
			: Win3264BitContribution.URL;

		messageService.show(Severity.Info, {
			message: nls.localize('64bitisavailable', "{0} for 64-bit Windows is now available!", product.nameShort),
			actions: [
				LinkAction('update.show64bitreleasenotes', nls.localize('learn more', "Learn More"), url),
				neverShowAgain.action,
				CloseAction
			]
		});
	}
}

class CommandAction extends Action {

	constructor(
		commandId: string,
		label: string,
		@ICommandService commandService: ICommandService
	) {
		super(`command-action:${commandId}`, label, undefined, true, () => commandService.executeCommand(commandId));
	}
}

export class UpdateContribution implements IGlobalActivity {

	private static readonly showCommandsId = 'workbench.action.showCommands';
	private static readonly openSettingsId = 'workbench.action.openGlobalSettings';
	private static readonly openKeybindingsId = 'workbench.action.openGlobalKeybindings';
	private static readonly openUserSnippets = 'workbench.action.openSnippets';
	private static readonly selectColorThemeId = 'workbench.action.selectTheme';
	private static readonly selectIconThemeId = 'workbench.action.selectIconTheme';
	private static readonly showExtensionsId = 'workbench.view.extensions';

	get id() { return 'vs.update'; }
	get name() { return ''; }
	get cssClass() { return 'update-activity'; }

	private state: UpdateState;
	private badgeDisposable: IDisposable = EmptyDisposable;
	private disposables: IDisposable[] = [];

	constructor(
		@IStorageService private storageService: IStorageService,
		@ICommandService private commandService: ICommandService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IMessageService private messageService: IMessageService,
		@IUpdateService private updateService: IUpdateService,
		@IWorkbenchEditorService editorService: IWorkbenchEditorService,
		@IActivityService private activityService: IActivityService
	) {
		this.state = updateService.state;

		updateService.onStateChange(this.onUpdateStateChange, this, this.disposables);
		this.onUpdateStateChange(this.updateService.state);

		/*
		The `update/lastKnownVersion` and `update/updateNotificationTime` storage keys are used in
		combination to figure out when to show a message to the user that he should update.

		This message should appear if the user has received an update notification but hasn't
		updated since 5 days.
		*/

		const currentVersion = product.commit;
		const lastKnownVersion = this.storageService.get('update/lastKnownVersion', StorageScope.GLOBAL);

		// if current version != stored version, clear both fields
		if (currentVersion !== lastKnownVersion) {
			this.storageService.remove('update/lastKnownVersion', StorageScope.GLOBAL);
			this.storageService.remove('update/updateNotificationTime', StorageScope.GLOBAL);
		}
	}

	private onUpdateStateChange(state: UpdateState): void {
		switch (state.type) {
			case StateType.Idle:
				if (this.state.type === StateType.CheckingForUpdates && this.state.explicit) {
					this.onUpdateNotAvailable();
				}
				break;

			case StateType.AvailableForDownload:
				this.onUpdateAvailable(state.update);
				break;

			case StateType.Downloaded:
				this.onUpdateDownloaded(state.update);
				break;

			case StateType.Updating:
				this.onUpdateUpdating(state.update);
				break;

			case StateType.Ready:
				this.onUpdateReady(state.update);
				break;
		}

		let badge: IBadge | undefined = undefined;
		let clazz: string | undefined;

		if (state.type === StateType.AvailableForDownload || state.type === StateType.Downloaded || state.type === StateType.Ready) {
			badge = new NumberBadge(1, () => nls.localize('updateIsReady', "New {0} update available.", product.nameShort));
		} else if (state.type === StateType.CheckingForUpdates || state.type === StateType.Downloading || state.type === StateType.Updating) {
			badge = new ProgressBadge(() => nls.localize('updateIsReady', "New {0} update available.", product.nameShort));
			clazz = 'progress-badge';
		}

		this.badgeDisposable.dispose();

		if (badge) {
			this.badgeDisposable = this.activityService.showActivity(this.id, badge, clazz);
		}

		this.state = state;
	}

	private onUpdateNotAvailable(): void {
		this.messageService.show(severity.Info, nls.localize('noUpdatesAvailable', "There are no updates currently available."));
	}

	// linux
	private onUpdateAvailable(update: IUpdate): void {
		if (!this.shouldShowNotification()) {
			return;
		}

		const releaseNotesAction = this.instantiationService.createInstance(ShowReleaseNotesAction, update.productVersion);
		const downloadAction = new Action('update.downloadNow', nls.localize('download now', "Download Now"), null, true, () =>
			this.updateService.downloadUpdate());

		this.messageService.show(severity.Info, {
			message: nls.localize('thereIsUpdateAvailable', "There is an available update."),
			actions: [downloadAction, NotNowAction, releaseNotesAction]
		});
	}

	// windows fast updates
	private onUpdateDownloaded(update: IUpdate): void {
		if (!this.shouldShowNotification()) {
			return;
		}

		const releaseNotesAction = this.instantiationService.createInstance(ShowReleaseNotesAction, update.productVersion);
		const installUpdateAction = new Action('update.applyUpdate', nls.localize('installUpdate', "Install Update"), undefined, true, () =>
			this.updateService.applyUpdate());

		this.messageService.show(severity.Info, {
			message: nls.localize('updateAvailable', "There's an available update: {0} {1}", product.nameLong, update.productVersion),
			actions: [installUpdateAction, NotNowAction, releaseNotesAction]
		});
	}

	// windows fast updates
	private onUpdateUpdating(update: IUpdate): void {
		const neverShowAgain = new NeverShowAgain('update/win32-fast-updates', this.storageService);

		if (!neverShowAgain.shouldShow()) {
			return;
		}

		this.messageService.show(severity.Info, {
			message: nls.localize('updateInstalling', "{0} {1} is being installed in the background, we'll let you know when it's done.", product.nameLong, update.productVersion),
			actions: [neverShowAgain.action, CloseAction]
		});
	}

	// windows and mac
	private onUpdateReady(update: IUpdate): void {
		if (!this.shouldShowNotification()) {
			return;
		}

		const releaseNotesAction = this.instantiationService.createInstance(ShowReleaseNotesAction, update.productVersion);
		const applyUpdateAction = new Action('update.applyUpdate', nls.localize('updateNow', "Update Now"), undefined, true, () =>
			this.updateService.quitAndInstall());

		this.messageService.show(severity.Info, {
			message: nls.localize('updateAvailableAfterRestart', "{0} will be updated after it restarts.", product.nameLong),
			actions: [applyUpdateAction, NotNowAction, releaseNotesAction]
		});
	}

	private shouldShowNotification(): boolean {
		const currentVersion = product.commit;
		const currentMillis = new Date().getTime();
		const lastKnownVersion = this.storageService.get('update/lastKnownVersion', StorageScope.GLOBAL);

		// if version != stored version, save version and date
		if (currentVersion !== lastKnownVersion) {
			this.storageService.store('update/lastKnownVersion', currentVersion, StorageScope.GLOBAL);
			this.storageService.store('update/updateNotificationTime', currentMillis, StorageScope.GLOBAL);
		}

		const updateNotificationMillis = this.storageService.getInteger('update/updateNotificationTime', StorageScope.GLOBAL, currentMillis);
		const diffDays = (currentMillis - updateNotificationMillis) / (1000 * 60 * 60 * 24);

		return diffDays > 5;
	}

	getActions(): IAction[] {
		const result: IAction[] = [
			new CommandAction(UpdateContribution.showCommandsId, nls.localize('commandPalette', "Command Palette..."), this.commandService),
			new Separator(),
			new CommandAction(UpdateContribution.openSettingsId, nls.localize('settings', "Settings"), this.commandService),
			new CommandAction(UpdateContribution.openKeybindingsId, nls.localize('keyboardShortcuts', "Keyboard Shortcuts"), this.commandService),
			new CommandAction(UpdateContribution.showExtensionsId, nls.localize('showExtensions', "Manage Extensions"), this.commandService),
			new Separator(),
			new CommandAction(UpdateContribution.openUserSnippets, nls.localize('userSnippets', "User Snippets"), this.commandService),
			new Separator(),
			new CommandAction(UpdateContribution.selectColorThemeId, nls.localize('selectTheme.label', "Color Theme"), this.commandService),
			new CommandAction(UpdateContribution.selectIconThemeId, nls.localize('themes.selectIconTheme.label', "File Icon Theme"), this.commandService)
		];

		const updateAction = this.getUpdateAction();

		if (updateAction) {
			result.push(new Separator(), updateAction);
		}

		return result;
	}

	private getUpdateAction(): IAction | null {
		const state = this.updateService.state;

		switch (state.type) {
			case StateType.Uninitialized:
				return null;

			case StateType.Idle:
				return new Action('update.check', nls.localize('checkForUpdates', "Check for Updates..."), undefined, true, () =>
					this.updateService.checkForUpdates(true));

			case StateType.CheckingForUpdates:
				return new Action('update.checking', nls.localize('checkingForUpdates', "Checking For Updates..."), undefined, false);

			case StateType.AvailableForDownload:
				return new Action('update.downloadNow', nls.localize('download now', "Download Now"), null, true, () =>
					this.updateService.downloadUpdate());

			case StateType.Downloading:
				return new Action('update.downloading', nls.localize('DownloadingUpdate', "Downloading Update..."), undefined, false);

			case StateType.Downloaded:
				return new Action('update.install', nls.localize('installUpdate...', "Install Update..."), undefined, true, () =>
					this.updateService.applyUpdate());

			case StateType.Updating:
				return new Action('update.updating', nls.localize('installingUpdate', "Installing Update..."), undefined, false);

			case StateType.Ready:
				return new Action('update.restart', nls.localize('restartToUpdate', "Restart to Update..."), undefined, true, () =>
					this.updateService.quitAndInstall());
		}
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
	}
}