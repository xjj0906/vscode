/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as path from 'path';
import * as platform from 'vs/base/common/platform';
import { EDITOR_FONT_DEFAULTS, IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IWorkspaceConfigurationService } from 'vs/workbench/services/configuration/common/configuration';
import { IChoiceService } from 'vs/platform/message/common/message';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { ITerminalConfiguration, ITerminalConfigHelper, ITerminalFont, IShellLaunchConfig, IS_WORKSPACE_SHELL_ALLOWED_STORAGE_KEY, TERMINAL_CONFIG_SECTION } from 'vs/workbench/parts/terminal/common/terminal';
import { TPromise } from 'vs/base/common/winjs.base';
import Severity from 'vs/base/common/severity';
import { isFedora } from 'vs/workbench/parts/terminal/electron-browser/terminal';

const DEFAULT_LINE_HEIGHT = 1.0;

const MINIMUM_FONT_SIZE = 6;
const MAXIMUM_FONT_SIZE = 25;

/**
 * Encapsulates terminal configuration logic, the primary purpose of this file is so that platform
 * specific test cases can be written.
 */
export class TerminalConfigHelper implements ITerminalConfigHelper {
	public panelContainer: HTMLElement;

	private _charMeasureElement: HTMLElement;
	private _lastFontMeasurement: ITerminalFont;
	public config: ITerminalConfiguration;

	public constructor(
		@IConfigurationService private _configurationService: IConfigurationService,
		@IWorkspaceConfigurationService private _workspaceConfigurationService: IWorkspaceConfigurationService,
		@IChoiceService private _choiceService: IChoiceService,
		@IStorageService private _storageService: IStorageService
	) {
		this._updateConfig();
		this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(TERMINAL_CONFIG_SECTION)) {
				this._updateConfig();
			}
		});
	}

	private _updateConfig(): void {
		this.config = this._configurationService.getValue<ITerminalConfiguration>(TERMINAL_CONFIG_SECTION);
	}

	private _measureFont(fontFamily: string, fontSize: number, lineHeight: number): ITerminalFont {
		// Create charMeasureElement if it hasn't been created or if it was orphaned by its parent
		if (!this._charMeasureElement || !this._charMeasureElement.parentElement) {
			this._charMeasureElement = document.createElement('div');
			this.panelContainer.appendChild(this._charMeasureElement);
		}
		// TODO: This should leverage CharMeasure
		const style = this._charMeasureElement.style;
		style.display = 'block';
		style.fontFamily = fontFamily;
		style.fontSize = fontSize + 'px';
		style.lineHeight = 'normal';
		this._charMeasureElement.innerText = 'X';
		const rect = this._charMeasureElement.getBoundingClientRect();
		style.display = 'none';

		// Bounding client rect was invalid, use last font measurement if available.
		if (this._lastFontMeasurement && !rect.width && !rect.height) {
			return this._lastFontMeasurement;
		}

		this._lastFontMeasurement = {
			fontFamily,
			fontSize,
			lineHeight,
			charWidth: rect.width,
			charHeight: Math.ceil(rect.height)
		};
		return this._lastFontMeasurement;
	}

	/**
	 * Gets the font information based on the terminal.integrated.fontFamily
	 * terminal.integrated.fontSize, terminal.integrated.lineHeight configuration properties
	 */
	public getFont(excludeDimensions?: boolean): ITerminalFont {
		const editorConfig = this._configurationService.getValue<IEditorOptions>('editor');

		let fontFamily = this.config.fontFamily || editorConfig.fontFamily;

		// Work around bad font on Fedora
		if (!this.config.fontFamily) {
			if (isFedora) {
				fontFamily = '\'DejaVu Sans Mono\'';
			}
		}

		let fontSize = this._toInteger(this.config.fontSize, MINIMUM_FONT_SIZE, MAXIMUM_FONT_SIZE, EDITOR_FONT_DEFAULTS.fontSize);
		const lineHeight = this.config.lineHeight ? Math.max(this.config.lineHeight, 1) : DEFAULT_LINE_HEIGHT;

		if (excludeDimensions) {
			return {
				fontFamily,
				fontSize,
				lineHeight
			};
		}

		return this._measureFont(fontFamily, fontSize, lineHeight);
	}

	public setWorkspaceShellAllowed(isAllowed: boolean): void {
		this._storageService.store(IS_WORKSPACE_SHELL_ALLOWED_STORAGE_KEY, isAllowed, StorageScope.WORKSPACE);
	}

	public mergeDefaultShellPathAndArgs(shell: IShellLaunchConfig): void {
		// Check whether there is a workspace setting
		const platformKey = platform.isWindows ? 'windows' : platform.isMacintosh ? 'osx' : 'linux';
		const shellConfigValue = this._workspaceConfigurationService.inspect<string>(`terminal.integrated.shell.${platformKey}`);
		const shellArgsConfigValue = this._workspaceConfigurationService.inspect<string[]>(`terminal.integrated.shellArgs.${platformKey}`);

		// Check if workspace setting exists and whether it's whitelisted
		let isWorkspaceShellAllowed = false;
		if (shellConfigValue.workspace !== undefined || shellArgsConfigValue.workspace !== undefined) {
			isWorkspaceShellAllowed = this._storageService.getBoolean(IS_WORKSPACE_SHELL_ALLOWED_STORAGE_KEY, StorageScope.WORKSPACE, undefined);
		}

		// Check if the value is neither blacklisted (false) or whitelisted (true) and ask for
		// permission
		if (isWorkspaceShellAllowed === undefined) {
			let shellString: string;
			if (shellConfigValue.workspace) {
				shellString = `"${shellConfigValue.workspace}"`;
			}
			let argsString: string;
			if (shellArgsConfigValue.workspace) {
				argsString = `[${shellArgsConfigValue.workspace.map(v => '"' + v + '"').join(', ')}]`;
			}
			// Should not be localized as it's json-like syntax referencing settings keys
			let changeString: string;
			if (shellConfigValue.workspace !== undefined) {
				if (shellArgsConfigValue.workspace !== undefined) {
					changeString = `shell: ${shellString}, shellArgs: ${argsString}`;
				} else {
					changeString = `shell: ${shellString}`;
				}
			} else { // if (shellArgsConfigValue.workspace !== undefined)
				changeString = `shellArgs: ${argsString}`;
			}
			const message = nls.localize('terminal.integrated.allowWorkspaceShell', "Do you allow {0} (defined as a workspace setting) to be launched in the terminal?", changeString);
			const options = [nls.localize('allow', "Allow"), nls.localize('disallow', "Disallow")];
			this._choiceService.choose(Severity.Info, message, options, 1).then(choice => {
				if (choice === 0) {
					this._storageService.store(IS_WORKSPACE_SHELL_ALLOWED_STORAGE_KEY, true, StorageScope.WORKSPACE);
				} else {
					this._storageService.store(IS_WORKSPACE_SHELL_ALLOWED_STORAGE_KEY, false, StorageScope.WORKSPACE);
				}
				return TPromise.as(null);
			});
		}

		shell.executable = (isWorkspaceShellAllowed ? shellConfigValue.value : shellConfigValue.user) || shellConfigValue.default;
		shell.args = (isWorkspaceShellAllowed ? shellArgsConfigValue.value : shellArgsConfigValue.user) || shellArgsConfigValue.default;

		// Change Sysnative to System32 if the OS is Windows but NOT WoW64. It's
		// safe to assume that this was used by accident as Sysnative does not
		// exist and will break the terminal in non-WoW64 environments.
		if (platform.isWindows && !process.env.hasOwnProperty('PROCESSOR_ARCHITEW6432')) {
			const sysnativePath = path.join(process.env.windir, 'Sysnative').toLowerCase();
			if (shell.executable.toLowerCase().indexOf(sysnativePath) === 0) {
				shell.executable = path.join(process.env.windir, 'System32', shell.executable.substr(sysnativePath.length));
			}
		}
	}

	private _toInteger(source: any, minimum: number, maximum: number, fallback: number): number {
		let r = parseInt(source, 10);
		if (isNaN(r)) {
			return fallback;
		}
		if (typeof minimum === 'number') {
			r = Math.max(minimum, r);
		}
		if (typeof maximum === 'number') {
			r = Math.min(maximum, r);
		}
		return r;
	}
}
