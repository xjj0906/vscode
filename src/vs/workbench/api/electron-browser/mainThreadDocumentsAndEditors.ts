/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { IModelService } from 'vs/editor/common/services/modelService';
import { ITextModel } from 'vs/editor/common/model';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import Event, { Emitter } from 'vs/base/common/event';
import { ExtHostContext, ExtHostDocumentsAndEditorsShape, IModelAddedData, ITextEditorAddData, IDocumentsAndEditorsDelta, IExtHostContext, MainContext } from '../node/extHost.protocol';
import { MainThreadTextEditor } from './mainThreadEditor';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { Position as EditorPosition, IEditor } from 'vs/platform/editor/common/editor';
import { extHostCustomer } from 'vs/workbench/api/electron-browser/extHostCustomers';
import { MainThreadDocuments } from 'vs/workbench/api/electron-browser/mainThreadDocuments';
import { MainThreadEditors } from 'vs/workbench/api/electron-browser/mainThreadEditors';
import { IModeService } from 'vs/editor/common/services/modeService';
import { IFileService } from 'vs/platform/files/common/files';
import { ITextModelService } from 'vs/editor/common/services/resolverService';
import { IUntitledEditorService } from 'vs/workbench/services/untitled/common/untitledEditorService';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { isCodeEditor, isDiffEditor, ICodeEditor } from 'vs/editor/browser/editorBrowser';
import URI from 'vs/base/common/uri';

namespace mapset {

	export function setValues<T>(set: Set<T>): T[] {
		// return Array.from(set);
		let ret: T[] = [];
		set.forEach(v => ret.push(v));
		return ret;
	}

	export function mapValues<T>(map: Map<any, T>): T[] {
		// return Array.from(map.values());
		let ret: T[] = [];
		map.forEach(v => ret.push(v));
		return ret;
	}
}

namespace delta {

	export function ofSets<T>(before: Set<T>, after: Set<T>): { removed: T[], added: T[] } {
		const removed: T[] = [];
		const added: T[] = [];
		before.forEach(element => {
			if (!after.has(element)) {
				removed.push(element);
			}
		});
		after.forEach(element => {
			if (!before.has(element)) {
				added.push(element);
			}
		});
		return { removed, added };
	}

	export function ofMaps<K, V>(before: Map<K, V>, after: Map<K, V>): { removed: V[], added: V[] } {
		const removed: V[] = [];
		const added: V[] = [];
		before.forEach((value, index) => {
			if (!after.has(index)) {
				removed.push(value);
			}
		});
		after.forEach((value, index) => {
			if (!before.has(index)) {
				added.push(value);
			}
		});
		return { removed, added };
	}
}

class EditorSnapshot {

	readonly id: string;

	constructor(
		readonly editor: ICodeEditor,
	) {
		this.id = `${editor.getId()},${editor.getModel().id}`;
	}
}

class DocumentAndEditorStateDelta {

	readonly isEmpty: boolean;

	constructor(
		readonly removedDocuments: ITextModel[],
		readonly addedDocuments: ITextModel[],
		readonly removedEditors: EditorSnapshot[],
		readonly addedEditors: EditorSnapshot[],
		readonly oldActiveEditor: string,
		readonly newActiveEditor: string,
	) {
		this.isEmpty = this.removedDocuments.length === 0
			&& this.addedDocuments.length === 0
			&& this.removedEditors.length === 0
			&& this.addedEditors.length === 0
			&& oldActiveEditor === newActiveEditor;
	}

	toString(): string {
		let ret = 'DocumentAndEditorStateDelta\n';
		ret += `\tRemoved Documents: [${this.removedDocuments.map(d => d.uri.toString(true)).join(', ')}]\n`;
		ret += `\tAdded Documents: [${this.addedDocuments.map(d => d.uri.toString(true)).join(', ')}]\n`;
		ret += `\tRemoved Editors: [${this.removedEditors.map(e => e.id).join(', ')}]\n`;
		ret += `\tAdded Editors: [${this.addedEditors.map(e => e.id).join(', ')}]\n`;
		ret += `\tNew Active Editor: ${this.newActiveEditor}\n`;
		return ret;
	}
}

class DocumentAndEditorState {

	static compute(before: DocumentAndEditorState, after: DocumentAndEditorState): DocumentAndEditorStateDelta {
		if (!before) {
			return new DocumentAndEditorStateDelta(
				[], mapset.setValues(after.documents),
				[], mapset.mapValues(after.editors),
				undefined, after.activeEditor
			);
		}
		const documentDelta = delta.ofSets(before.documents, after.documents);
		const editorDelta = delta.ofMaps(before.editors, after.editors);
		const oldActiveEditor = before.activeEditor !== after.activeEditor ? before.activeEditor : undefined;
		const newActiveEditor = before.activeEditor !== after.activeEditor ? after.activeEditor : undefined;

		return new DocumentAndEditorStateDelta(
			documentDelta.removed, documentDelta.added,
			editorDelta.removed, editorDelta.added,
			oldActiveEditor, newActiveEditor
		);
	}

	constructor(
		readonly documents: Set<ITextModel>,
		readonly editors: Map<string, EditorSnapshot>,
		readonly activeEditor: string,
	) {
		//
	}
}

class MainThreadDocumentAndEditorStateComputer {

	private _toDispose: IDisposable[] = [];
	private _toDisposeOnEditorRemove = new Map<string, IDisposable>();
	private _currentState: DocumentAndEditorState;

	constructor(
		private readonly _onDidChangeState: (delta: DocumentAndEditorStateDelta) => void,
		@IModelService private _modelService: IModelService,
		@ICodeEditorService private _codeEditorService: ICodeEditorService,
		@IWorkbenchEditorService private _workbenchEditorService: IWorkbenchEditorService
	) {
		this._modelService.onModelAdded(this._updateStateOnModelAdd, this, this._toDispose);
		this._modelService.onModelRemoved(this._updateState, this, this._toDispose);

		this._codeEditorService.onCodeEditorAdd(this._onDidAddEditor, this, this._toDispose);
		this._codeEditorService.onCodeEditorRemove(this._onDidRemoveEditor, this, this._toDispose);
		this._codeEditorService.listCodeEditors().forEach(this._onDidAddEditor, this);

		this._updateState();
	}

	dispose(): void {
		this._toDispose = dispose(this._toDispose);
	}

	private _onDidAddEditor(e: ICodeEditor): void {
		this._toDisposeOnEditorRemove.set(e.getId(), e.onDidChangeModel(() => this._updateState()));
		this._toDisposeOnEditorRemove.set(e.getId(), e.onDidFocusEditor(() => this._updateState()));
		this._toDisposeOnEditorRemove.set(e.getId(), e.onDidBlurEditor(() => this._updateState()));
		this._updateState();
	}

	private _onDidRemoveEditor(e: ICodeEditor): void {
		const sub = this._toDisposeOnEditorRemove.get(e.getId());
		if (sub) {
			this._toDisposeOnEditorRemove.delete(e.getId());
			sub.dispose();
			this._updateState();
		}
	}

	private _updateStateOnModelAdd(model: ITextModel): void {
		if (model.isTooLargeForHavingARichMode()) {
			// ignore
			return;
		}

		if (!this._currentState) {
			// too early
			this._updateState();
			return;
		}

		// small (fast) delta
		this._currentState = new DocumentAndEditorState(
			this._currentState.documents.add(model),
			this._currentState.editors,
			this._currentState.activeEditor
		);

		this._onDidChangeState(new DocumentAndEditorStateDelta(
			[], [model],
			[], [],
			undefined, undefined
		));
	}

	private _updateState(): void {

		// models: ignore too large models
		const models = new Set<ITextModel>();
		for (const model of this._modelService.getModels()) {
			if (!model.isTooLargeForHavingARichMode()) {
				models.add(model);
			}
		}


		// editor: only take those that have a not too large model
		const editors = new Map<string, EditorSnapshot>();
		let activeEditor: string = null;

		for (const editor of this._codeEditorService.listCodeEditors()) {
			const model = editor.getModel();
			if (model && !model.isTooLargeForHavingARichMode()
				&& !model.isDisposed() // model disposed
				&& Boolean(this._modelService.getModel(model.uri)) // model disposing, the flag didn't flip yet but the model service already removed it
			) {
				const apiEditor = new EditorSnapshot(editor);
				editors.set(apiEditor.id, apiEditor);
				if (editor.isFocused()) {
					activeEditor = apiEditor.id;
				}
			}
		}

		// active editor: if none of the previous editors had focus we try
		// to match the action workbench editor with one of editor we have
		// just computed
		if (!activeEditor) {
			const workbenchEditor = this._workbenchEditorService.getActiveEditor();
			if (workbenchEditor) {
				const workbenchEditorControl = workbenchEditor.getControl();
				let candidate: ICodeEditor;
				if (isCodeEditor(workbenchEditorControl)) {
					candidate = workbenchEditorControl;
				} else if (isDiffEditor(workbenchEditorControl)) {
					candidate = workbenchEditorControl.getModifiedEditor();
				}
				if (candidate) {
					editors.forEach(snapshot => {
						if (candidate === snapshot.editor) {
							activeEditor = snapshot.id;
						}
					});
				}
			}
		}

		// compute new state and compare against old
		const newState = new DocumentAndEditorState(models, editors, activeEditor);
		const delta = DocumentAndEditorState.compute(this._currentState, newState);
		if (!delta.isEmpty) {
			this._currentState = newState;
			this._onDidChangeState(delta);
		}
	}
}

@extHostCustomer
export class MainThreadDocumentsAndEditors {

	private _toDispose: IDisposable[];
	private _proxy: ExtHostDocumentsAndEditorsShape;
	private _stateComputer: MainThreadDocumentAndEditorStateComputer;
	private _editors = <{ [id: string]: MainThreadTextEditor }>Object.create(null);

	private _onTextEditorAdd = new Emitter<MainThreadTextEditor[]>();
	private _onTextEditorRemove = new Emitter<string[]>();
	private _onDocumentAdd = new Emitter<ITextModel[]>();
	private _onDocumentRemove = new Emitter<URI[]>();

	readonly onTextEditorAdd: Event<MainThreadTextEditor[]> = this._onTextEditorAdd.event;
	readonly onTextEditorRemove: Event<string[]> = this._onTextEditorRemove.event;
	readonly onDocumentAdd: Event<ITextModel[]> = this._onDocumentAdd.event;
	readonly onDocumentRemove: Event<URI[]> = this._onDocumentRemove.event;

	constructor(
		extHostContext: IExtHostContext,
		@IModelService private _modelService: IModelService,
		@ITextFileService private _textFileService: ITextFileService,
		@IWorkbenchEditorService private _workbenchEditorService: IWorkbenchEditorService,
		@ICodeEditorService codeEditorService: ICodeEditorService,
		@IModeService modeService: IModeService,
		@IFileService fileService: IFileService,
		@ITextModelService textModelResolverService: ITextModelService,
		@IUntitledEditorService untitledEditorService: IUntitledEditorService,
		@IEditorGroupService editorGroupService: IEditorGroupService
	) {
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostDocumentsAndEditors);

		const mainThreadDocuments = new MainThreadDocuments(this, extHostContext, this._modelService, modeService, this._textFileService, fileService, textModelResolverService, untitledEditorService);
		extHostContext.set(MainContext.MainThreadDocuments, mainThreadDocuments);

		const mainThreadEditors = new MainThreadEditors(this, extHostContext, codeEditorService, this._workbenchEditorService, editorGroupService, textModelResolverService, fileService, this._modelService);
		extHostContext.set(MainContext.MainThreadEditors, mainThreadEditors);

		// It is expected that the ctor of the state computer calls our `_onDelta`.
		this._stateComputer = new MainThreadDocumentAndEditorStateComputer(delta => this._onDelta(delta), _modelService, codeEditorService, _workbenchEditorService);

		this._toDispose = [
			mainThreadDocuments,
			mainThreadEditors,
			this._stateComputer,
			this._onTextEditorAdd,
			this._onTextEditorRemove,
			this._onDocumentAdd,
			this._onDocumentRemove,
		];
	}

	dispose(): void {
		this._toDispose = dispose(this._toDispose);
	}

	private _onDelta(delta: DocumentAndEditorStateDelta): void {

		let removedDocuments: URI[];
		let removedEditors: string[] = [];
		let addedEditors: MainThreadTextEditor[] = [];

		// removed models
		removedDocuments = delta.removedDocuments.map(m => m.uri);

		// added editors
		for (const apiEditor of delta.addedEditors) {
			const mainThreadEditor = new MainThreadTextEditor(apiEditor.id, apiEditor.editor.getModel(),
				apiEditor.editor, { onGainedFocus() { }, onLostFocus() { } }, this._modelService);

			this._editors[apiEditor.id] = mainThreadEditor;
			addedEditors.push(mainThreadEditor);
		}

		// removed editors
		for (const { id } of delta.removedEditors) {
			const mainThreadEditor = this._editors[id];
			if (mainThreadEditor) {
				mainThreadEditor.dispose();
				delete this._editors[id];
				removedEditors.push(id);
			}
		}

		let extHostDelta: IDocumentsAndEditorsDelta = Object.create(null);
		let empty = true;
		if (delta.newActiveEditor !== undefined) {
			empty = false;
			extHostDelta.newActiveEditor = delta.newActiveEditor;
		}
		if (removedDocuments.length > 0) {
			empty = false;
			extHostDelta.removedDocuments = removedDocuments;
		}
		if (removedEditors.length > 0) {
			empty = false;
			extHostDelta.removedEditors = removedEditors;
		}
		if (delta.addedDocuments.length > 0) {
			empty = false;
			extHostDelta.addedDocuments = delta.addedDocuments.map(m => this._toModelAddData(m));
		}
		if (delta.addedEditors.length > 0) {
			empty = false;
			extHostDelta.addedEditors = addedEditors.map(e => this._toTextEditorAddData(e));
		}

		if (!empty) {
			// first update ext host
			this._proxy.$acceptDocumentsAndEditorsDelta(extHostDelta);
			// second update dependent state listener
			this._onDocumentRemove.fire(removedDocuments);
			this._onDocumentAdd.fire(delta.addedDocuments);
			this._onTextEditorRemove.fire(removedEditors);
			this._onTextEditorAdd.fire(addedEditors);
		}
	}

	private _toModelAddData(model: ITextModel): IModelAddedData {
		return {
			uri: model.uri,
			versionId: model.getVersionId(),
			lines: model.getLinesContent(),
			EOL: model.getEOL(),
			modeId: model.getLanguageIdentifier().language,
			isDirty: this._textFileService.isDirty(model.uri)
		};
	}

	private _toTextEditorAddData(textEditor: MainThreadTextEditor): ITextEditorAddData {
		return {
			id: textEditor.getId(),
			documentUri: textEditor.getModel().uri,
			options: textEditor.getConfiguration(),
			selections: textEditor.getSelections(),
			editorPosition: this._findEditorPosition(textEditor)
		};
	}

	private _findEditorPosition(editor: MainThreadTextEditor): EditorPosition {
		for (let workbenchEditor of this._workbenchEditorService.getVisibleEditors()) {
			if (editor.matches(workbenchEditor)) {
				return workbenchEditor.position;
			}
		}
		return undefined;
	}

	findTextEditorIdFor(editor: IEditor): string {
		for (let id in this._editors) {
			if (this._editors[id].matches(editor)) {
				return id;
			}
		}
		return undefined;
	}

	getEditor(id: string): MainThreadTextEditor {
		return this._editors[id];
	}
}
