/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { SpectronApplication, Quality } from '../../spectron/application';

export function setup() {
	describe('Extensions', () => {
		before(function () {
			this.app.suiteName = 'Extensions';
		});

		it(`install and activate vscode-smoketest-check extension`, async function () {
			const app = this.app as SpectronApplication;

			if (app.quality === Quality.Dev) {
				this.skip();
				return;
			}

			const extensionName = 'vscode-smoketest-check';
			await app.workbench.extensions.openExtensionsViewlet();

			const installed = await app.workbench.extensions.installExtension(extensionName);
			assert.ok(installed);

			await app.reload();
			await app.workbench.extensions.waitForExtensionsViewlet();
			await app.workbench.quickopen.runCommand('Smoke Test Check');

			const statusbarText = await app.workbench.statusbar.getStatusbarTextByTitle('smoke test');
			await app.screenCapturer.capture('Statusbar');
			assert.equal(statusbarText, 'VS Code Smoke Test Check');
		});
	});
}