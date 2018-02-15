/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import URI from 'vs/base/common/uri';
import { FileService } from 'vs/workbench/services/files/electron-browser/fileService';
import { IContent, IStreamContent, IFileStat, IResolveContentOptions, IUpdateContentOptions, IResolveFileOptions, IResolveFileResult, FileOperationEvent, FileOperation, IFileSystemProvider, IStat, FileType, IImportResult, FileChangesEvent, ICreateFileOptions, FileOperationError, FileOperationResult, ITextSnapshot, snapshotToString } from 'vs/platform/files/common/files';
import { TPromise } from 'vs/base/common/winjs.base';
import { basename, join } from 'path';
import { IDisposable } from 'vs/base/common/lifecycle';
import { isFalsyOrEmpty, distinct } from 'vs/base/common/arrays';
import { Schemas } from 'vs/base/common/network';
import { Progress } from 'vs/platform/progress/common/progress';
import { decodeStream, encode, UTF8, UTF8_with_bom } from 'vs/base/node/encoding';
import { TernarySearchTree } from 'vs/base/common/map';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { IMessageService } from 'vs/platform/message/common/message';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { ITextResourceConfigurationService } from 'vs/editor/common/services/resourceConfiguration';
import { IExtensionService } from 'vs/platform/extensions/common/extensions';
import { maxBufferLen, detectMimeAndEncodingFromBuffer } from 'vs/base/node/mime';
import { MIME_BINARY } from 'vs/base/common/mime';
import { localize } from 'vs/nls';

function toIFileStat(provider: IFileSystemProvider, tuple: [URI, IStat], recurse?: (tuple: [URI, IStat]) => boolean): TPromise<IFileStat> {
	const [resource, stat] = tuple;
	const fileStat: IFileStat = {
		isDirectory: false,
		resource: resource,
		name: basename(resource.path),
		mtime: stat.mtime,
		size: stat.size,
		etag: stat.mtime.toString(29) + stat.size.toString(31),
	};

	if (stat.type === FileType.Dir) {
		fileStat.isDirectory = true;

		if (recurse && recurse([resource, stat])) {
			// dir -> resolve
			return provider.readdir(resource).then(entries => {
				fileStat.isDirectory = true;

				// resolve children if requested
				return TPromise.join(entries.map(stat => toIFileStat(provider, stat, recurse))).then(children => {
					fileStat.children = children;
					return fileStat;
				});
			});
		}
	}

	// file or (un-resolved) dir
	return TPromise.as(fileStat);
}

export function toDeepIFileStat(provider: IFileSystemProvider, tuple: [URI, IStat], to: URI[]): TPromise<IFileStat> {

	const trie = TernarySearchTree.forPaths<true>();
	trie.set(tuple[0].toString(), true);

	if (!isFalsyOrEmpty(to)) {
		to.forEach(uri => trie.set(uri.toString(), true));
	}

	return toIFileStat(provider, tuple, candidate => {
		return Boolean(trie.findSuperstr(candidate[0].toString()) || trie.get(candidate[0].toString()));
	});
}

export class RemoteFileService extends FileService {

	private readonly _provider = new Map<string, IFileSystemProvider>();
	private _supportedSchemes: string[];

	constructor(
		@IExtensionService private readonly _extensionService: IExtensionService,
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IMessageService messageService: IMessageService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
	) {
		super(
			configurationService,
			contextService,
			environmentService,
			lifecycleService,
			messageService,
			_storageService,
			textResourceConfigurationService,
		);

		this._supportedSchemes = JSON.parse(this._storageService.get('remote_schemes', undefined, '[]'));
	}

	registerProvider(authority: string, provider: IFileSystemProvider): IDisposable {
		if (this._provider.has(authority)) {
			throw new Error();
		}

		this._supportedSchemes.push(authority);
		this._storageService.store('remote_schemes', JSON.stringify(distinct(this._supportedSchemes)));

		this._provider.set(authority, provider);
		const reg = provider.onDidChange(changes => {
			// forward change events
			this._onFileChanges.fire(new FileChangesEvent(changes));
		});
		return {
			dispose: () => {
				this._provider.delete(authority);
				reg.dispose();
			}
		};
	}

	canHandleResource(resource: URI): boolean {
		return resource.scheme === Schemas.file
			|| this._provider.has(resource.scheme)
			// TODO@remote
			|| this._supportedSchemes.indexOf(resource.scheme) >= 0;
	}

	// --- stat

	private _withProvider(resource: URI): TPromise<IFileSystemProvider> {
		return this._extensionService.activateByEvent('onFileSystemAccess:' + resource.scheme).then(() => {
			const provider = this._provider.get(resource.scheme);
			if (!provider) {
				const err = new Error();
				err.name = 'ENOPRO';
				err.message = `no provider for ${resource.toString()}`;
				throw err;
			}
			return provider;
		});
	}

	existsFile(resource: URI): TPromise<boolean, any> {
		if (resource.scheme === Schemas.file) {
			return super.existsFile(resource);
		} else {
			return this.resolveFile(resource).then(data => true, err => false);
		}
	}

	resolveFile(resource: URI, options?: IResolveFileOptions): TPromise<IFileStat, any> {
		if (resource.scheme === Schemas.file) {
			return super.resolveFile(resource, options);
		} else {
			return this._doResolveFiles([{ resource, options }]).then(data => {
				if (data.length !== 1 || !data[0].success) {
					throw new Error(`ENOENT, ${resource}`);
				} else {
					return data[0].stat;
				}
			});
		}
	}

	resolveFiles(toResolve: { resource: URI; options?: IResolveFileOptions; }[]): TPromise<IResolveFileResult[], any> {

		// soft-groupBy, keep order, don't rearrange/merge groups
		let groups: (typeof toResolve)[] = [];
		let group: typeof toResolve;
		for (const request of toResolve) {
			if (!group || group[0].resource.scheme !== request.resource.scheme) {
				group = [];
				groups.push(group);
			}
			group.push(request);
		}

		const promises: TPromise<IResolveFileResult[], any>[] = [];
		for (const group of groups) {
			if (group[0].resource.scheme === Schemas.file) {
				promises.push(super.resolveFiles(group));
			} else {
				promises.push(this._doResolveFiles(group));
			}
		}
		return TPromise.join(promises).then(data => {
			return [].concat(...data);
		});
	}

	private _doResolveFiles(toResolve: { resource: URI; options?: IResolveFileOptions; }[]): TPromise<IResolveFileResult[], any> {
		return this._withProvider(toResolve[0].resource).then(provider => {
			let result: IResolveFileResult[] = [];
			let promises = toResolve.map((item, idx) => {
				return provider.stat(item.resource).then(stat => {
					return toDeepIFileStat(provider, [item.resource, stat], item.options && item.options.resolveTo).then(fileStat => {
						result[idx] = { stat: fileStat, success: true };
					});
				}, err => {
					result[idx] = { stat: undefined, success: false };
				});
			});
			return TPromise.join(promises).then(() => result);
		});
	}

	// --- resolve

	resolveContent(resource: URI, options?: IResolveContentOptions): TPromise<IContent> {
		if (resource.scheme === Schemas.file) {
			return super.resolveContent(resource, options);
		} else {
			return this._doResolveContent(resource, options).then(RemoteFileService._asContent);
		}
	}

	resolveStreamContent(resource: URI, options?: IResolveContentOptions): TPromise<IStreamContent> {
		if (resource.scheme === Schemas.file) {
			return super.resolveStreamContent(resource, options);
		} else {
			return this._doResolveContent(resource, options);
		}
	}

	private _doResolveContent(resource: URI, options: IResolveContentOptions = Object.create(null)): TPromise<IStreamContent> {
		return this._withProvider(resource).then(provider => {

			return this.resolveFile(resource).then(fileStat => {

				if (fileStat.isDirectory) {
					// todo@joh cannot copy a folder
					// https://github.com/Microsoft/vscode/issues/41547
					throw new FileOperationError(
						localize('fileIsDirectoryError', "File is directory"),
						FileOperationResult.FILE_IS_DIRECTORY,
						options
					);
				}
				if (fileStat.etag === options.etag) {
					throw new FileOperationError(
						localize('fileNotModifiedError', "File not modified since"),
						FileOperationResult.FILE_NOT_MODIFIED_SINCE,
						options
					);
				}

				const guessEncoding = options.autoGuessEncoding;
				const count = maxBufferLen(options);
				const chunks: Buffer[] = [];

				return provider.read(
					resource,
					0, count,
					new Progress<Buffer>(chunk => chunks.push(chunk))
				).then(bytesRead => {
					// send to bla
					return detectMimeAndEncodingFromBuffer({ bytesRead, buffer: Buffer.concat(chunks) }, guessEncoding);

				}).then(detected => {
					if (options.acceptTextOnly && detected.mimes.indexOf(MIME_BINARY) >= 0) {
						return TPromise.wrapError<IStreamContent>(new FileOperationError(
							localize('fileBinaryError', "File seems to be binary and cannot be opened as text"),
							FileOperationResult.FILE_IS_BINARY,
							options
						));
					}

					let preferredEncoding: string;
					if (options && options.encoding) {
						if (detected.encoding === UTF8 && options.encoding === UTF8) {
							preferredEncoding = UTF8_with_bom; // indicate the file has BOM if we are to resolve with UTF 8
						} else {
							preferredEncoding = options.encoding; // give passed in encoding highest priority
						}
					} else if (detected.encoding) {
						if (detected.encoding === UTF8) {
							preferredEncoding = UTF8_with_bom; // if we detected UTF-8, it can only be because of a BOM
						} else {
							preferredEncoding = detected.encoding;
						}
						// todo@remote - encoding logic should not be kept
						// hostage inside the node file service
						// } else if (super.configuredEncoding(resource) === UTF8_with_bom) {
					} else {
						preferredEncoding = UTF8; // if we did not detect UTF 8 BOM before, this can only be UTF 8 then
					}

					// const encoding = this.getEncoding(resource);
					const stream = decodeStream(preferredEncoding);

					// start with what we have already read
					// and have a new stream to read the rest
					let offset = 0;
					for (const chunk of chunks) {
						stream.write(chunk);
						offset += chunk.length;
					}
					if (offset < count) {
						// we didn't read enough the first time which means
						// that we are done
						stream.end();
					} else {
						// there is more to read
						provider.read(resource, offset, -1, new Progress<Buffer>(chunk => stream.write(chunk))).then(() => {
							stream.end();
						}, err => {
							stream.emit('error', err);
							stream.end();
						});
					}

					return {
						encoding: preferredEncoding,
						value: stream,
						resource: fileStat.resource,
						name: fileStat.name,
						etag: fileStat.etag,
						mtime: fileStat.mtime,
					};
				});
			});
		});
	}

	// --- saving

	createFile(resource: URI, content?: string, options?: ICreateFileOptions): TPromise<IFileStat> {
		if (resource.scheme === Schemas.file) {
			return super.createFile(resource, content, options);
		} else {
			return this._withProvider(resource).then(provider => {
				let prepare = options && !options.overwrite
					? this.existsFile(resource)
					: TPromise.as(false);


				return prepare.then(exists => {
					if (exists && options && !options.overwrite) {
						return TPromise.wrapError(new FileOperationError('EEXIST', FileOperationResult.FILE_MODIFIED_SINCE, options));
					}
					return this._doUpdateContent(provider, resource, content || '', {});
				}).then(fileStat => {
					this._onAfterOperation.fire(new FileOperationEvent(resource, FileOperation.CREATE, fileStat));
					return fileStat;
				});
			});
		}
	}

	updateContent(resource: URI, value: string | ITextSnapshot, options?: IUpdateContentOptions): TPromise<IFileStat> {
		if (resource.scheme === Schemas.file) {
			return super.updateContent(resource, value, options);
		} else {
			return this._withProvider(resource).then(provider => {
				return this._doUpdateContent(provider, resource, value, options || {});
			});
		}
	}

	private _doUpdateContent(provider: IFileSystemProvider, resource: URI, content: string | ITextSnapshot, options: IUpdateContentOptions): TPromise<IFileStat> {
		const encoding = this.getEncoding(resource, options.encoding);
		// TODO@Joh support streaming API for remote file system writes
		return provider.write(resource, encode(typeof content === 'string' ? content : snapshotToString(content), encoding)).then(() => {
			return this.resolveFile(resource);
		});
	}

	private static _asContent(content: IStreamContent): TPromise<IContent> {
		return new TPromise<IContent>((resolve, reject) => {
			let result: IContent = {
				value: '',
				encoding: content.encoding,
				etag: content.etag,
				mtime: content.mtime,
				name: content.name,
				resource: content.resource
			};
			content.value.on('data', chunk => result.value += chunk);
			content.value.on('error', reject);
			content.value.on('end', () => resolve(result));
		});
	}

	// --- delete

	del(resource: URI, useTrash?: boolean): TPromise<void> {
		if (resource.scheme === Schemas.file) {
			return super.del(resource, useTrash);
		} else {
			return this._withProvider(resource).then(provider => {
				return provider.stat(resource).then(stat => {
					return stat.type === FileType.Dir ? provider.rmdir(resource) : provider.unlink(resource);
				}).then(() => {
					this._onAfterOperation.fire(new FileOperationEvent(resource, FileOperation.DELETE));
				});
			});
		}
	}

	createFolder(resource: URI): TPromise<IFileStat, any> {
		if (resource.scheme === Schemas.file) {
			return super.createFolder(resource);
		} else {
			return this._withProvider(resource).then(provider => {
				return provider.mkdir(resource).then(stat => {
					return toIFileStat(provider, [resource, stat]);
				});
			}).then(fileStat => {
				this._onAfterOperation.fire(new FileOperationEvent(resource, FileOperation.CREATE, fileStat));
				return fileStat;
			});
		}
	}

	rename(resource: URI, newName: string): TPromise<IFileStat, any> {
		if (resource.scheme === Schemas.file) {
			return super.rename(resource, newName);
		} else {
			const target = resource.with({ path: join(resource.path, '..', newName) });
			return this._doMoveWithInScheme(resource, target, false);
		}
	}

	moveFile(source: URI, target: URI, overwrite?: boolean): TPromise<IFileStat> {
		if (source.scheme !== target.scheme) {
			return this._doMoveAcrossScheme(source, target);
		} else if (source.scheme === Schemas.file) {
			return super.moveFile(source, target, overwrite);
		} else {
			return this._doMoveWithInScheme(source, target, overwrite);
		}
	}

	private _doMoveWithInScheme(source: URI, target: URI, overwrite?: boolean): TPromise<IFileStat> {

		const prepare = overwrite
			? this.del(target).then(undefined, err => { /*ignore*/ })
			: TPromise.as(null);

		return prepare.then(() => this._withProvider(source)).then(provider => {
			return provider.move(source, target).then(stat => {
				return toIFileStat(provider, [target, stat]);
			}).then(fileStat => {
				this._onAfterOperation.fire(new FileOperationEvent(source, FileOperation.MOVE, fileStat));
				return fileStat;
			});
		});
	}

	private _doMoveAcrossScheme(source: URI, target: URI, overwrite?: boolean): TPromise<IFileStat> {
		return this.copyFile(source, target, overwrite).then(() => {
			return this.del(source);
		}).then(() => {
			return this.resolveFile(target);
		}).then(fileStat => {
			this._onAfterOperation.fire(new FileOperationEvent(source, FileOperation.MOVE, fileStat));
			return fileStat;
		});
	}

	importFile(source: URI, targetFolder: URI): TPromise<IImportResult> {
		if (source.scheme === targetFolder.scheme && source.scheme === Schemas.file) {
			return super.importFile(source, targetFolder);
		} else {
			const target = targetFolder.with({ path: join(targetFolder.path, basename(source.path)) });
			return this.copyFile(source, target, false).then(stat => ({ stat, isNew: false }));
		}
	}

	copyFile(source: URI, target: URI, overwrite?: boolean): TPromise<IFileStat> {
		if (source.scheme === target.scheme && source.scheme === Schemas.file) {
			return super.copyFile(source, target, overwrite);
		}

		const prepare = overwrite
			? this.del(target).then(undefined, err => { /*ignore*/ })
			: TPromise.as(null);

		return prepare.then(() => {
			// todo@ben, can only copy text files
			// https://github.com/Microsoft/vscode/issues/41543
			return this.resolveContent(source, { acceptTextOnly: true }).then(content => {
				return this._withProvider(target).then(provider => {
					return this._doUpdateContent(provider, target, content.value, { encoding: content.encoding }).then(fileStat => {
						this._onAfterOperation.fire(new FileOperationEvent(source, FileOperation.COPY, fileStat));
						return fileStat;
					});
				}, err => {
					if (err instanceof Error && err.name === 'ENOPRO') {
						// file scheme
						return super.updateContent(target, content.value, { encoding: content.encoding });
					} else {
						return TPromise.wrapError(err);
					}
				});
			});
		});

	}

	touchFile(resource: URI): TPromise<IFileStat, any> {
		if (resource.scheme === Schemas.file) {
			return super.touchFile(resource);
		} else {
			return this._doTouchFile(resource);
		}
	}

	private _doTouchFile(resource: URI): TPromise<IFileStat> {
		return this._withProvider(resource).then(provider => {
			return provider.stat(resource).then(() => {
				return provider.utimes(resource, Date.now(), Date.now());
			}, err => {
				return provider.write(resource, new Uint8Array(0));
			}).then(() => {
				return this.resolveFile(resource);
			});
		});
	}

	// TODO@Joh - file watching on demand!
	public watchFileChanges(resource: URI): void {
		if (resource.scheme === Schemas.file) {
			super.watchFileChanges(resource);
		}
	}
	public unwatchFileChanges(resource: URI): void {
		if (resource.scheme === Schemas.file) {
			super.unwatchFileChanges(resource);
		}
	}
}
