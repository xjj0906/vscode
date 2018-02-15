/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { BaseWebviewEditor } from 'vs/workbench/browser/parts/editor/webviewEditor';
import { IStorageService } from 'vs/platform/storage/common/storage';

import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { Command, ICommandOptions } from 'vs/editor/browser/editorExtensions';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { KeyMod, KeyCode } from 'vs/base/common/keyCodes';
import { ContextKeyExpr, IContextKey, RawContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { KeybindingsRegistry } from 'vs/platform/keybinding/common/keybindingsRegistry';

import WebView from './webview';
import { Builder } from 'vs/base/browser/builder';
import { IWorkbenchActionRegistry, Extensions as ActionExtensions } from 'vs/workbench/common/actions';
import { Registry } from 'vs/platform/registry/common/platform';
import { SyncActionDescriptor } from 'vs/platform/actions/common/actions';
import { Action } from 'vs/base/common/actions';
import { TPromise } from 'vs/base/common/winjs.base';

export interface HtmlPreviewEditorViewState {
	scrollYPercentage: number;
}

/**  A context key that is set when a webview editor has focus. */
export const KEYBINDING_CONTEXT_WEBVIEWEDITOR_FOCUS = new RawContextKey<boolean>('webviewEditorFocus', false);
/**  A context key that is set when the find widget find input in webview editor webview is focused. */
export const KEYBINDING_CONTEXT_WEBVIEWEDITOR_FIND_WIDGET_INPUT_FOCUSED = new RawContextKey<boolean>('webviewEditorFindWidgetInputFocused', false);
/**  A context key that is set when the find widget in a webview is visible. */
export const KEYBINDING_CONTEXT_WEBVIEW_FIND_WIDGET_VISIBLE = new RawContextKey<boolean>('webviewFindWidgetVisible', false);

/**
 * This class is only intended to be subclassed and not instantiated.
 */
export abstract class WebviewEditor extends BaseWebviewEditor {

	protected _webviewFocusContextKey: IContextKey<boolean>;
	protected _webview: WebView;
	protected content: HTMLElement;
	protected contextKey: IContextKey<boolean>;
	protected findWidgetVisible: IContextKey<boolean>;
	protected findInputFocusContextKey: IContextKey<boolean>;

	constructor(
		id: string,
		telemetryService: ITelemetryService,
		themeService: IThemeService,
		storageService: IStorageService,
		contextKeyService: IContextKeyService,
	) {
		super(id, telemetryService, themeService, storageService);
		if (contextKeyService) {
			this.contextKey = KEYBINDING_CONTEXT_WEBVIEWEDITOR_FOCUS.bindTo(contextKeyService);
			this.findInputFocusContextKey = KEYBINDING_CONTEXT_WEBVIEWEDITOR_FIND_WIDGET_INPUT_FOCUSED.bindTo(contextKeyService);
			this.findWidgetVisible = KEYBINDING_CONTEXT_WEBVIEW_FIND_WIDGET_VISIBLE.bindTo(contextKeyService);
		}
	}

	public showFind() {
		if (this._webview) {
			this._webview.showFind();
			this.findWidgetVisible.set(true);
		}
	}

	public hideFind() {
		this.findWidgetVisible.reset();
		if (this._webview) {
			this._webview.hideFind();
		}
	}

	public showNextFindTerm() {
		if (this._webview) {
			this._webview.showNextFindTerm();
		}
	}

	public showPreviousFindTerm() {
		if (this._webview) {
			this._webview.showPreviousFindTerm();
		}
	}

	public updateStyles() {
		super.updateStyles();
		if (this._webview) {
			this._webview.style(this.themeService.getTheme());
		}
	}

	public get isWebviewEditor() {
		return true;
	}

	protected abstract createEditor(parent: Builder): void;
}

class ShowWebViewEditorFindWidgetAction extends Action {
	public static readonly ID = 'editor.action.webvieweditor.showFind';
	public static readonly LABEL = nls.localize('editor.action.webvieweditor.showFind', "Focus Find Widget");

	public constructor(
		id: string,
		label: string,
		@IWorkbenchEditorService private workbenchEditorService: IWorkbenchEditorService
	) {
		super(id, label);
	}

	public run(): TPromise<any> {
		const webViewEditor = this.getWebViewEditor();
		if (webViewEditor) {
			webViewEditor.showFind();
		}
		return null;
	}

	private getWebViewEditor(): WebviewEditor {
		const activeEditor = this.workbenchEditorService.getActiveEditor() as WebviewEditor;
		if (activeEditor.isWebviewEditor) {
			return activeEditor;
		}
		return null;
	}
}

const category = 'Webview';
let actionRegistry = <IWorkbenchActionRegistry>Registry.as(ActionExtensions.WorkbenchActions);

actionRegistry.registerWorkbenchAction(new SyncActionDescriptor(ShowWebViewEditorFindWidgetAction, ShowWebViewEditorFindWidgetAction.ID, ShowWebViewEditorFindWidgetAction.LABEL, {
	primary: KeyMod.CtrlCmd | KeyCode.KEY_F
}, KEYBINDING_CONTEXT_WEBVIEWEDITOR_FOCUS),
	'Webview: Focus Find Widget', category);

class HideWebViewEditorFindCommand extends Command {
	public runCommand(accessor: ServicesAccessor, args: any): void {
		const webViewEditor = this.getWebViewEditor(accessor);
		if (webViewEditor) {
			webViewEditor.hideFind();
		}
	}

	private getWebViewEditor(accessor: ServicesAccessor): WebviewEditor {
		const activeEditor = accessor.get(IWorkbenchEditorService).getActiveEditor() as WebviewEditor;
		if (activeEditor.isWebviewEditor) {
			return activeEditor;
		}
		return null;
	}
}
const hideCommand = new HideWebViewEditorFindCommand({
	id: 'editor.action.webvieweditor.hideFind',
	precondition: ContextKeyExpr.and(
		KEYBINDING_CONTEXT_WEBVIEWEDITOR_FOCUS,
		KEYBINDING_CONTEXT_WEBVIEW_FIND_WIDGET_VISIBLE),
	kbOpts: {
		primary: KeyCode.Escape
	}
});
KeybindingsRegistry.registerCommandAndKeybindingRule(hideCommand.toCommandAndKeybindingRule(KeybindingsRegistry.WEIGHT.editorContrib()));

class ShowWebViewEditorFindTermCommand extends Command {
	constructor(opts: ICommandOptions, private _next: boolean) {
		super(opts);
	}

	public runCommand(accessor: ServicesAccessor, args: any): void {
		const webViewEditor = this.getWebViewEditor(accessor);
		if (webViewEditor) {
			if (this._next) {
				webViewEditor.showNextFindTerm();
			} else {
				webViewEditor.showPreviousFindTerm();
			}
		}
	}

	private getWebViewEditor(accessor: ServicesAccessor): WebviewEditor {
		const activeEditor = accessor.get(IWorkbenchEditorService).getActiveEditor() as WebviewEditor;
		if (activeEditor.isWebviewEditor) {
			return activeEditor;
		}
		return null;
	}
}

const showNextFindTermCommand = new ShowWebViewEditorFindTermCommand({
	id: 'editor.action.webvieweditor.showNextFindTerm',
	precondition: KEYBINDING_CONTEXT_WEBVIEWEDITOR_FIND_WIDGET_INPUT_FOCUSED,
	kbOpts: {
		primary: KeyMod.Alt | KeyCode.DownArrow
	}
}, true);
KeybindingsRegistry.registerCommandAndKeybindingRule(showNextFindTermCommand.toCommandAndKeybindingRule(KeybindingsRegistry.WEIGHT.editorContrib()));

const showPreviousFindTermCommand = new ShowWebViewEditorFindTermCommand({
	id: 'editor.action.webvieweditor.showPreviousFindTerm',
	precondition: KEYBINDING_CONTEXT_WEBVIEWEDITOR_FIND_WIDGET_INPUT_FOCUSED,
	kbOpts: {
		primary: KeyMod.Alt | KeyCode.UpArrow
	}
}, false);
KeybindingsRegistry.registerCommandAndKeybindingRule(showPreviousFindTermCommand.toCommandAndKeybindingRule(KeybindingsRegistry.WEIGHT.editorContrib()));
