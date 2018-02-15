/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';

import { SpectronApplication, Quality } from '../../spectron/application';
import * as rimraf from 'rimraf';

export interface ICreateAppFn {
	(quality: Quality): SpectronApplication | null;
}

export function setup(userDataDir: string, createApp: ICreateAppFn) {

	describe('Data Migration', () => {
		afterEach(async function () {
			await new Promise((c, e) => rimraf(userDataDir, { maxBusyTries: 10 }, err => err ? e(err) : c()));
		});

		it('checks if the Untitled file is restored migrating from stable to latest', async function () {
			const stableApp = createApp(Quality.Stable);

			if (!stableApp) {
				this.skip();
				return;
			}

			await stableApp.start();
			stableApp.suiteName = 'Data Migration';

			const textToType = 'Very dirty file';

			await stableApp.workbench.newUntitledFile();
			await stableApp.workbench.editor.waitForTypeInEditor('Untitled-1', textToType);

			await stableApp.stop();
			await new Promise(c => setTimeout(c, 500)); // wait until all resources are released (e.g. locked local storage)

			// Checking latest version for the restored state
			const app = createApp(Quality.Insiders);

			if (!app) {
				return assert(false);
			}

			await app.start(false);
			app.suiteName = 'Data Migration';

			assert.ok(await app.workbench.waitForActiveTab('Untitled-1', true), `Untitled-1 tab is not present after migration.`);

			await app.workbench.editor.waitForEditorContents('Untitled-1', c => c.indexOf(textToType) > -1);
			await app.screenCapturer.capture('Untitled file text');

			await app.stop();
		});

		it('checks if the newly created dirty file is restored migrating from stable to latest', async function () {
			const stableApp = createApp(Quality.Stable);

			if (!stableApp) {
				this.skip();
				return;
			}

			await stableApp.start();
			stableApp.suiteName = 'Data Migration';

			const fileName = 'app.js';
			const textPart = 'This is going to be an unsaved file';

			await stableApp.workbench.quickopen.openFile(fileName);

			await stableApp.workbench.editor.waitForTypeInEditor(fileName, textPart);

			await stableApp.stop();
			await new Promise(c => setTimeout(c, 500)); // wait until all resources are released (e.g. locked local storage)

			// Checking latest version for the restored state
			const app = createApp(Quality.Insiders);

			if (!app) {
				return assert(false);
			}

			await app.start(false);
			app.suiteName = 'Data Migration';

			assert.ok(await app.workbench.waitForActiveTab(fileName), `dirty file tab is not present after migration.`);
			await app.workbench.editor.waitForEditorContents(fileName, c => c.indexOf(textPart) > -1);

			await app.stop();
		});

		it('checks if opened tabs are restored migrating from stable to latest', async function () {
			const stableApp = createApp(Quality.Stable);

			if (!stableApp) {
				this.skip();
				return;
			}

			await stableApp.start();
			stableApp.suiteName = 'Data Migration';

			const fileName1 = 'app.js', fileName2 = 'jsconfig.json', fileName3 = 'readme.md';

			await stableApp.workbench.quickopen.openFile(fileName1);
			await stableApp.workbench.quickopen.runCommand('View: Keep Editor');
			await stableApp.workbench.quickopen.openFile(fileName2);
			await stableApp.workbench.quickopen.runCommand('View: Keep Editor');
			await stableApp.workbench.quickopen.openFile(fileName3);
			await stableApp.stop();

			const app = createApp(Quality.Insiders);

			if (!app) {
				return assert(false);
			}

			await app.start(false);
			app.suiteName = 'Data Migration';

			assert.ok(await app.workbench.waitForTab(fileName1), `${fileName1} tab was not restored after migration.`);
			assert.ok(await app.workbench.waitForTab(fileName2), `${fileName2} tab was not restored after migration.`);
			assert.ok(await app.workbench.waitForTab(fileName3), `${fileName3} tab was not restored after migration.`);

			await app.stop();
		});
	});
}