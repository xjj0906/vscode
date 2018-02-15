/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { TPromise } from 'vs/base/common/winjs.base';
import { join } from 'vs/base/common/paths';
import { mkdirp, dirExists } from 'vs/base/node/pfs';
import Event from 'vs/base/common/event';
import { LogLevel } from 'vs/workbench/api/node/extHostTypes';
import { ILogService, DelegatedLogService } from 'vs/platform/log/common/log';
import { createSpdLogService } from 'vs/platform/log/node/spdlogService';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { memoize } from 'vs/base/common/decorators';
import { ExtHostLogServiceShape } from 'vs/workbench/api/node/extHost.protocol';


export class ExtHostLogService extends DelegatedLogService implements ILogService, ExtHostLogServiceShape {

	private _loggers: Map<string, ExtHostLogger> = new Map();

	constructor(
		private _windowId: number,
		logLevel: LogLevel,
		private _environmentService: IEnvironmentService
	) {
		super(createSpdLogService(`exthost${_windowId}`, logLevel, _environmentService.logsPath));
	}

	$setLevel(level: LogLevel): void {
		this.setLevel(level);
	}

	getExtLogger(extensionID: string): ExtHostLogger {
		let logger = this._loggers.get(extensionID);
		if (!logger) {
			logger = this.createLogger(extensionID);
			this._loggers.set(extensionID, logger);
		}
		return logger;
	}

	private createLogger(extensionID: string): ExtHostLogger {
		const logsDirPath = join(this._environmentService.logsPath, `${extensionID}_${this._windowId}`);
		const logService = createSpdLogService(extensionID, this.getLevel(), logsDirPath);
		this._register(this.onDidChangeLogLevel(level => logService.setLevel(level)));
		return new ExtHostLogger(logService, logsDirPath);
	}
}

export class ExtHostLogger implements vscode.Logger {

	constructor(
		private readonly _logService: ILogService,
		private readonly _logDirectory: string
	) {
	}

	get onDidChangeLogLevel(): Event<LogLevel> {
		return this._logService.onDidChangeLogLevel;
	}

	get currentLevel(): LogLevel { return this._logService.getLevel(); }

	@memoize
	get logDirectory(): TPromise<string> {
		return dirExists(this._logDirectory).then(exists => {
			if (exists) {
				return TPromise.wrap(null);
			} else {
				return mkdirp(this._logDirectory);
			}
		}).then(() => {
			return this._logDirectory;
		});
	}

	trace(message: string, ...args: any[]): void {
		return this._logService.trace(message, ...args);
	}

	debug(message: string, ...args: any[]): void {
		return this._logService.debug(message, ...args);
	}

	info(message: string, ...args: any[]): void {
		return this._logService.info(message, ...args);
	}

	warn(message: string, ...args: any[]): void {
		return this._logService.warn(message, ...args);
	}

	error(message: string | Error, ...args: any[]): void {
		return this._logService.error(message, ...args);
	}

	critical(message: string | Error, ...args: any[]): void {
		return this._logService.critical(message, ...args);
	}
}
