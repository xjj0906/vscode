/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as nls from 'vs/nls';
import * as env from 'vs/base/common/platform';
import { Registry } from 'vs/platform/registry/common/platform';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import paths = require('vs/base/common/paths');
import uri from 'vs/base/common/uri';
import { ITerminalService } from 'vs/workbench/parts/execution/common/execution';
import { MenuId, MenuRegistry } from 'vs/platform/actions/common/actions';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { KeyMod, KeyCode } from 'vs/base/common/keyCodes';
import { Extensions, IConfigurationRegistry } from 'vs/platform/configuration/common/configurationRegistry';
import { ITerminalService as IIntegratedTerminalService, KEYBINDING_CONTEXT_TERMINAL_NOT_FOCUSED } from 'vs/workbench/parts/terminal/common/terminal';
import { DEFAULT_TERMINAL_WINDOWS, DEFAULT_TERMINAL_LINUX_READY, DEFAULT_TERMINAL_OSX, ITerminalConfiguration } from 'vs/workbench/parts/execution/electron-browser/terminal';
import { WinTerminalService, MacTerminalService, LinuxTerminalService } from 'vs/workbench/parts/execution/electron-browser/terminalService';
import { IHistoryService } from 'vs/workbench/services/history/common/history';
import { ResourceContextKey } from 'vs/workbench/common/resources';
import { KeybindingsRegistry } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { IFileService } from 'vs/platform/files/common/files';
import { IListService } from 'vs/platform/list/browser/listService';
import { getResourceForCommand } from 'vs/workbench/parts/files/browser/files';
import { CommandsRegistry } from 'vs/platform/commands/common/commands';
import { Schemas } from 'vs/base/common/network';

if (env.isWindows) {
	registerSingleton(ITerminalService, WinTerminalService);
} else if (env.isMacintosh) {
	registerSingleton(ITerminalService, MacTerminalService);
} else if (env.isLinux) {
	registerSingleton(ITerminalService, LinuxTerminalService);
}

DEFAULT_TERMINAL_LINUX_READY.then(defaultTerminalLinux => {
	let configurationRegistry = <IConfigurationRegistry>Registry.as(Extensions.Configuration);
	configurationRegistry.registerConfiguration({
		'id': 'externalTerminal',
		'order': 100,
		'title': nls.localize('terminalConfigurationTitle', "External Terminal"),
		'type': 'object',
		'properties': {
			'terminal.explorerKind': {
				'type': 'string',
				'enum': [
					'integrated',
					'external'
				],
				'description': nls.localize('explorer.openInTerminalKind', "Customizes what kind of terminal to launch."),
				'default': 'integrated',
				'isExecutable': false
			},
			'terminal.external.windowsExec': {
				'type': 'string',
				'description': nls.localize('terminal.external.windowsExec', "Customizes which terminal to run on Windows."),
				'default': DEFAULT_TERMINAL_WINDOWS,
				'isExecutable': true
			},
			'terminal.external.osxExec': {
				'type': 'string',
				'description': nls.localize('terminal.external.osxExec', "Customizes which terminal application to run on OS X."),
				'default': DEFAULT_TERMINAL_OSX,
				'isExecutable': true
			},
			'terminal.external.linuxExec': {
				'type': 'string',
				'description': nls.localize('terminal.external.linuxExec', "Customizes which terminal to run on Linux."),
				'default': defaultTerminalLinux,
				'isExecutable': true
			}
		}
	});
});

const OPEN_IN_TERMINAL_COMMAND_ID = 'openInTerminal';
CommandsRegistry.registerCommand({
	id: OPEN_IN_TERMINAL_COMMAND_ID,
	handler: (accessor, resource: uri) => {
		const configurationService = accessor.get(IConfigurationService);
		const editorService = accessor.get(IWorkbenchEditorService);
		const fileService = accessor.get(IFileService);
		const integratedTerminalService = accessor.get(IIntegratedTerminalService);
		const terminalService = accessor.get(ITerminalService);
		resource = getResourceForCommand(resource, accessor.get(IListService), editorService);

		return fileService.resolveFile(resource).then(stat => {
			return stat.isDirectory ? stat.resource.fsPath : paths.dirname(stat.resource.fsPath);
		}).then(directoryToOpen => {
			if (configurationService.getValue<ITerminalConfiguration>().terminal.explorerKind === 'integrated') {
				const instance = integratedTerminalService.createInstance({ cwd: directoryToOpen }, true);
				if (instance) {
					integratedTerminalService.setActiveInstance(instance);
					integratedTerminalService.showPanel(true);
				}
			} else {
				terminalService.openTerminal(directoryToOpen);
			}
		});
	}
});

const OPEN_NATIVE_CONSOLE_COMMAND_ID = 'workbench.action.terminal.openNativeConsole';
KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: OPEN_NATIVE_CONSOLE_COMMAND_ID,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KEY_C,
	when: KEYBINDING_CONTEXT_TERMINAL_NOT_FOCUSED,
	weight: KeybindingsRegistry.WEIGHT.workbenchContrib(),
	handler: (accessor) => {
		const historyService = accessor.get(IHistoryService);
		const terminalService = accessor.get(ITerminalService);
		const root = historyService.getLastActiveWorkspaceRoot(Schemas.file);
		if (root) {
			terminalService.openTerminal(root.fsPath);
		}
	}
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: {
		id: OPEN_NATIVE_CONSOLE_COMMAND_ID,
		title: env.isWindows ? nls.localize('globalConsoleActionWin', "Open New Command Prompt") :
			nls.localize('globalConsoleActionMacLinux', "Open New Terminal")
	}
});

const openConsoleCommand = {
	id: OPEN_IN_TERMINAL_COMMAND_ID,
	title: env.isWindows ? nls.localize('scopedConsoleActionWin', "Open in Command Prompt") :
		nls.localize('scopedConsoleActionMacLinux', "Open in Terminal")
};
MenuRegistry.appendMenuItem(MenuId.OpenEditorsContext, {
	group: 'navigation',
	order: 30,
	command: openConsoleCommand,
	when: ResourceContextKey.Scheme.isEqualTo(Schemas.file)
});

MenuRegistry.appendMenuItem(MenuId.ExplorerContext, {
	group: 'navigation',
	order: 30,
	command: openConsoleCommand,
	when: ResourceContextKey.Scheme.isEqualTo(Schemas.file)
});
