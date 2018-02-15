/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as nls from 'vs/nls';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { ContextKeyExpr, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { optional } from 'vs/platform/instantiation/common/instantiation';
import { IMarkerService } from 'vs/platform/markers/common/markers';
import { IEditorContribution } from 'vs/editor/common/editorCommon';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { registerEditorAction, registerEditorContribution, ServicesAccessor, EditorAction, EditorCommand, registerEditorCommand } from 'vs/editor/browser/editorExtensions';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { QuickFixContextMenu } from './quickFixWidget';
import { LightBulbWidget } from './lightBulbWidget';
import { QuickFixModel, QuickFixComputeEvent } from './quickFixModel';
import { CodeActionKind, CodeActionAutoApply } from './codeActionTrigger';
import { TPromise } from 'vs/base/common/winjs.base';
import { CodeAction } from 'vs/editor/common/modes';
import { BulkEdit } from 'vs/editor/browser/services/bulkEdit';
import { IFileService } from 'vs/platform/files/common/files';
import { ITextModelService } from 'vs/editor/common/services/resolverService';

export class QuickFixController implements IEditorContribution {

	private static readonly ID = 'editor.contrib.quickFixController';

	public static get(editor: ICodeEditor): QuickFixController {
		return editor.getContribution<QuickFixController>(QuickFixController.ID);
	}

	private _editor: ICodeEditor;
	private _model: QuickFixModel;
	private _quickFixContextMenu: QuickFixContextMenu;
	private _lightBulbWidget: LightBulbWidget;
	private _disposables: IDisposable[] = [];

	constructor(editor: ICodeEditor,
		@IMarkerService markerService: IMarkerService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ICommandService private readonly _commandService: ICommandService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@optional(IFileService) private _fileService: IFileService
	) {
		this._editor = editor;
		this._model = new QuickFixModel(this._editor, markerService);
		this._quickFixContextMenu = new QuickFixContextMenu(editor, contextMenuService, action => this._onApplyCodeAction(action));
		this._lightBulbWidget = new LightBulbWidget(editor);

		this._updateLightBulbTitle();

		this._disposables.push(
			this._quickFixContextMenu.onDidExecuteCodeAction(_ => this._model.trigger({ type: 'auto' })),
			this._lightBulbWidget.onClick(this._handleLightBulbSelect, this),
			this._model.onDidChangeFixes(e => this._onQuickFixEvent(e)),
			this._keybindingService.onDidUpdateKeybindings(this._updateLightBulbTitle, this)
		);
	}

	public dispose(): void {
		this._model.dispose();
		dispose(this._disposables);
	}

	private _onQuickFixEvent(e: QuickFixComputeEvent): void {
		if (e && e.trigger.kind) {
			// Triggered for specific scope
			// Apply if we only have one action or requested autoApply, otherwise show menu
			e.fixes.then(fixes => {
				if (e.trigger.autoApply === CodeActionAutoApply.First || (e.trigger.autoApply === CodeActionAutoApply.IfSingle && fixes.length === 1)) {
					this._onApplyCodeAction(fixes[0]);
				} else {
					this._quickFixContextMenu.show(e.fixes, e.position);
				}
			});
			return;
		}

		if (e && e.trigger.type === 'manual') {
			this._quickFixContextMenu.show(e.fixes, e.position);
		} else if (e && e.fixes) {
			// auto magically triggered
			// * update an existing list of code actions
			// * manage light bulb
			if (this._quickFixContextMenu.isVisible) {
				this._quickFixContextMenu.show(e.fixes, e.position);
			} else {
				this._lightBulbWidget.model = e;
			}
		} else {
			this._lightBulbWidget.hide();
		}
	}

	public getId(): string {
		return QuickFixController.ID;
	}

	private _handleLightBulbSelect(coords: { x: number, y: number }): void {
		this._quickFixContextMenu.show(this._lightBulbWidget.model.fixes, coords);
	}

	public triggerFromEditorSelection(): void {
		this._model.trigger({ type: 'manual' });
	}

	public triggerCodeActionFromEditorSelection(kind?: CodeActionKind, autoApply?: CodeActionAutoApply): void {
		this._model.trigger({ type: 'manual', kind, autoApply });
	}

	private _updateLightBulbTitle(): void {
		const kb = this._keybindingService.lookupKeybinding(QuickFixAction.Id);
		let title: string;
		if (kb) {
			title = nls.localize('quickFixWithKb', "Show Fixes ({0})", kb.getLabel());
		} else {
			title = nls.localize('quickFix', "Show Fixes");
		}
		this._lightBulbWidget.title = title;
	}

	private async _onApplyCodeAction(action: CodeAction): TPromise<void> {
		if (action.edit) {
			await BulkEdit.perform(action.edit.edits, this._textModelService, this._fileService, this._editor);
		}

		if (action.command) {
			await this._commandService.executeCommand(action.command.id, ...action.command.arguments);
		}
	}
}

export class QuickFixAction extends EditorAction {

	static readonly Id = 'editor.action.quickFix';

	constructor() {
		super({
			id: QuickFixAction.Id,
			label: nls.localize('quickfix.trigger.label', "Quick Fix"),
			alias: 'Quick Fix',
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasCodeActionsProvider),
			kbOpts: {
				kbExpr: EditorContextKeys.textFocus,
				primary: KeyMod.CtrlCmd | KeyCode.US_DOT
			}
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		let controller = QuickFixController.get(editor);
		if (controller) {
			controller.triggerFromEditorSelection();
		}
	}
}


class CodeActionCommandArgs {
	public static fromUser(arg: any): CodeActionCommandArgs {
		if (!arg || typeof arg !== 'object') {
			return new CodeActionCommandArgs(CodeActionKind.Empty, CodeActionAutoApply.IfSingle);
		}
		return new CodeActionCommandArgs(
			CodeActionCommandArgs.getKindFromUser(arg),
			CodeActionCommandArgs.getApplyFromUser(arg));
	}

	private static getApplyFromUser(arg: any) {
		switch (typeof arg.apply === 'string' ? arg.apply.toLowerCase() : '') {
			case 'first':
				return CodeActionAutoApply.First;

			case 'never':
				return CodeActionAutoApply.Never;

			case 'ifsingle':
			default:
				return CodeActionAutoApply.IfSingle;
		}
	}

	private static getKindFromUser(arg: any) {
		return typeof arg.kind === 'string'
			? new CodeActionKind(arg.kind)
			: CodeActionKind.Empty;
	}

	private constructor(
		public readonly kind: CodeActionKind,
		public readonly apply: CodeActionAutoApply
	) { }
}

export class CodeActionCommand extends EditorCommand {

	static readonly Id = 'editor.action.codeAction';

	constructor() {
		super({
			id: CodeActionCommand.Id,
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasCodeActionsProvider)
		});
	}

	public runEditorCommand(accessor: ServicesAccessor, editor: ICodeEditor, userArg: any) {
		const controller = QuickFixController.get(editor);
		if (controller) {
			const args = CodeActionCommandArgs.fromUser(userArg);
			controller.triggerCodeActionFromEditorSelection(args.kind, args.apply);
		}
	}
}


export class RefactorAction extends EditorAction {

	static readonly Id = 'editor.action.refactor';

	constructor() {
		super({
			id: RefactorAction.Id,
			label: nls.localize('refactor.label', "Refactor"),
			alias: 'Refactor',
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasCodeActionsProvider),
			kbOpts: {
				kbExpr: EditorContextKeys.textFocus,
				primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KEY_R
			}
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		const controller = QuickFixController.get(editor);
		if (controller) {
			controller.triggerCodeActionFromEditorSelection(CodeActionKind.Refactor, CodeActionAutoApply.Never);
		}
	}
}


registerEditorContribution(QuickFixController);
registerEditorAction(QuickFixAction);
registerEditorAction(RefactorAction);
registerEditorCommand(new CodeActionCommand());
