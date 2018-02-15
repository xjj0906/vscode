/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import fs = require('fs');
import path = require('path');
import os = require('os');
import assert = require('assert');

import { TPromise } from 'vs/base/common/winjs.base';
import { FileService, IEncodingOverride } from 'vs/workbench/services/files/node/fileService';
import { FileOperation, FileOperationEvent, FileChangesEvent, FileOperationResult, FileOperationError } from 'vs/platform/files/common/files';
import uri from 'vs/base/common/uri';
import uuid = require('vs/base/common/uuid');
import extfs = require('vs/base/node/extfs');
import encodingLib = require('vs/base/node/encoding');
import utils = require('vs/workbench/services/files/test/node/utils');
import { onError } from 'vs/base/test/common/utils';
import { TestEnvironmentService, TestContextService, TestTextResourceConfigurationService, getRandomTestPath, TestLifecycleService } from 'vs/workbench/test/workbenchTestServices';
import { Workspace, toWorkspaceFolders } from 'vs/platform/workspace/common/workspace';
import { TestConfigurationService } from 'vs/platform/configuration/test/common/testConfigurationService';
import { TextModel } from 'vs/editor/common/model/textModel';

suite('FileService', () => {
	let service: FileService;
	const parentDir = getRandomTestPath(os.tmpdir(), 'vsctests', 'fileservice');
	let testDir: string;

	setup(function (done) {
		const id = uuid.generateUuid();
		testDir = path.join(parentDir, id);
		const sourceDir = require.toUrl('./fixtures/service');

		extfs.copy(sourceDir, testDir, (error) => {
			if (error) {
				return onError(error, done);
			}

			service = new FileService(new TestContextService(new Workspace(testDir, testDir, toWorkspaceFolders([{ path: testDir }]))), TestEnvironmentService, new TestTextResourceConfigurationService(), new TestConfigurationService(), new TestLifecycleService(), { disableWatcher: true });
			done();
		});
	});

	teardown((done) => {
		service.dispose();
		extfs.del(parentDir, os.tmpdir(), () => { }, done);
	});

	test('createFile', function (done: () => void) {
		let event: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			event = e;
		});

		const contents = 'Hello World';
		const resource = uri.file(path.join(testDir, 'test.txt'));
		service.createFile(resource, contents).done(s => {
			assert.equal(s.name, 'test.txt');
			assert.equal(fs.existsSync(s.resource.fsPath), true);
			assert.equal(fs.readFileSync(s.resource.fsPath), contents);

			assert.ok(event);
			assert.equal(event.resource.fsPath, resource.fsPath);
			assert.equal(event.operation, FileOperation.CREATE);
			assert.equal(event.target.resource.fsPath, resource.fsPath);
			toDispose.dispose();

			done();
		}, error => onError(error, done));
	});

	test('createFile (does not overwrite by default)', function (done: () => void) {
		const contents = 'Hello World';
		const resource = uri.file(path.join(testDir, 'test.txt'));

		fs.writeFileSync(resource.fsPath, ''); // create file

		service.createFile(resource, contents).done(null, error => {
			assert.ok(error);

			done();
		});
	});

	test('createFile (allows to overwrite existing)', function (done: () => void) {
		let event: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			event = e;
		});

		const contents = 'Hello World';
		const resource = uri.file(path.join(testDir, 'test.txt'));

		fs.writeFileSync(resource.fsPath, ''); // create file

		service.createFile(resource, contents, { overwrite: true }).done(s => {
			assert.equal(s.name, 'test.txt');
			assert.equal(fs.existsSync(s.resource.fsPath), true);
			assert.equal(fs.readFileSync(s.resource.fsPath), contents);

			assert.ok(event);
			assert.equal(event.resource.fsPath, resource.fsPath);
			assert.equal(event.operation, FileOperation.CREATE);
			assert.equal(event.target.resource.fsPath, resource.fsPath);
			toDispose.dispose();

			done();
		}, error => onError(error, done));
	});

	test('createFolder', function (done: () => void) {
		let event: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			event = e;
		});

		service.resolveFile(uri.file(testDir)).done(parent => {
			const resource = uri.file(path.join(parent.resource.fsPath, 'newFolder'));

			return service.createFolder(resource).then(f => {
				assert.equal(f.name, 'newFolder');
				assert.equal(fs.existsSync(f.resource.fsPath), true);

				assert.ok(event);
				assert.equal(event.resource.fsPath, resource.fsPath);
				assert.equal(event.operation, FileOperation.CREATE);
				assert.equal(event.target.resource.fsPath, resource.fsPath);
				assert.equal(event.target.isDirectory, true);
				toDispose.dispose();

				done();
			});
		}, error => onError(error, done));
	});

	test('touchFile', function (done: () => void) {
		service.touchFile(uri.file(path.join(testDir, 'test.txt'))).done(s => {
			assert.equal(s.name, 'test.txt');
			assert.equal(fs.existsSync(s.resource.fsPath), true);
			assert.equal(fs.readFileSync(s.resource.fsPath).length, 0);

			const stat = fs.statSync(s.resource.fsPath);

			return TPromise.timeout(10).then(() => {
				return service.touchFile(s.resource).done(s => {
					const statNow = fs.statSync(s.resource.fsPath);
					assert.ok(statNow.mtime.getTime() >= stat.mtime.getTime()); // one some OS the resolution seems to be 1s, so we use >= here
					assert.equal(statNow.size, stat.size);

					done();
				});
			});
		}, error => onError(error, done));
	});

	test('renameFile', function (done: () => void) {
		let event: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			event = e;
		});

		const resource = uri.file(path.join(testDir, 'index.html'));
		service.resolveFile(resource).done(source => {
			return service.rename(source.resource, 'other.html').then(renamed => {
				assert.equal(fs.existsSync(renamed.resource.fsPath), true);
				assert.equal(fs.existsSync(source.resource.fsPath), false);

				assert.ok(event);
				assert.equal(event.resource.fsPath, resource.fsPath);
				assert.equal(event.operation, FileOperation.MOVE);
				assert.equal(event.target.resource.fsPath, renamed.resource.fsPath);
				toDispose.dispose();

				done();
			});
		}, error => onError(error, done));
	});

	test('renameFolder', function (done: () => void) {
		let event: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			event = e;
		});

		const resource = uri.file(path.join(testDir, 'deep'));
		service.resolveFile(resource).done(source => {
			return service.rename(source.resource, 'deeper').then(renamed => {
				assert.equal(fs.existsSync(renamed.resource.fsPath), true);
				assert.equal(fs.existsSync(source.resource.fsPath), false);

				assert.ok(event);
				assert.equal(event.resource.fsPath, resource.fsPath);
				assert.equal(event.operation, FileOperation.MOVE);
				assert.equal(event.target.resource.fsPath, renamed.resource.fsPath);
				toDispose.dispose();

				done();
			});
		});
	});

	test('renameFile - MIX CASE', function (done: () => void) {
		let event: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			event = e;
		});

		const resource = uri.file(path.join(testDir, 'index.html'));
		service.resolveFile(resource).done(source => {
			return service.rename(source.resource, 'INDEX.html').then(renamed => {
				assert.equal(fs.existsSync(renamed.resource.fsPath), true);
				assert.equal(path.basename(renamed.resource.fsPath), 'INDEX.html');

				assert.ok(event);
				assert.equal(event.resource.fsPath, resource.fsPath);
				assert.equal(event.operation, FileOperation.MOVE);
				assert.equal(event.target.resource.fsPath, renamed.resource.fsPath);
				toDispose.dispose();

				done();
			});
		}, error => onError(error, done));
	});

	test('moveFile', function (done: () => void) {
		let event: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			event = e;
		});

		const resource = uri.file(path.join(testDir, 'index.html'));
		service.resolveFile(resource).done(source => {
			return service.moveFile(source.resource, uri.file(path.join(testDir, 'other.html'))).then(renamed => {
				assert.equal(fs.existsSync(renamed.resource.fsPath), true);
				assert.equal(fs.existsSync(source.resource.fsPath), false);

				assert.ok(event);
				assert.equal(event.resource.fsPath, resource.fsPath);
				assert.equal(event.operation, FileOperation.MOVE);
				assert.equal(event.target.resource.fsPath, renamed.resource.fsPath);
				toDispose.dispose();

				done();
			});
		}, error => onError(error, done));
	});

	test('move - FILE_MOVE_CONFLICT', function (done: () => void) {
		let event: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			event = e;
		});

		service.resolveFile(uri.file(path.join(testDir, 'index.html'))).done(source => {
			return service.moveFile(source.resource, uri.file(path.join(testDir, 'binary.txt'))).then(null, (e: FileOperationError) => {
				assert.equal(e.fileOperationResult, FileOperationResult.FILE_MOVE_CONFLICT);

				assert.ok(!event);
				toDispose.dispose();

				done();
			});
		}, error => onError(error, done));
	});

	test('moveFile - MIX CASE', function (done: () => void) {
		let event: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			event = e;
		});

		const resource = uri.file(path.join(testDir, 'index.html'));
		service.resolveFile(resource).done(source => {
			return service.moveFile(source.resource, uri.file(path.join(testDir, 'INDEX.html'))).then(renamed => {
				assert.equal(fs.existsSync(renamed.resource.fsPath), true);
				assert.equal(path.basename(renamed.resource.fsPath), 'INDEX.html');

				assert.ok(event);
				assert.equal(event.resource.fsPath, resource.fsPath);
				assert.equal(event.operation, FileOperation.MOVE);
				assert.equal(event.target.resource.fsPath, renamed.resource.fsPath);
				toDispose.dispose();

				done();
			});
		}, error => onError(error, done));
	});

	test('moveFile - overwrite folder with file', function (done: () => void) {
		let createEvent: FileOperationEvent;
		let moveEvent: FileOperationEvent;
		let deleteEvent: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			if (e.operation === FileOperation.CREATE) {
				createEvent = e;
			} else if (e.operation === FileOperation.DELETE) {
				deleteEvent = e;
			} else if (e.operation === FileOperation.MOVE) {
				moveEvent = e;
			}
		});

		service.resolveFile(uri.file(testDir)).done(parent => {
			const folderResource = uri.file(path.join(parent.resource.fsPath, 'conway.js'));
			return service.createFolder(folderResource).then(f => {
				const resource = uri.file(path.join(testDir, 'deep', 'conway.js'));
				return service.moveFile(resource, f.resource, true).then(moved => {
					assert.equal(fs.existsSync(moved.resource.fsPath), true);
					assert.ok(fs.statSync(moved.resource.fsPath).isFile);

					assert.ok(createEvent);
					assert.ok(deleteEvent);
					assert.ok(moveEvent);

					assert.equal(moveEvent.resource.fsPath, resource.fsPath);
					assert.equal(moveEvent.target.resource.fsPath, moved.resource.fsPath);

					assert.equal(deleteEvent.resource.fsPath, folderResource.fsPath);

					toDispose.dispose();

					done();
				});
			});
		}, error => onError(error, done));
	});

	test('copyFile', function (done: () => void) {
		let event: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			event = e;
		});

		service.resolveFile(uri.file(path.join(testDir, 'index.html'))).done(source => {
			const resource = uri.file(path.join(testDir, 'other.html'));
			return service.copyFile(source.resource, resource).then(copied => {
				assert.equal(fs.existsSync(copied.resource.fsPath), true);
				assert.equal(fs.existsSync(source.resource.fsPath), true);

				assert.ok(event);
				assert.equal(event.resource.fsPath, source.resource.fsPath);
				assert.equal(event.operation, FileOperation.COPY);
				assert.equal(event.target.resource.fsPath, copied.resource.fsPath);
				toDispose.dispose();

				done();
			});
		}, error => onError(error, done));
	});

	test('copyFile - overwrite folder with file', function (done: () => void) {
		let createEvent: FileOperationEvent;
		let copyEvent: FileOperationEvent;
		let deleteEvent: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			if (e.operation === FileOperation.CREATE) {
				createEvent = e;
			} else if (e.operation === FileOperation.DELETE) {
				deleteEvent = e;
			} else if (e.operation === FileOperation.COPY) {
				copyEvent = e;
			}
		});

		service.resolveFile(uri.file(testDir)).done(parent => {
			const folderResource = uri.file(path.join(parent.resource.fsPath, 'conway.js'));
			return service.createFolder(folderResource).then(f => {
				const resource = uri.file(path.join(testDir, 'deep', 'conway.js'));
				return service.copyFile(resource, f.resource, true).then(copied => {
					assert.equal(fs.existsSync(copied.resource.fsPath), true);
					assert.ok(fs.statSync(copied.resource.fsPath).isFile);

					assert.ok(createEvent);
					assert.ok(deleteEvent);
					assert.ok(copyEvent);

					assert.equal(copyEvent.resource.fsPath, resource.fsPath);
					assert.equal(copyEvent.target.resource.fsPath, copied.resource.fsPath);

					assert.equal(deleteEvent.resource.fsPath, folderResource.fsPath);

					toDispose.dispose();

					done();
				});
			});
		}, error => onError(error, done));
	});

	test('importFile', function (done: () => void) {
		let event: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			event = e;
		});

		service.resolveFile(uri.file(path.join(testDir, 'deep'))).done(target => {
			const resource = uri.file(require.toUrl('./fixtures/service/index.html'));
			return service.importFile(resource, target.resource).then(res => {
				assert.equal(res.isNew, true);
				assert.equal(fs.existsSync(res.stat.resource.fsPath), true);

				assert.ok(event);
				assert.equal(event.resource.fsPath, resource.fsPath);
				assert.equal(event.operation, FileOperation.IMPORT);
				assert.equal(event.target.resource.fsPath, res.stat.resource.fsPath);
				toDispose.dispose();

				done();
			});
		}, error => onError(error, done));
	});

	test('importFile - MIX CASE', function (done: () => void) {
		service.resolveFile(uri.file(path.join(testDir, 'index.html'))).done(source => {
			return service.rename(source.resource, 'CONWAY.js').then(renamed => { // index.html => CONWAY.js
				assert.equal(fs.existsSync(renamed.resource.fsPath), true);
				assert.ok(fs.readdirSync(testDir).some(f => f === 'CONWAY.js'));

				return service.resolveFile(uri.file(path.join(testDir, 'deep', 'conway.js'))).done(source => {
					return service.importFile(source.resource, uri.file(testDir)).then(res => { // CONWAY.js => conway.js
						assert.equal(fs.existsSync(res.stat.resource.fsPath), true);
						assert.ok(fs.readdirSync(testDir).some(f => f === 'conway.js'));

						done();
					});
				});
			});
		}, error => onError(error, done));
	});

	test('importFile - overwrite folder with file', function (done: () => void) {
		let createEvent: FileOperationEvent;
		let importEvent: FileOperationEvent;
		let deleteEvent: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			if (e.operation === FileOperation.CREATE) {
				createEvent = e;
			} else if (e.operation === FileOperation.DELETE) {
				deleteEvent = e;
			} else if (e.operation === FileOperation.IMPORT) {
				importEvent = e;
			}
		});

		service.resolveFile(uri.file(testDir)).done(parent => {
			const folderResource = uri.file(path.join(parent.resource.fsPath, 'conway.js'));
			return service.createFolder(folderResource).then(f => {
				const resource = uri.file(path.join(testDir, 'deep', 'conway.js'));
				return service.importFile(resource, uri.file(testDir)).then(res => {
					assert.equal(fs.existsSync(res.stat.resource.fsPath), true);
					assert.ok(fs.readdirSync(testDir).some(f => f === 'conway.js'));
					assert.ok(fs.statSync(res.stat.resource.fsPath).isFile);

					assert.ok(createEvent);
					assert.ok(deleteEvent);
					assert.ok(importEvent);

					assert.equal(importEvent.resource.fsPath, resource.fsPath);
					assert.equal(importEvent.target.resource.fsPath, res.stat.resource.fsPath);

					assert.equal(deleteEvent.resource.fsPath, folderResource.fsPath);

					toDispose.dispose();

					done();
				});
			});
		}, error => onError(error, done));
	});

	test('importFile - same file', function (done: () => void) {
		service.resolveFile(uri.file(path.join(testDir, 'index.html'))).done(source => {
			return service.importFile(source.resource, uri.file(path.dirname(source.resource.fsPath))).then(imported => {
				assert.equal(imported.stat.size, source.size);

				done();
			});
		}, error => onError(error, done));
	});

	test('deleteFile', function (done: () => void) {
		let event: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			event = e;
		});

		const resource = uri.file(path.join(testDir, 'deep', 'conway.js'));
		service.resolveFile(resource).done(source => {
			return service.del(source.resource).then(() => {
				assert.equal(fs.existsSync(source.resource.fsPath), false);

				assert.ok(event);
				assert.equal(event.resource.fsPath, resource.fsPath);
				assert.equal(event.operation, FileOperation.DELETE);
				toDispose.dispose();

				done();
			});
		}, error => onError(error, done));
	});

	test('deleteFolder', function (done: () => void) {
		let event: FileOperationEvent;
		const toDispose = service.onAfterOperation(e => {
			event = e;
		});

		const resource = uri.file(path.join(testDir, 'deep'));
		service.resolveFile(resource).done(source => {
			return service.del(source.resource).then(() => {
				assert.equal(fs.existsSync(source.resource.fsPath), false);

				assert.ok(event);
				assert.equal(event.resource.fsPath, resource.fsPath);
				assert.equal(event.operation, FileOperation.DELETE);
				toDispose.dispose();

				done();
			});
		}, error => onError(error, done));
	});

	test('resolveFile', function (done: () => void) {
		service.resolveFile(uri.file(testDir), { resolveTo: [uri.file(path.join(testDir, 'deep'))] }).done(r => {
			assert.equal(r.children.length, 8);

			const deep = utils.getByName(r, 'deep');
			assert.equal(deep.children.length, 4);

			done();
		}, error => onError(error, done));
	});

	test('resolveFiles', function (done: () => void) {
		service.resolveFiles([
			{ resource: uri.file(testDir), options: { resolveTo: [uri.file(path.join(testDir, 'deep'))] } },
			{ resource: uri.file(path.join(testDir, 'deep')) }
		]).then(res => {
			const r1 = res[0].stat;

			assert.equal(r1.children.length, 8);

			const deep = utils.getByName(r1, 'deep');
			assert.equal(deep.children.length, 4);

			const r2 = res[1].stat;
			assert.equal(r2.children.length, 4);
			assert.equal(r2.name, 'deep');

			done();
		}, error => onError(error, done));
	});

	test('existsFile', function (done: () => void) {
		service.existsFile(uri.file(testDir)).then((exists) => {
			assert.equal(exists, true);

			service.existsFile(uri.file(testDir + 'something')).then((exists) => {
				assert.equal(exists, false);

				done();
			});
		}, error => onError(error, done));
	});

	test('updateContent', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'small.txt'));

		service.resolveContent(resource).done(c => {
			assert.equal(c.value, 'Small File');

			c.value = 'Updates to the small file';

			return service.updateContent(c.resource, c.value).then(c => {
				assert.equal(fs.readFileSync(resource.fsPath), 'Updates to the small file');

				done();
			});
		}, error => onError(error, done));
	});

	test('updateContent (ITextSnapShot)', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'small.txt'));

		service.resolveContent(resource).done(c => {
			assert.equal(c.value, 'Small File');

			const model = TextModel.createFromString('Updates to the small file');

			return service.updateContent(c.resource, model.createSnapshot()).then(c => {
				assert.equal(fs.readFileSync(resource.fsPath), 'Updates to the small file');

				model.dispose();

				done();
			});
		}, error => onError(error, done));
	});

	test('updateContent (large file)', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'lorem.txt'));

		service.resolveContent(resource).done(c => {
			const newValue = c.value + c.value;
			c.value = newValue;

			return service.updateContent(c.resource, c.value).then(c => {
				assert.equal(fs.readFileSync(resource.fsPath), newValue);

				done();
			});
		}, error => onError(error, done));
	});

	test('updateContent (large file, ITextSnapShot)', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'lorem.txt'));

		service.resolveContent(resource).done(c => {
			const newValue = c.value + c.value;
			const model = TextModel.createFromString(newValue);

			return service.updateContent(c.resource, model.createSnapshot()).then(c => {
				assert.equal(fs.readFileSync(resource.fsPath), newValue);

				done();
			});
		}, error => onError(error, done));
	});

	test('updateContent - use encoding (UTF 16 BE)', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'small.txt'));
		const encoding = 'utf16be';

		service.resolveContent(resource).done(c => {
			c.encoding = encoding;

			return service.updateContent(c.resource, c.value, { encoding: encoding }).then(c => {
				return encodingLib.detectEncodingByBOM(c.resource.fsPath).then((enc) => {
					assert.equal(enc, encodingLib.UTF16be);

					return service.resolveContent(resource).then(c => {
						assert.equal(c.encoding, encoding);

						done();
					});
				});
			});
		}, error => onError(error, done));
	});

	test('updateContent - use encoding (UTF 16 BE, ITextSnapShot)', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'small.txt'));
		const encoding = 'utf16be';

		service.resolveContent(resource).done(c => {
			c.encoding = encoding;

			const model = TextModel.createFromString(c.value);

			return service.updateContent(c.resource, model.createSnapshot(), { encoding: encoding }).then(c => {
				return encodingLib.detectEncodingByBOM(c.resource.fsPath).then((enc) => {
					assert.equal(enc, encodingLib.UTF16be);

					return service.resolveContent(resource).then(c => {
						assert.equal(c.encoding, encoding);

						model.dispose();

						done();
					});
				});
			});
		}, error => onError(error, done));
	});

	test('updateContent - encoding preserved (UTF 16 LE)', function (done: () => void) {
		const encoding = 'utf16le';
		const resource = uri.file(path.join(testDir, 'some_utf16le.css'));

		service.resolveContent(resource).done(c => {
			assert.equal(c.encoding, encoding);

			c.value = 'Some updates';

			return service.updateContent(c.resource, c.value, { encoding: encoding }).then(c => {
				return encodingLib.detectEncodingByBOM(c.resource.fsPath).then((enc) => {
					assert.equal(enc, encodingLib.UTF16le);

					return service.resolveContent(resource).then(c => {
						assert.equal(c.encoding, encoding);

						done();
					});
				});
			});
		}, error => onError(error, done));
	});

	test('updateContent - encoding preserved (UTF 16 LE, ITextSnapShot)', function (done: () => void) {
		const encoding = 'utf16le';
		const resource = uri.file(path.join(testDir, 'some_utf16le.css'));

		service.resolveContent(resource).done(c => {
			assert.equal(c.encoding, encoding);

			const model = TextModel.createFromString('Some updates');

			return service.updateContent(c.resource, model.createSnapshot(), { encoding: encoding }).then(c => {
				return encodingLib.detectEncodingByBOM(c.resource.fsPath).then((enc) => {
					assert.equal(enc, encodingLib.UTF16le);

					return service.resolveContent(resource).then(c => {
						assert.equal(c.encoding, encoding);

						model.dispose();

						done();
					});
				});
			});
		}, error => onError(error, done));
	});

	test('resolveContent - large file', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'lorem.txt'));

		service.resolveContent(resource).done(c => {
			assert.ok(c.value.length > 64000);

			done();
		}, error => onError(error, done));
	});

	test('Files are intermingled #38331', function () {
		let resource1 = uri.file(path.join(testDir, 'lorem.txt'));
		let resource2 = uri.file(path.join(testDir, 'some_utf16le.css'));
		let value1: string;
		let value2: string;
		// load in sequence and keep data
		return service.resolveContent(resource1).then(c => value1 = c.value).then(() => {
			return service.resolveContent(resource2).then(c => value2 = c.value);
		}).then(() => {
			// load in parallel in expect the same result
			return TPromise.join([
				service.resolveContent(resource1).then(c => assert.equal(c.value, value1)),
				service.resolveContent(resource2).then(c => assert.equal(c.value, value2))
			]);
		});
	});

	test('resolveContent - FILE_IS_BINARY', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'binary.txt'));

		service.resolveContent(resource, { acceptTextOnly: true }).done(null, (e: FileOperationError) => {
			assert.equal(e.fileOperationResult, FileOperationResult.FILE_IS_BINARY);

			return service.resolveContent(uri.file(path.join(testDir, 'small.txt')), { acceptTextOnly: true }).then(r => {
				assert.equal(r.name, 'small.txt');

				done();
			});
		}, error => onError(error, done));
	});

	test('resolveContent - FILE_IS_DIRECTORY', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'deep'));

		service.resolveContent(resource).done(null, (e: FileOperationError) => {
			assert.equal(e.fileOperationResult, FileOperationResult.FILE_IS_DIRECTORY);

			done();
		}, error => onError(error, done));
	});

	test('resolveContent - FILE_NOT_FOUND', function (done: () => void) {
		const resource = uri.file(path.join(testDir, '404.html'));

		service.resolveContent(resource).done(null, (e: FileOperationError) => {
			assert.equal(e.fileOperationResult, FileOperationResult.FILE_NOT_FOUND);

			done();
		}, error => onError(error, done));
	});

	test('resolveContent - FILE_NOT_MODIFIED_SINCE', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'index.html'));

		service.resolveContent(resource).done(c => {
			return service.resolveContent(resource, { etag: c.etag }).then(null, (e: FileOperationError) => {
				assert.equal(e.fileOperationResult, FileOperationResult.FILE_NOT_MODIFIED_SINCE);

				done();
			});
		}, error => onError(error, done));
	});

	test('resolveContent - FILE_MODIFIED_SINCE', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'index.html'));

		service.resolveContent(resource).done(c => {
			fs.writeFileSync(resource.fsPath, 'Updates Incoming!');

			return service.updateContent(resource, c.value, { etag: c.etag, mtime: c.mtime - 1000 }).then(null, (e: FileOperationError) => {
				assert.equal(e.fileOperationResult, FileOperationResult.FILE_MODIFIED_SINCE);

				done();
			});
		}, error => onError(error, done));
	});

	test('resolveContent - encoding picked up', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'index.html'));
		const encoding = 'windows1252';

		service.resolveContent(resource, { encoding: encoding }).done(c => {
			assert.equal(c.encoding, encoding);

			done();
		}, error => onError(error, done));
	});

	test('resolveContent - user overrides BOM', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'some_utf16le.css'));

		service.resolveContent(resource, { encoding: 'windows1252' }).done(c => {
			assert.equal(c.encoding, 'windows1252');

			done();
		}, error => onError(error, done));
	});

	test('resolveContent - BOM removed', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'some_utf8_bom.txt'));

		service.resolveContent(resource).done(c => {
			assert.equal(encodingLib.detectEncodingByBOMFromBuffer(new Buffer(c.value), 512), null);

			done();
		}, error => onError(error, done));
	});

	test('resolveContent - invalid encoding', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'index.html'));

		service.resolveContent(resource, { encoding: 'superduper' }).done(c => {
			assert.equal(c.encoding, 'utf8');

			done();
		}, error => onError(error, done));
	});

	test('watchFileChanges', function (done: () => void) {
		const toWatch = uri.file(path.join(testDir, 'index.html'));

		service.watchFileChanges(toWatch);

		service.onFileChanges((e: FileChangesEvent) => {
			assert.ok(e);

			service.unwatchFileChanges(toWatch);
			done();
		});

		setTimeout(() => {
			fs.writeFileSync(toWatch.fsPath, 'Changes');
		}, 100);
	});

	test('watchFileChanges - support atomic save', function (done: () => void) {
		const toWatch = uri.file(path.join(testDir, 'index.html'));

		service.watchFileChanges(toWatch);

		service.onFileChanges((e: FileChangesEvent) => {
			assert.ok(e);

			service.unwatchFileChanges(toWatch);
			done();
		});

		setTimeout(() => {
			// Simulate atomic save by deleting the file, creating it under different name
			// and then replacing the previously deleted file with those contents
			const renamed = `${toWatch.fsPath}.bak`;
			fs.unlinkSync(toWatch.fsPath);
			fs.writeFileSync(renamed, 'Changes');
			fs.renameSync(renamed, toWatch.fsPath);
		}, 100);
	});

	test('options - encoding', function (done: () => void) {

		// setup
		const _id = uuid.generateUuid();
		const _testDir = path.join(parentDir, _id);
		const _sourceDir = require.toUrl('./fixtures/service');

		extfs.copy(_sourceDir, _testDir, () => {
			const encodingOverride: IEncodingOverride[] = [];
			encodingOverride.push({
				resource: uri.file(path.join(testDir, 'deep')),
				encoding: 'utf16le'
			});

			const configurationService = new TestConfigurationService();
			configurationService.setUserConfiguration('files', { encoding: 'windows1252' });

			const textResourceConfigurationService = new TestTextResourceConfigurationService(configurationService);

			const _service = new FileService(new TestContextService(new Workspace(_testDir, _testDir, toWorkspaceFolders([{ path: _testDir }]))), TestEnvironmentService, textResourceConfigurationService, configurationService, new TestLifecycleService(), {
				encodingOverride,
				disableWatcher: true
			});

			_service.resolveContent(uri.file(path.join(testDir, 'index.html'))).done(c => {
				assert.equal(c.encoding, 'windows1252');

				return _service.resolveContent(uri.file(path.join(testDir, 'deep', 'conway.js'))).done(c => {
					assert.equal(c.encoding, 'utf16le');

					// teardown
					_service.dispose();
					done();
				});
			});
		});
	});

	test('UTF 8 BOMs', function (done: () => void) {

		// setup
		const _id = uuid.generateUuid();
		const _testDir = path.join(parentDir, _id);
		const _sourceDir = require.toUrl('./fixtures/service');
		const resource = uri.file(path.join(testDir, 'index.html'));

		const _service = new FileService(new TestContextService(new Workspace(_testDir, _testDir, toWorkspaceFolders([{ path: _testDir }]))), TestEnvironmentService, new TestTextResourceConfigurationService(), new TestConfigurationService(), new TestLifecycleService(), {
			disableWatcher: true
		});

		extfs.copy(_sourceDir, _testDir, () => {
			fs.readFile(resource.fsPath, (error, data) => {
				assert.equal(encodingLib.detectEncodingByBOMFromBuffer(data, 512), null);

				const model = TextModel.createFromString('Hello Bom');

				// Update content: UTF_8 => UTF_8_BOM
				_service.updateContent(resource, model.createSnapshot(), { encoding: encodingLib.UTF8_with_bom }).done(() => {
					fs.readFile(resource.fsPath, (error, data) => {
						assert.equal(encodingLib.detectEncodingByBOMFromBuffer(data, 512), encodingLib.UTF8);

						// Update content: PRESERVE BOM when using UTF-8
						model.setValue('Please stay Bom');
						_service.updateContent(resource, model.createSnapshot(), { encoding: encodingLib.UTF8 }).done(() => {
							fs.readFile(resource.fsPath, (error, data) => {
								assert.equal(encodingLib.detectEncodingByBOMFromBuffer(data, 512), encodingLib.UTF8);

								// Update content: REMOVE BOM
								model.setValue('Go away Bom');
								_service.updateContent(resource, model.createSnapshot(), { encoding: encodingLib.UTF8, overwriteEncoding: true }).done(() => {
									fs.readFile(resource.fsPath, (error, data) => {
										assert.equal(encodingLib.detectEncodingByBOMFromBuffer(data, 512), null);

										// Update content: BOM comes not back
										model.setValue('Do not come back Bom');
										_service.updateContent(resource, model.createSnapshot(), { encoding: encodingLib.UTF8 }).done(() => {
											fs.readFile(resource.fsPath, (error, data) => {
												assert.equal(encodingLib.detectEncodingByBOMFromBuffer(data, 512), null);

												model.dispose();
												_service.dispose();
												done();
											});
										});
									});
								});
							});
						});
					});
				});
			});
		});
	});

	test('resolveContent - from position (ASCII)', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'small.txt'));

		service.resolveContent(resource, { position: 6 }).done(content => {
			assert.equal(content.value, 'File');
			done();
		}, error => onError(error, done));
	});

	test('resolveContent - from position (with umlaut)', function (done: () => void) {
		const resource = uri.file(path.join(testDir, 'small_umlaut.txt'));

		service.resolveContent(resource, { position: new Buffer('Small File with Ü').length }).done(content => {
			assert.equal(content.value, 'mlaut');
			done();
		}, error => onError(error, done));
	});
});
