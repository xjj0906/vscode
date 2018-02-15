/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { SpectronApplication } from '../../spectron/application';

export function setup() {
	describe('Multiroot', () => {

		before(async function () {
			this.app.suiteName = 'Multiroot';

			const app = this.app as SpectronApplication;

			// restart with preventing additional windows from restoring
			// to ensure the window after restart is the multi-root workspace
			await app.restart({ workspaceOrFolder: app.workspaceFilePath, extraArgs: ['--disable-restore-windows'] });
		});

		it('shows results from all folders', async function () {
			const app = this.app as SpectronApplication;
			await app.workbench.quickopen.openQuickOpen('*.*');

			await app.workbench.quickopen.waitForQuickOpenElements(names => names.length === 6);
			await app.workbench.quickopen.closeQuickOpen();
		});

		it('shows workspace name in title', async function () {
			const app = this.app as SpectronApplication;
			const title = await app.client.getTitle();
			await app.screenCapturer.capture('window title');
			assert.ok(title.indexOf('smoketest (Workspace)') >= 0);
		});
	});
}