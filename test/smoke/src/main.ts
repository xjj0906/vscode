/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as https from 'https';
import * as cp from 'child_process';
import * as path from 'path';
import * as minimist from 'minimist';
import * as tmp from 'tmp';
import * as rimraf from 'rimraf';
import * as mkdirp from 'mkdirp';
import { SpectronApplication, Quality } from './spectron/application';
import { setup as setupDataMigrationTests } from './areas/workbench/data-migration.test';

import { setup as setupDataLossTests } from './areas/workbench/data-loss.test';
import { setup as setupDataExplorerTests } from './areas/explorer/explorer.test';
import { setup as setupDataPreferencesTests } from './areas/preferences/preferences.test';
import { setup as setupDataSearchTests } from './areas/search/search.test';
import { setup as setupDataCSSTests } from './areas/css/css.test';
import { setup as setupDataEditorTests } from './areas/editor/editor.test';
import { setup as setupDataDebugTests } from './areas/debug/debug.test';
import { setup as setupDataGitTests } from './areas/git/git.test';
import { setup as setupDataStatusbarTests } from './areas/statusbar/statusbar.test';
import { setup as setupDataExtensionTests } from './areas/extensions/extensions.test';
import { setup as setupDataMultirootTests } from './areas/multiroot/multiroot.test';
import { setup as setupDataLocalizationTests } from './areas/workbench/localization.test';
// import './areas/terminal/terminal.test';

const tmpDir = tmp.dirSync({ prefix: 't' }) as { name: string; removeCallback: Function; };
const testDataPath = tmpDir.name;
process.once('exit', () => rimraf.sync(testDataPath));

const [, , ...args] = process.argv;
const opts = minimist(args, {
	string: [
		'build',
		'stable-build',
		'log',
		'wait-time'
	]
});

const artifactsPath = opts.log || '';

const workspaceFilePath = path.join(testDataPath, 'smoketest.code-workspace');
const testRepoUrl = 'https://github.com/Microsoft/vscode-smoketest-express';
const workspacePath = path.join(testDataPath, 'vscode-smoketest-express');
const keybindingsPath = path.join(testDataPath, 'keybindings.json');
const extensionsPath = path.join(testDataPath, 'extensions-dir');
mkdirp.sync(extensionsPath);

function fail(errorMessage): void {
	console.error(errorMessage);
	process.exit(1);
}

if (parseInt(process.version.substr(1)) < 6) {
	fail('Please update your Node version to greater than 6 to run the smoke test.');
}

const repoPath = path.join(__dirname, '..', '..', '..');

function getDevElectronPath(): string {
	const buildPath = path.join(repoPath, '.build');
	const product = require(path.join(repoPath, 'product.json'));

	switch (process.platform) {
		case 'darwin':
			return path.join(buildPath, 'electron', `${product.nameLong}.app`, 'Contents', 'MacOS', 'Electron');
		case 'linux':
			return path.join(buildPath, 'electron', `${product.applicationName}`);
		case 'win32':
			return path.join(buildPath, 'electron', `${product.nameShort}.exe`);
		default:
			throw new Error('Unsupported platform.');
	}
}

function getBuildElectronPath(root: string): string {
	switch (process.platform) {
		case 'darwin':
			return path.join(root, 'Contents', 'MacOS', 'Electron');
		case 'linux': {
			const product = require(path.join(root, 'resources', 'app', 'product.json'));
			return path.join(root, product.applicationName);
		}
		case 'win32': {
			const product = require(path.join(root, 'resources', 'app', 'product.json'));
			return path.join(root, `${product.nameShort}.exe`);
		}
		default:
			throw new Error('Unsupported platform.');
	}
}

let testCodePath = opts.build;
let stableCodePath = opts['stable-build'];
let electronPath: string;
let stablePath: string;

if (testCodePath) {
	electronPath = getBuildElectronPath(testCodePath);

	if (stableCodePath) {
		stablePath = getBuildElectronPath(stableCodePath);
	}
} else {
	testCodePath = getDevElectronPath();
	electronPath = testCodePath;
	process.env.VSCODE_REPOSITORY = repoPath;
	process.env.VSCODE_DEV = '1';
	process.env.VSCODE_CLI = '1';
}

if (!fs.existsSync(electronPath || '')) {
	fail(`Can't find Code at ${electronPath}.`);
}

const userDataDir = path.join(testDataPath, 'd');
// process.env.VSCODE_WORKSPACE_PATH = workspaceFilePath;
process.env.VSCODE_KEYBINDINGS_PATH = keybindingsPath;

let quality: Quality;
if (process.env.VSCODE_DEV === '1') {
	quality = Quality.Dev;
} else if (electronPath.indexOf('Code - Insiders') >= 0 /* macOS/Windows */ || electronPath.indexOf('code-insiders') /* Linux */ >= 0) {
	quality = Quality.Insiders;
} else {
	quality = Quality.Stable;
}

function getKeybindingPlatform(): string {
	switch (process.platform) {
		case 'darwin': return 'osx';
		case 'win32': return 'win';
		default: return process.platform;
	}
}

function toUri(path: string): string {
	if (process.platform === 'win32') {
		return `${path.replace(/\\/g, '/')}`;
	}

	return `${path}`;
}

async function setup(): Promise<void> {
	console.log('*** Test data:', testDataPath);
	console.log('*** Preparing smoketest setup...');

	const keybindingsUrl = `https://raw.githubusercontent.com/Microsoft/vscode-docs/master/build/keybindings/doc.keybindings.${getKeybindingPlatform()}.json`;
	console.log('*** Fetching keybindings...');

	await new Promise((c, e) => {
		https.get(keybindingsUrl, res => {
			const output = fs.createWriteStream(keybindingsPath);
			res.on('error', e);
			output.on('error', e);
			output.on('close', c);
			res.pipe(output);
		}).on('error', e);
	});

	if (!fs.existsSync(workspaceFilePath)) {
		console.log('*** Creating workspace file...');
		const workspace = {
			folders: [
				{
					path: toUri(path.join(workspacePath, 'public'))
				},
				{
					path: toUri(path.join(workspacePath, 'routes'))
				},
				{
					path: toUri(path.join(workspacePath, 'views'))
				}
			]
		};

		fs.writeFileSync(workspaceFilePath, JSON.stringify(workspace, null, '\t'));
	}

	if (!fs.existsSync(workspacePath)) {
		console.log('*** Cloning test project repository...');
		cp.spawnSync('git', ['clone', testRepoUrl, workspacePath]);
	} else {
		console.log('*** Cleaning test project repository...');
		cp.spawnSync('git', ['fetch'], { cwd: workspacePath });
		cp.spawnSync('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: workspacePath });
		cp.spawnSync('git', ['clean', '-xdf'], { cwd: workspacePath });
	}

	console.log('*** Running npm install...');
	cp.execSync('npm install', { cwd: workspacePath, stdio: 'inherit' });

	console.log('*** Smoketest setup done!\n');
}

/**
 * WebDriverIO 4.8.0 outputs all kinds of "deprecation" warnings
 * for common commands like `keys` and `moveToObject`.
 * According to https://github.com/Codeception/CodeceptJS/issues/531,
 * these deprecation warnings are for Firefox, and have no alternative replacements.
 * Since we can't downgrade WDIO as suggested (it's Spectron's dep, not ours),
 * we must suppress the warning with a classic monkey-patch.
 *
 * @see webdriverio/lib/helpers/depcrecationWarning.js
 * @see https://github.com/webdriverio/webdriverio/issues/2076
 */
// Filter out the following messages:
const wdioDeprecationWarning = /^WARNING: the "\w+" command will be deprecated soon../; // [sic]
// Monkey patch:
const warn = console.warn;
console.warn = function suppressWebdriverWarnings(message) {
	if (wdioDeprecationWarning.test(message)) { return; }
	warn.apply(console, arguments);
};

function createApp(quality: Quality): SpectronApplication | null {
	const path = quality === Quality.Stable ? stablePath : electronPath;

	if (!path) {
		return null;
	}

	return new SpectronApplication({
		quality,
		electronPath: path,
		workspacePath,
		userDataDir,
		extensionsPath,
		artifactsPath,
		workspaceFilePath,
		waitTime: parseInt(opts['wait-time'] || '0') || 20
	});
}
before(async function () {
	// allow two minutes for setup
	this.timeout(2 * 60 * 1000);
	await setup();
});

after(async function () {
	await new Promise((c, e) => rimraf(testDataPath, { maxBusyTries: 10 }, err => err ? e(err) : c()));
});

describe('Data Migration', () => {
	setupDataMigrationTests(userDataDir, createApp);
});

describe('Everything Else', () => {
	before(async function () {
		const app = createApp(quality);
		await app!.start();
		this.app = app;
	});

	after(async function () {
		await this.app.stop();
	});

	setupDataLossTests();
	setupDataExplorerTests();
	setupDataPreferencesTests();
	setupDataSearchTests();
	setupDataCSSTests();
	setupDataEditorTests();
	setupDataDebugTests();
	setupDataGitTests();
	setupDataStatusbarTests();
	setupDataExtensionTests();
	setupDataMultirootTests();
	setupDataLocalizationTests();
});
