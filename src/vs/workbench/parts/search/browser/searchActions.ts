/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import nls = require('vs/nls');
import DOM = require('vs/base/browser/dom');
import { TPromise } from 'vs/base/common/winjs.base';
import { Action } from 'vs/base/common/actions';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { ITree } from 'vs/base/parts/tree/browser/tree';
import { INavigator } from 'vs/base/common/iterator';
import { SearchViewlet } from 'vs/workbench/parts/search/browser/searchViewlet';
import { Match, FileMatch, FileMatchOrMatch, FolderMatch, RenderableMatch } from 'vs/workbench/parts/search/common/searchModel';
import { IReplaceService } from 'vs/workbench/parts/search/common/replace';
import * as Constants from 'vs/workbench/parts/search/common/constants';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { ResolvedKeybinding, createKeybinding } from 'vs/base/common/keyCodes';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { OS } from 'vs/base/common/platform';
import { IContextKeyService, ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';

export function isSearchViewletFocused(viewletService: IViewletService): boolean {
	let activeViewlet = viewletService.getActiveViewlet();
	let activeElement = document.activeElement;
	return activeViewlet && activeViewlet.getId() === Constants.VIEWLET_ID && activeElement && DOM.isAncestor(activeElement, (<SearchViewlet>activeViewlet).getContainer().getHTMLElement());
}

export function appendKeyBindingLabel(label: string, keyBinding: number | ResolvedKeybinding, keyBindingService2: IKeybindingService): string {
	if (typeof keyBinding === 'number') {
		const resolvedKeybindings = keyBindingService2.resolveKeybinding(createKeybinding(keyBinding, OS));
		return doAppendKeyBindingLabel(label, resolvedKeybindings.length > 0 ? resolvedKeybindings[0] : null);
	} else {
		return doAppendKeyBindingLabel(label, keyBinding);
	}
}

function doAppendKeyBindingLabel(label: string, keyBinding: ResolvedKeybinding): string {
	return keyBinding ? label + ' (' + keyBinding.getLabel() + ')' : label;
}

export const toggleCaseSensitiveCommand = (accessor: ServicesAccessor) => {
	const viewletService = accessor.get<IViewletService>(IViewletService);
	let searchViewlet = <SearchViewlet>viewletService.getActiveViewlet();
	searchViewlet.toggleCaseSensitive();
};

export const toggleWholeWordCommand = (accessor: ServicesAccessor) => {
	const viewletService = accessor.get<IViewletService>(IViewletService);
	let searchViewlet = <SearchViewlet>viewletService.getActiveViewlet();
	searchViewlet.toggleWholeWords();
};

export const toggleRegexCommand = (accessor: ServicesAccessor) => {
	const viewletService = accessor.get<IViewletService>(IViewletService);
	let searchViewlet = <SearchViewlet>viewletService.getActiveViewlet();
	searchViewlet.toggleRegex();
};

export class ShowNextSearchIncludeAction extends Action {

	public static readonly ID = 'search.history.showNextIncludePattern';
	public static readonly LABEL = nls.localize('nextSearchIncludePattern', "Show Next Search Include Pattern");
	public static CONTEXT_KEY_EXPRESSION: ContextKeyExpr = ContextKeyExpr.and(Constants.SearchViewletVisibleKey, Constants.PatternIncludesFocusedKey);

	constructor(id: string, label: string,
		@IViewletService private viewletService: IViewletService,
		@IContextKeyService private contextKeyService: IContextKeyService
	) {
		super(id, label);
		this.enabled = this.contextKeyService.contextMatchesRules(ShowNextSearchIncludeAction.CONTEXT_KEY_EXPRESSION);
	}

	public run(): TPromise<any> {
		let searchAndReplaceWidget = (<SearchViewlet>this.viewletService.getActiveViewlet()).searchIncludePattern;
		searchAndReplaceWidget.showNextTerm();
		return TPromise.as(null);
	}
}

export class ShowPreviousSearchIncludeAction extends Action {

	public static readonly ID = 'search.history.showPreviousIncludePattern';
	public static readonly LABEL = nls.localize('previousSearchIncludePattern', "Show Previous Search Include Pattern");
	public static CONTEXT_KEY_EXPRESSION: ContextKeyExpr = ContextKeyExpr.and(Constants.SearchViewletVisibleKey, Constants.PatternIncludesFocusedKey);

	constructor(id: string, label: string,
		@IViewletService private viewletService: IViewletService,
		@IContextKeyService private contextKeyService: IContextKeyService
	) {
		super(id, label);
		this.enabled = this.contextKeyService.contextMatchesRules(ShowPreviousSearchIncludeAction.CONTEXT_KEY_EXPRESSION);
	}

	public run(): TPromise<any> {
		let searchAndReplaceWidget = (<SearchViewlet>this.viewletService.getActiveViewlet()).searchIncludePattern;
		searchAndReplaceWidget.showPreviousTerm();
		return TPromise.as(null);
	}
}

export class ShowNextSearchExcludeAction extends Action {

	public static readonly ID = 'search.history.showNextExcludePattern';
	public static readonly LABEL = nls.localize('nextSearchExcludePattern', "Show Next Search Exclude Pattern");
	public static CONTEXT_KEY_EXPRESSION: ContextKeyExpr = ContextKeyExpr.and(Constants.SearchViewletVisibleKey, Constants.PatternExcludesFocusedKey);

	constructor(id: string, label: string,
		@IViewletService private viewletService: IViewletService,
		@IContextKeyService private contextKeyService: IContextKeyService
	) {
		super(id, label);
		this.enabled = this.contextKeyService.contextMatchesRules(ShowNextSearchExcludeAction.CONTEXT_KEY_EXPRESSION);
	}
	public run(): TPromise<any> {
		let searchAndReplaceWidget = (<SearchViewlet>this.viewletService.getActiveViewlet()).searchExcludePattern;
		searchAndReplaceWidget.showNextTerm();
		return TPromise.as(null);
	}
}

export class ShowPreviousSearchExcludeAction extends Action {

	public static readonly ID = 'search.history.showPreviousExcludePattern';
	public static readonly LABEL = nls.localize('previousSearchExcludePattern', "Show Previous Search Exclude Pattern");
	public static CONTEXT_KEY_EXPRESSION: ContextKeyExpr = ContextKeyExpr.and(Constants.SearchViewletVisibleKey, Constants.PatternExcludesFocusedKey);

	constructor(id: string, label: string,
		@IViewletService private viewletService: IViewletService,
		@IContextKeyService private contextKeyService: IContextKeyService
	) {
		super(id, label);
		this.enabled = this.contextKeyService.contextMatchesRules(ShowPreviousSearchExcludeAction.CONTEXT_KEY_EXPRESSION);
	}

	public run(): TPromise<any> {
		let searchAndReplaceWidget = (<SearchViewlet>this.viewletService.getActiveViewlet()).searchExcludePattern;
		searchAndReplaceWidget.showPreviousTerm();
		return TPromise.as(null);
	}
}

export class ShowNextSearchTermAction extends Action {

	public static readonly ID = 'search.history.showNext';
	public static readonly LABEL = nls.localize('nextSearchTerm', "Show Next Search Term");
	public static CONTEXT_KEY_EXPRESSION: ContextKeyExpr = ContextKeyExpr.and(Constants.SearchViewletVisibleKey, Constants.SearchInputBoxFocusedKey);

	constructor(id: string, label: string,
		@IViewletService private viewletService: IViewletService,
		@IContextKeyService private contextKeyService: IContextKeyService
	) {
		super(id, label);
		this.enabled = this.contextKeyService.contextMatchesRules(ShowNextSearchTermAction.CONTEXT_KEY_EXPRESSION);

	}

	public run(): TPromise<any> {
		let searchAndReplaceWidget = (<SearchViewlet>this.viewletService.getActiveViewlet()).searchAndReplaceWidget;
		searchAndReplaceWidget.showNextSearchTerm();
		return TPromise.as(null);
	}
}

export class ShowPreviousSearchTermAction extends Action {

	public static readonly ID = 'search.history.showPrevious';
	public static readonly LABEL = nls.localize('previousSearchTerm', "Show Previous Search Term");
	public static CONTEXT_KEY_EXPRESSION: ContextKeyExpr = ContextKeyExpr.and(Constants.SearchViewletVisibleKey, Constants.SearchInputBoxFocusedKey);

	constructor(id: string, label: string,
		@IViewletService private viewletService: IViewletService,
		@IContextKeyService private contextKeyService: IContextKeyService
	) {
		super(id, label);
		this.enabled = this.contextKeyService.contextMatchesRules(ShowPreviousSearchTermAction.CONTEXT_KEY_EXPRESSION);
	}

	public run(): TPromise<any> {
		let searchAndReplaceWidget = (<SearchViewlet>this.viewletService.getActiveViewlet()).searchAndReplaceWidget;
		searchAndReplaceWidget.showPreviousSearchTerm();
		return TPromise.as(null);
	}
}

export class FocusNextInputAction extends Action {

	public static readonly ID = 'search.focus.nextInputBox';

	constructor(id: string, label: string, @IViewletService private viewletService: IViewletService) {
		super(id, label);
	}

	public run(): TPromise<any> {
		(<SearchViewlet>this.viewletService.getActiveViewlet()).focusNextInputBox();
		return TPromise.as(null);
	}
}

export class FocusPreviousInputAction extends Action {

	public static readonly ID = 'search.focus.previousInputBox';

	constructor(id: string, label: string, @IViewletService private viewletService: IViewletService) {
		super(id, label);
	}

	public run(): TPromise<any> {
		(<SearchViewlet>this.viewletService.getActiveViewlet()).focusPreviousInputBox();
		return TPromise.as(null);
	}
}

export const FocusActiveEditorCommand = (accessor: ServicesAccessor) => {
	const editorService = accessor.get(IWorkbenchEditorService);
	const editor = editorService.getActiveEditor();
	if (editor) {
		editor.focus();
	}
	return TPromise.as(true);
};

export abstract class FindOrReplaceInFilesAction extends Action {

	constructor(id: string, label: string, private viewletService: IViewletService,
		private expandSearchReplaceWidget: boolean, private selectWidgetText: boolean, private focusReplace: boolean) {
		super(id, label);
	}

	public run(): TPromise<any> {
		const viewlet = this.viewletService.getActiveViewlet();
		const searchViewletWasOpen = viewlet && viewlet.getId() === Constants.VIEWLET_ID;
		return this.viewletService.openViewlet(Constants.VIEWLET_ID, true).then((viewlet) => {
			if (!searchViewletWasOpen || this.expandSearchReplaceWidget) {
				const searchAndReplaceWidget = (<SearchViewlet>viewlet).searchAndReplaceWidget;
				searchAndReplaceWidget.toggleReplace(this.expandSearchReplaceWidget);
				// Focus replace only when there is text in the searchInput box
				const focusReplace = this.focusReplace && searchAndReplaceWidget.searchInput.getValue();
				searchAndReplaceWidget.focus(this.selectWidgetText, !!focusReplace);
			}
		});
	}
}

export const SHOW_SEARCH_LABEL = nls.localize('showSearchViewlet', "Show Search");

export class FindInFilesAction extends FindOrReplaceInFilesAction {

	public static readonly LABEL = nls.localize('findInFiles', "Find in Files");

	constructor(id: string, label: string, @IViewletService viewletService: IViewletService) {
		super(id, label, viewletService, /*expandSearchReplaceWidget=*/false, /*selectWidgetText=*/true, /*focusReplace=*/false);
	}
}

export class ReplaceInFilesAction extends FindOrReplaceInFilesAction {

	public static readonly ID = 'workbench.action.replaceInFiles';
	public static readonly LABEL = nls.localize('replaceInFiles', "Replace in Files");

	constructor(id: string, label: string, @IViewletService viewletService: IViewletService) {
		super(id, label, viewletService, /*expandSearchReplaceWidget=*/true, /*selectWidgetText=*/false, /*focusReplace=*/true);
	}
}

export class CloseReplaceAction extends Action {

	constructor(id: string, label: string, @IViewletService private viewletService: IViewletService) {
		super(id, label);
	}

	public run(): TPromise<any> {
		let searchAndReplaceWidget = (<SearchViewlet>this.viewletService.getActiveViewlet()).searchAndReplaceWidget;
		searchAndReplaceWidget.toggleReplace(false);
		searchAndReplaceWidget.focus();
		return TPromise.as(null);
	}
}

export abstract class SearchAction extends Action {

	constructor(id: string, label: string, @IViewletService protected viewletService: IViewletService) {
		super(id, label);
	}

	abstract update(): void;

	protected getSearchViewlet(): SearchViewlet {
		const activeViewlet = this.viewletService.getActiveViewlet();
		if (activeViewlet && activeViewlet.getId() === Constants.VIEWLET_ID) {
			return activeViewlet as SearchViewlet;
		}
		return null;
	}
}

export class RefreshAction extends SearchAction {

	static ID: string = 'search.action.refreshSearchResults';
	static LABEL: string = nls.localize('RefreshAction.label', "Refresh");

	constructor(id: string, label: string, @IViewletService viewletService: IViewletService) {
		super(id, label, viewletService);
		this.class = 'search-action refresh';
		this.update();
	}

	update(): void {
		const searchViewlet = this.getSearchViewlet();
		this.enabled = searchViewlet && searchViewlet.isSearchSubmitted();
	}

	public run(): TPromise<void> {
		const searchViewlet = this.getSearchViewlet();
		if (searchViewlet) {
			searchViewlet.onQueryChanged(true);
		}
		return TPromise.as(null);
	}
}

export class CollapseDeepestExpandedLevelAction extends SearchAction {

	static ID: string = 'search.action.collapseSearchResults';
	static LABEL: string = nls.localize('CollapseDeepestExpandedLevelAction.label', "Collapse All");

	constructor(id: string, label: string, @IViewletService viewletService: IViewletService) {
		super(id, label, viewletService);
		this.class = 'search-action collapse';
		this.update();
	}

	update(): void {
		const searchViewlet = this.getSearchViewlet();
		this.enabled = searchViewlet && searchViewlet.hasSearchResults();
	}

	public run(): TPromise<void> {
		const searchViewlet = this.getSearchViewlet();
		if (searchViewlet) {
			const viewer = searchViewlet.getControl();
			if (viewer.getHighlight()) {
				return TPromise.as(null); // Global action disabled if user is in edit mode from another action
			}

			viewer.collapseDeepestExpandedLevel();
			viewer.clearSelection();
			viewer.clearFocus();
			viewer.DOMFocus();
			viewer.focusFirst();
		}
		return TPromise.as(null);
	}
}

export class ClearSearchResultsAction extends SearchAction {

	static ID: string = 'search.action.clearSearchResults';
	static LABEL: string = nls.localize('ClearSearchResultsAction.label', "Clear");

	constructor(id: string, label: string, @IViewletService viewletService: IViewletService) {
		super(id, label, viewletService);
		this.class = 'search-action clear-search-results';
		this.update();
	}

	update(): void {
		const searchViewlet = this.getSearchViewlet();
		this.enabled = searchViewlet && searchViewlet.hasSearchResults();
	}

	public run(): TPromise<void> {
		const searchViewlet = this.getSearchViewlet();
		if (searchViewlet) {
			searchViewlet.clearSearchResults();
		}
		return TPromise.as(null);
	}
}

export class CancelSearchAction extends SearchAction {

	static ID: string = 'search.action.cancelSearch';
	static LABEL: string = nls.localize('CancelSearchAction.label', "Cancel Search");

	constructor(id: string, label: string, @IViewletService viewletService: IViewletService) {
		super(id, label, viewletService);
		this.class = 'search-action cancel-search';
		this.update();
	}

	update(): void {
		const searchViewlet = this.getSearchViewlet();
		this.enabled = searchViewlet && searchViewlet.isSearching();
	}

	public run(): TPromise<void> {
		const searchViewlet = this.getSearchViewlet();
		if (searchViewlet) {
			searchViewlet.cancelSearch();
		}

		return TPromise.as(null);
	}
}

export class FocusNextSearchResultAction extends Action {
	public static readonly ID = 'search.action.focusNextSearchResult';
	public static readonly LABEL = nls.localize('FocusNextSearchResult.label', "Focus Next Search Result");

	constructor(id: string, label: string, @IViewletService private viewletService: IViewletService) {
		super(id, label);
	}

	public run(): TPromise<any> {
		return this.viewletService.openViewlet(Constants.VIEWLET_ID).then(searchViewlet => {
			(searchViewlet as SearchViewlet).selectNextMatch();
		});
	}
}

export class FocusPreviousSearchResultAction extends Action {
	public static readonly ID = 'search.action.focusPreviousSearchResult';
	public static readonly LABEL = nls.localize('FocusPreviousSearchResult.label', "Focus Previous Search Result");

	constructor(id: string, label: string, @IViewletService private viewletService: IViewletService) {
		super(id, label);
	}

	public run(): TPromise<any> {
		return this.viewletService.openViewlet(Constants.VIEWLET_ID).then(searchViewlet => {
			(searchViewlet as SearchViewlet).selectPreviousMatch();
		});
	}
}

export abstract class AbstractSearchAndReplaceAction extends Action {

	/**
	 * Returns element to focus after removing the given element
	 */
	public getElementToFocusAfterRemoved(viewer: ITree, elementToBeRemoved: RenderableMatch): RenderableMatch {
		let elementToFocus = this.getNextElementAfterRemoved(viewer, elementToBeRemoved);
		if (!elementToFocus) {
			elementToFocus = this.getPreviousElementAfterRemoved(viewer, elementToBeRemoved);
		}
		return elementToFocus;
	}

	public getNextElementAfterRemoved(viewer: ITree, element: RenderableMatch): RenderableMatch {
		let navigator: INavigator<any> = this.getNavigatorAt(element, viewer);
		if (element instanceof FolderMatch) {
			// If file match is removed then next element is the next file match
			while (!!navigator.next() && !(navigator.current() instanceof FolderMatch)) { }
		} else if (element instanceof FileMatch) {
			// If file match is removed then next element is the next file match
			while (!!navigator.next() && !(navigator.current() instanceof FileMatch)) { }
		} else {
			navigator.next();
		}
		return navigator.current();
	}

	public getPreviousElementAfterRemoved(viewer: ITree, element: RenderableMatch): RenderableMatch {
		let navigator: INavigator<any> = this.getNavigatorAt(element, viewer);
		let previousElement = navigator.previous();
		if (element instanceof Match && element.parent().matches().length === 1) {
			// If this is the only match, then the file match is also removed
			// Hence take the previous element to file match
			previousElement = navigator.previous();
		}
		return previousElement;
	}

	private getNavigatorAt(element: RenderableMatch, viewer: ITree): INavigator<any> {
		let navigator: INavigator<any> = viewer.getNavigator();
		while (navigator.current() !== element && !!navigator.next()) { }
		return navigator;
	}
}

export class RemoveAction extends AbstractSearchAndReplaceAction {

	constructor(private viewer: ITree, private element: RenderableMatch) {
		super('remove', nls.localize('RemoveAction.label', "Dismiss"), 'action-remove');
	}

	public run(): TPromise<any> {
		let nextFocusElement = this.getElementToFocusAfterRemoved(this.viewer, this.element);
		if (nextFocusElement) {
			this.viewer.setFocus(nextFocusElement);
		}

		let elementToRefresh: any;
		const element = this.element;
		if (element instanceof FolderMatch) {
			let parent = element.parent();
			parent.remove(element);
			elementToRefresh = parent;
		} else if (element instanceof FileMatch) {
			let parent = element.parent();
			parent.remove(element);
			elementToRefresh = parent;
		} else if (element instanceof Match) {
			let parent = element.parent();
			parent.remove(element);
			elementToRefresh = parent.count() === 0 ? parent.parent() : parent;
		}

		this.viewer.DOMFocus();
		return this.viewer.refresh(elementToRefresh);
	}

}

export class ReplaceAllAction extends AbstractSearchAndReplaceAction {

	constructor(private viewer: ITree, private fileMatch: FileMatch, private viewlet: SearchViewlet,
		@IKeybindingService keyBindingService: IKeybindingService) {
		super(Constants.ReplaceAllInFileActionId, appendKeyBindingLabel(nls.localize('file.replaceAll.label', "Replace All"), keyBindingService.lookupKeybinding(Constants.ReplaceAllInFileActionId), keyBindingService), 'action-replace-all');
	}

	public run(): TPromise<any> {
		let nextFocusElement = this.getElementToFocusAfterRemoved(this.viewer, this.fileMatch);
		return this.fileMatch.parent().replace(this.fileMatch).then(() => {
			if (nextFocusElement) {
				this.viewer.setFocus(nextFocusElement);
			}
			this.viewer.DOMFocus();
			this.viewlet.open(this.fileMatch, true);
		});
	}
}

export class ReplaceAllInFolderAction extends AbstractSearchAndReplaceAction {

	constructor(private viewer: ITree, private folderMatch: FolderMatch,
		@IKeybindingService keyBindingService: IKeybindingService
	) {
		super(Constants.ReplaceAllInFolderActionId, nls.localize('file.replaceAll.label', "Replace All"), 'action-replace-all');
	}

	public async run(): TPromise<any> {
		let nextFocusElement = this.getElementToFocusAfterRemoved(this.viewer, this.folderMatch);
		await this.folderMatch.replaceAll();

		if (nextFocusElement) {
			this.viewer.setFocus(nextFocusElement);
		}
		this.viewer.DOMFocus();
	}
}

export class ReplaceAction extends AbstractSearchAndReplaceAction {

	constructor(private viewer: ITree, private element: Match, private viewlet: SearchViewlet,
		@IReplaceService private replaceService: IReplaceService,
		@IKeybindingService keyBindingService: IKeybindingService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService) {
		super(Constants.ReplaceActionId, appendKeyBindingLabel(nls.localize('match.replace.label', "Replace"), keyBindingService.lookupKeybinding(Constants.ReplaceActionId), keyBindingService), 'action-replace');
	}

	public run(): TPromise<any> {
		this.enabled = false;

		return this.element.parent().replace(this.element).then(() => {
			let elementToFocus = this.getElementToFocusAfterReplace();
			if (elementToFocus) {
				this.viewer.setFocus(elementToFocus);
			}
			let elementToShowReplacePreview = this.getElementToShowReplacePreview(elementToFocus);
			this.viewer.DOMFocus();
			if (!elementToShowReplacePreview || this.hasToOpenFile()) {
				this.viewlet.open(this.element, true);
			} else {
				this.replaceService.openReplacePreview(elementToShowReplacePreview, true);
			}
		});
	}

	private getElementToFocusAfterReplace(): Match {
		let navigator: INavigator<any> = this.viewer.getNavigator();
		let fileMatched = false;
		let elementToFocus = null;
		do {
			elementToFocus = navigator.current();
			if (elementToFocus instanceof Match) {
				if (elementToFocus.parent().id() === this.element.parent().id()) {
					fileMatched = true;
					if (this.element.range().getStartPosition().isBeforeOrEqual((<Match>elementToFocus).range().getStartPosition())) {
						// Closest next match in the same file
						break;
					}
				} else if (fileMatched) {
					// First match in the next file (if expanded)
					break;
				}
			} else if (fileMatched) {
				if (!this.viewer.isExpanded(elementToFocus)) {
					// Next file match (if collapsed)
					break;
				}
			}
		} while (!!navigator.next());
		return elementToFocus;
	}

	private getElementToShowReplacePreview(elementToFocus: FileMatchOrMatch): Match {
		if (this.hasSameParent(elementToFocus)) {
			return <Match>elementToFocus;
		}
		let previousElement = this.getPreviousElementAfterRemoved(this.viewer, this.element);
		if (this.hasSameParent(previousElement)) {
			return <Match>previousElement;
		}
		return null;
	}

	private hasSameParent(element: RenderableMatch): boolean {
		return element && element instanceof Match && element.parent().resource() === this.element.parent().resource();
	}

	private hasToOpenFile(): boolean {
		const activeInput = this.editorService.getActiveEditorInput();
		const file = activeInput ? activeInput.getResource() : void 0;
		if (file) {
			return file.toString() === this.element.parent().resource().toString();
		}
		return false;
	}
}
