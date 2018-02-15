/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { clipboard } from 'electron';
import { Marker } from 'vs/workbench/parts/markers/common/markersModel';
import Constants from 'vs/workbench/parts/markers/common/constants';
import { CommandsRegistry, ICommandHandler } from 'vs/platform/commands/common/commands';
import { MenuId, MenuRegistry } from 'vs/platform/actions/common/actions';
import { ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { KeybindingsRegistry, IKeybindings } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { IPanelService } from 'vs/workbench/services/panel/common/panelService';
import { MarkersPanel } from 'vs/workbench/parts/markers/browser/markersPanel';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';


export function registerContributions(): void {
	registerAction({
		id: Constants.MARKER_COPY_ACTION_ID,
		title: localize('copyMarker', "Copy"),
		handler(accessor) {
			copyMarker(accessor.get(IPanelService));
		},
		menu: {
			menuId: MenuId.ProblemsPanelContext,
			when: Constants.MarkerFocusContextKey,
			group: 'navigation'
		},
		keybinding: {
			keys: {
				primary: KeyMod.CtrlCmd | KeyCode.KEY_C
			},
			when: Constants.MarkerFocusContextKey
		}
	});
	registerAction({
		id: Constants.MARKER_COPY_MESSAGE_ACTION_ID,
		title: localize('copyMarkerMessage', "Copy Message"),
		handler(accessor) {
			copyMessage(accessor.get(IPanelService));
		},
		menu: {
			menuId: MenuId.ProblemsPanelContext,
			when: Constants.MarkerFocusContextKey,
			group: 'navigation'
		}
	});
}

function copyMarker(panelService: IPanelService) {
	const activePanel = panelService.getActivePanel();
	if (activePanel instanceof MarkersPanel) {
		const element = (<MarkersPanel>activePanel).getFocusElement();
		if (element instanceof Marker) {
			clipboard.writeText(`${element}`);
		}
	}
}

function copyMessage(panelService: IPanelService) {
	const activePanel = panelService.getActivePanel();
	if (activePanel instanceof MarkersPanel) {
		const element = (<MarkersPanel>activePanel).getFocusElement();
		if (element instanceof Marker) {
			clipboard.writeText(element.marker.message);
		}
	}
}

interface IActionDescriptor {
	id: string;
	handler: ICommandHandler;

	// ICommandUI
	title: string;
	category?: string;
	f1?: boolean;

	//
	menu?: {
		menuId: MenuId,
		when?: ContextKeyExpr;
		group?: string;
	};

	//
	keybinding?: {
		when?: ContextKeyExpr;
		weight?: number;
		keys: IKeybindings;
	};
}

function registerAction(desc: IActionDescriptor) {

	const { id, handler, title, category, menu, keybinding } = desc;

	// 1) register as command
	CommandsRegistry.registerCommand(id, handler);

	// 2) menus
	let command = { id, title, category };
	if (menu) {
		let { menuId, when, group } = menu;
		MenuRegistry.appendMenuItem(menuId, {
			command,
			when,
			group
		});
	}

	// 3) keybindings
	if (keybinding) {
		let { when, weight, keys } = keybinding;
		KeybindingsRegistry.registerKeybindingRule({
			id,
			when,
			weight,
			primary: keys.primary,
			secondary: keys.secondary,
			linux: keys.linux,
			mac: keys.mac,
			win: keys.win
		});
	}
}