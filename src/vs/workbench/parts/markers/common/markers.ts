/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { MarkersModel, FilterOptions } from 'vs/workbench/parts/markers/common/markersModel';
import { Disposable } from 'vs/base/common/lifecycle';
import { IMarkerService } from 'vs/platform/markers/common/markers';
import { IActivityService, NumberBadge } from 'vs/workbench/services/activity/common/activity';
import { localize } from 'vs/nls';
import Constants from 'vs/workbench/parts/markers/common/constants';
import URI from 'vs/base/common/uri';
import Event, { Emitter } from 'vs/base/common/event';

export const IMarkersWorkbenchService = createDecorator<IMarkersWorkbenchService>('markersWorkbenchService');

export interface IMarkersWorkbenchService {
	_serviceBrand: any;

	readonly onDidChangeMarkersForResources: Event<URI[]>;
	readonly markersModel: MarkersModel;

	filter(filter: string): void;
}

export class MarkersWorkbenchService extends Disposable implements IMarkersWorkbenchService {
	_serviceBrand: any;

	readonly markersModel: MarkersModel;

	private readonly _onDidChangeMarkersForResources: Emitter<URI[]> = this._register(new Emitter<URI[]>());
	readonly onDidChangeMarkersForResources: Event<URI[]> = this._onDidChangeMarkersForResources.event;

	constructor(
		@IMarkerService private markerService: IMarkerService,
		@IActivityService private activityService: IActivityService
	) {
		super();
		this.markersModel = this._register(new MarkersModel(this.markerService.read()));
		this._register(markerService.onMarkerChanged(resources => this.onMarkerChanged(resources)));
	}

	filter(filter: string): void {
		this.markersModel.update(new FilterOptions(filter));
		this.refreshBadge();
	}

	private onMarkerChanged(resources: URI[]): void {
		const bulkUpdater = this.markersModel.getBulkUpdater();
		for (const resource of resources) {
			bulkUpdater.add(resource, this.markerService.read({ resource }));
		}
		bulkUpdater.done();
		this.refreshBadge();
		this._onDidChangeMarkersForResources.fire(resources);
	}

	private refreshBadge(): void {
		const total = this.markersModel.total();
		const count = this.markersModel.count();
		const message = total === count ? localize('totalProblems', 'Total {0} Problems', total) : localize('filteredProblems', 'Showing {0} of {1} Problems', count, total);
		this.activityService.showActivity(Constants.MARKERS_PANEL_ID, new NumberBadge(count, () => message));
	}
}