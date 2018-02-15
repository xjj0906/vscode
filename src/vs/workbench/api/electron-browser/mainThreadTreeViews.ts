/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import Event, { Emitter } from 'vs/base/common/event';
import { TPromise } from 'vs/base/common/winjs.base';
import { Disposable } from 'vs/base/common/lifecycle';
import { ExtHostContext, MainThreadTreeViewsShape, ExtHostTreeViewsShape, MainContext, IExtHostContext } from '../node/extHost.protocol';
import { IMessageService, Severity } from 'vs/platform/message/common/message';
import { ITreeViewDataProvider, ITreeItem, ICustomViewsService } from 'vs/workbench/common/views';
import { extHostNamedCustomer } from 'vs/workbench/api/electron-browser/extHostCustomers';
import { distinct } from 'vs/base/common/arrays';

@extHostNamedCustomer(MainContext.MainThreadTreeViews)
export class MainThreadTreeViews extends Disposable implements MainThreadTreeViewsShape {

	private _proxy: ExtHostTreeViewsShape;
	private _dataProviders: Map<string, TreeViewDataProvider> = new Map<string, TreeViewDataProvider>();

	constructor(
		extHostContext: IExtHostContext,
		@ICustomViewsService private viewsService: ICustomViewsService,
		@IMessageService private messageService: IMessageService
	) {
		super();
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostTreeViews);
	}

	$registerTreeViewDataProvider(treeViewId: string): void {
		const dataProvider = this._register(new TreeViewDataProvider(treeViewId, this._proxy, this.messageService));
		this._dataProviders.set(treeViewId, dataProvider);
		this.viewsService.getTreeViewer(treeViewId).dataProvider = dataProvider;
	}

	$refresh(treeViewId: string, itemsToRefresh: { [treeItemHandle: string]: ITreeItem }): void {
		const dataProvider = this._dataProviders.get(treeViewId);
		if (dataProvider) {
			dataProvider.refresh(itemsToRefresh);
		}
	}

	dispose(): void {
		this._dataProviders.clear();
		super.dispose();
	}
}

type TreeItemHandle = string;

class TreeViewDataProvider implements ITreeViewDataProvider {

	private _onDidChange: Emitter<ITreeItem[] | undefined | null> = new Emitter<ITreeItem[] | undefined | null>();
	readonly onDidChange: Event<ITreeItem[] | undefined | null> = this._onDidChange.event;

	private _onDispose: Emitter<void> = new Emitter<void>();
	readonly onDispose: Event<void> = this._onDispose.event;

	private itemsMap: Map<TreeItemHandle, ITreeItem> = new Map<TreeItemHandle, ITreeItem>();

	constructor(private treeViewId: string,
		private _proxy: ExtHostTreeViewsShape,
		private messageService: IMessageService
	) {
	}

	getChildren(treeItem?: ITreeItem): TPromise<ITreeItem[]> {
		if (treeItem && treeItem.children) {
			return TPromise.as(treeItem.children);
		}
		return this._proxy.$getChildren(this.treeViewId, treeItem ? treeItem.handle : void 0)
			.then(children => {
				return this.postGetChildren(children);
			}, err => {
				this.messageService.show(Severity.Error, err);
				return [];
			});
	}

	refresh(itemsToRefreshByHandle: { [treeItemHandle: string]: ITreeItem }) {
		if (itemsToRefreshByHandle) {
			const itemsToRefresh: ITreeItem[] = [];
			for (const treeItemHandle of Object.keys(itemsToRefreshByHandle)) {
				const currentTreeItem = this.itemsMap.get(treeItemHandle);
				if (currentTreeItem) { // Refresh only if the item exists
					const treeItem = itemsToRefreshByHandle[treeItemHandle];
					// Update the current item with refreshed item
					this.updateTreeItem(currentTreeItem, treeItem);
					if (treeItemHandle === treeItem.handle) {
						itemsToRefresh.push(currentTreeItem);
					} else {
						// Update maps when handle is changed and refresh parent
						this.itemsMap.delete(treeItemHandle);
						this.itemsMap.set(currentTreeItem.handle, currentTreeItem);
						itemsToRefresh.push(this.itemsMap.get(treeItem.parentHandle));
					}
				}
				if (itemsToRefresh.length) {
					this._onDidChange.fire(itemsToRefresh);
				}
			}
		} else {
			this._onDidChange.fire();
		}
	}

	private postGetChildren(elements: ITreeItem[]): ITreeItem[] {
		const result = [];
		if (elements) {
			for (const element of elements) {
				this.itemsMap.set(element.handle, element);
				result.push(element);
			}
		}
		return result;
	}

	private updateTreeItem(current: ITreeItem, treeItem: ITreeItem): void {
		treeItem.children = treeItem.children ? treeItem.children : null;
		if (current) {
			const properties = distinct([...Object.keys(current), ...Object.keys(treeItem)]);
			for (const property of properties) {
				current[property] = treeItem[property];
			}
		}
	}

	dispose(): void {
		this._onDispose.fire();
	}
}
