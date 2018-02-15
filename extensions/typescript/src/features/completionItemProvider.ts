/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CompletionItem, TextDocument, Position, CompletionItemKind, CompletionItemProvider, CancellationToken, Range, SnippetString, workspace, CompletionContext, Uri, MarkdownString, window, QuickPickItem } from 'vscode';

import { ITypeScriptServiceClient } from '../typescriptService';
import TypingsStatus from '../utils/typingsStatus';

import * as Proto from '../protocol';
import * as PConst from '../protocol.const';
import * as Previewer from '../utils/previewer';
import { tsTextSpanToVsRange, vsPositionToTsFileLocation } from '../utils/convert';

import * as nls from 'vscode-nls';
import { applyCodeAction } from '../utils/codeAction';
import * as languageModeIds from '../utils/languageModeIds';
import { CommandManager, Command } from '../utils/commandManager';

const localize = nls.loadMessageBundle();

class MyCompletionItem extends CompletionItem {
	public readonly useCodeSnippet: boolean;

	constructor(
		public readonly position: Position,
		public readonly document: TextDocument,
		line: string,
		public readonly tsEntry: Proto.CompletionEntry,
		enableDotCompletions: boolean,
		useCodeSnippetsOnMethodSuggest: boolean
	) {
		super(tsEntry.name);

		if (tsEntry.isRecommended) {
			// Make sure isRecommended property always comes first
			// https://github.com/Microsoft/vscode/issues/40325
			this.sortText = '\0' + tsEntry.sortText;
		} else if (tsEntry.source) {
			// De-prioritze auto-imports
			// https://github.com/Microsoft/vscode/issues/40311
			this.sortText = '\uffff' + tsEntry.sortText;
		} else {
			this.sortText = tsEntry.sortText;
		}

		this.kind = MyCompletionItem.convertKind(tsEntry.kind);
		this.position = position;
		this.commitCharacters = MyCompletionItem.getCommitCharacters(enableDotCompletions, !useCodeSnippetsOnMethodSuggest, tsEntry.kind);
		this.useCodeSnippet = useCodeSnippetsOnMethodSuggest && (this.kind === CompletionItemKind.Function || this.kind === CompletionItemKind.Method);

		if (tsEntry.replacementSpan) {
			this.range = tsTextSpanToVsRange(tsEntry.replacementSpan);
		}

		if (typeof tsEntry.insertText === 'string') {
			this.insertText = (tsEntry as any).insertText as string;

			if (tsEntry.replacementSpan) {
				this.range = tsTextSpanToVsRange(tsEntry.replacementSpan);
				if (this.insertText[0] === '[') { // o.x -> o['x']
					this.filterText = '.' + this.label;
				}

				// Make sure we only replace a single line at most
				if (!this.range.isSingleLine) {
					this.range = new Range(this.range.start.line, this.range.start.character, this.range.start.line, line.length);
				}
			}
		}

		if (tsEntry.kindModifiers.match(/\boptional\b/)) {
			this.insertText = this.label;
			this.filterText = this.label;
			this.label += '?';
		}

	}

	public resolve(): void {
		if (!this.range) {
			// Try getting longer, prefix based range for completions that span words
			const wordRange = this.document.getWordRangeAtPosition(this.position);
			const text = this.document.getText(new Range(this.position.line, Math.max(0, this.position.character - this.label.length), this.position.line, this.position.character)).toLowerCase();
			const entryName = this.label.toLowerCase();
			for (let i = entryName.length; i >= 0; --i) {
				if (text.endsWith(entryName.substr(0, i)) && (!wordRange || wordRange.start.character > this.position.character - i)) {
					this.range = new Range(this.position.line, Math.max(0, this.position.character - i), this.position.line, this.position.character);
					break;
				}
			}
		}
	}

	private static convertKind(kind: string): CompletionItemKind {
		switch (kind) {
			case PConst.Kind.primitiveType:
			case PConst.Kind.keyword:
				return CompletionItemKind.Keyword;
			case PConst.Kind.const:
				return CompletionItemKind.Constant;
			case PConst.Kind.let:
			case PConst.Kind.variable:
			case PConst.Kind.localVariable:
			case PConst.Kind.alias:
				return CompletionItemKind.Variable;
			case PConst.Kind.memberVariable:
			case PConst.Kind.memberGetAccessor:
			case PConst.Kind.memberSetAccessor:
				return CompletionItemKind.Field;
			case PConst.Kind.function:
				return CompletionItemKind.Function;
			case PConst.Kind.memberFunction:
			case PConst.Kind.constructSignature:
			case PConst.Kind.callSignature:
			case PConst.Kind.indexSignature:
				return CompletionItemKind.Method;
			case PConst.Kind.enum:
				return CompletionItemKind.Enum;
			case PConst.Kind.module:
			case PConst.Kind.externalModuleName:
				return CompletionItemKind.Module;
			case PConst.Kind.class:
			case PConst.Kind.type:
				return CompletionItemKind.Class;
			case PConst.Kind.interface:
				return CompletionItemKind.Interface;
			case PConst.Kind.warning:
			case PConst.Kind.file:
			case PConst.Kind.script:
				return CompletionItemKind.File;
			case PConst.Kind.directory:
				return CompletionItemKind.Folder;
		}
		return CompletionItemKind.Property;
	}

	private static getCommitCharacters(
		enableDotCompletions: boolean,
		enableCallCompletions: boolean,
		kind: string
	): string[] | undefined {
		switch (kind) {
			case PConst.Kind.memberGetAccessor:
			case PConst.Kind.memberSetAccessor:
			case PConst.Kind.constructSignature:
			case PConst.Kind.callSignature:
			case PConst.Kind.indexSignature:
			case PConst.Kind.enum:
			case PConst.Kind.interface:
				return enableDotCompletions ? ['.'] : undefined;

			case PConst.Kind.module:
			case PConst.Kind.alias:
			case PConst.Kind.const:
			case PConst.Kind.let:
			case PConst.Kind.variable:
			case PConst.Kind.localVariable:
			case PConst.Kind.memberVariable:
			case PConst.Kind.class:
			case PConst.Kind.function:
			case PConst.Kind.memberFunction:
				return enableDotCompletions ? (enableCallCompletions ? ['.', '('] : ['.']) : undefined;
		}

		return undefined;
	}
}

class ApplyCompletionCodeActionCommand implements Command {
	public static readonly ID = '_typescript.applyCompletionCodeAction';
	public readonly id = ApplyCompletionCodeActionCommand.ID;

	public constructor(
		private readonly client: ITypeScriptServiceClient
	) { }

	public async execute(_file: string, codeActions: Proto.CodeAction[]): Promise<boolean> {
		if (codeActions.length === 0) {
			return true;
		}

		if (codeActions.length === 1) {
			return applyCodeAction(this.client, codeActions[0]);
		}

		interface MyQuickPickItem extends QuickPickItem {
			index: number;
		}

		const selection = await window.showQuickPick<MyQuickPickItem>(
			codeActions.map((action, i): MyQuickPickItem => ({
				label: action.description,
				description: '',
				index: i
			})), {
				placeHolder: localize('selectCodeAction', 'Select code action to apply')
			}
		);

		if (!selection) {
			return false;
		}

		const action = codeActions[selection.index];
		if (!action) {
			return false;
		}
		return applyCodeAction(this.client, action);
	}
}

interface Configuration {
	useCodeSnippetsOnMethodSuggest: boolean;
	nameSuggestions: boolean;
	quickSuggestionsForPaths: boolean;
	autoImportSuggestions: boolean;
}

namespace Configuration {
	export const useCodeSnippetsOnMethodSuggest = 'useCodeSnippetsOnMethodSuggest';
	export const nameSuggestions = 'nameSuggestions';
	export const quickSuggestionsForPaths = 'quickSuggestionsForPaths';
	export const autoImportSuggestions = 'autoImportSuggestions.enabled';
}

export default class TypeScriptCompletionItemProvider implements CompletionItemProvider {
	constructor(
		private client: ITypeScriptServiceClient,
		private readonly typingsStatus: TypingsStatus,
		commandManager: CommandManager
	) {
		commandManager.register(new ApplyCompletionCodeActionCommand(this.client));
	}

	public async provideCompletionItems(
		document: TextDocument,
		position: Position,
		token: CancellationToken,
		context: CompletionContext
	): Promise<CompletionItem[]> {
		if (this.typingsStatus.isAcquiringTypings) {
			return Promise.reject<CompletionItem[]>({
				label: localize(
					{ key: 'acquiringTypingsLabel', comment: ['Typings refers to the *.d.ts typings files that power our IntelliSense. It should not be localized'] },
					'Acquiring typings...'),
				detail: localize(
					{ key: 'acquiringTypingsDetail', comment: ['Typings refers to the *.d.ts typings files that power our IntelliSense. It should not be localized'] },
					'Acquiring typings definitions for IntelliSense.')
			});
		}

		const file = this.client.normalizePath(document.uri);
		if (!file) {
			return [];
		}

		const line = document.lineAt(position.line);
		const config = this.getConfiguration(document.uri);

		if (context.triggerCharacter === '"' || context.triggerCharacter === '\'') {
			if (!config.quickSuggestionsForPaths) {
				return [];
			}

			// make sure we are in something that looks like the start of an import
			const pre = line.text.slice(0, position.character);
			if (!pre.match(/\b(from|import)\s*["']$/) && !pre.match(/\b(import|require)\(['"]$/)) {
				return [];
			}
		}

		if (context.triggerCharacter === '/') {
			if (!config.quickSuggestionsForPaths) {
				return [];
			}

			// make sure we are in something that looks like an import path
			const pre = line.text.slice(0, position.character);
			if (!pre.match(/\b(from|import)\s*["'][^'"]*$/) && !pre.match(/\b(import|require)\(['"][^'"]*$/)) {
				return [];
			}
		}

		if (context.triggerCharacter === '@') {
			// make sure we are in something that looks like the start of a jsdoc comment
			const pre = line.text.slice(0, position.character);
			if (!pre.match(/^\s*\*[ ]?@/) && !pre.match(/\/\*\*+[ ]?@/)) {
				return [];
			}
		}

		try {
			const args: Proto.CompletionsRequestArgs = {
				...vsPositionToTsFileLocation(file, position),
				includeExternalModuleExports: config.autoImportSuggestions,
				includeInsertTextCompletions: true
			} as Proto.CompletionsRequestArgs;
			const msg = await this.client.execute('completions', args, token);
			// This info has to come from the tsserver. See https://github.com/Microsoft/TypeScript/issues/2831
			// let isMemberCompletion = false;
			// let requestColumn = position.character;
			// if (wordAtPosition) {
			// 	requestColumn = wordAtPosition.startColumn;
			// }
			// if (requestColumn > 0) {
			// 	let value = model.getValueInRange({
			// 		startLineNumber: position.line,
			// 		startColumn: requestColumn - 1,
			// 		endLineNumber: position.line,
			// 		endColumn: requestColumn
			// 	});
			// 	isMemberCompletion = value === '.';
			// }

			const completionItems: CompletionItem[] = [];
			const body = msg.body;
			if (body) {
				// Only enable dot completions in TS files for now
				let enableDotCompletions = document && (document.languageId === languageModeIds.typescript || document.languageId === languageModeIds.typescriptreact);

				// TODO: Workaround for https://github.com/Microsoft/TypeScript/issues/13456
				// Only enable dot completions when previous character is an identifier.
				// Prevents incorrectly completing while typing spread operators.
				if (position.character > 1) {
					const preText = document.getText(new Range(
						position.line, 0,
						position.line, position.character - 1));
					enableDotCompletions = preText.match(/[a-z_$\)\]\}]\s*$/ig) !== null;
				}

				for (const element of body) {
					if (element.kind === PConst.Kind.warning && !config.nameSuggestions) {
						continue;
					}
					if (!config.autoImportSuggestions && element.hasAction) {
						continue;
					}
					const item = new MyCompletionItem(position, document, line.text, element, enableDotCompletions, config.useCodeSnippetsOnMethodSuggest);
					completionItems.push(item);
				}
			}

			return completionItems;
		} catch {
			return [];
		}
	}

	public async resolveCompletionItem(
		item: CompletionItem,
		token: CancellationToken
	): Promise<CompletionItem | undefined> {
		if (!(item instanceof MyCompletionItem)) {
			return undefined;
		}

		const filepath = this.client.normalizePath(item.document.uri);
		if (!filepath) {
			return undefined;
		}

		item.resolve();

		const args: Proto.CompletionDetailsRequestArgs = {
			...vsPositionToTsFileLocation(filepath, item.position),
			entryNames: [
				item.tsEntry.source ? { name: item.tsEntry.name, source: item.tsEntry.source } : item.tsEntry.name
			]
		};

		let response: Proto.CompletionDetailsResponse;
		try {
			response = await this.client.execute('completionEntryDetails', args, token);
		} catch {
			return item;
		}

		const details = response.body;
		if (!details || !details.length || !details[0]) {
			return item;
		}
		const detail = details[0];
		item.detail = detail.displayParts.length ? Previewer.plain(detail.displayParts) : undefined;
		item.documentation = this.getDocumentation(detail, item);

		if (detail.codeActions && detail.codeActions.length) {
			item.command = {
				title: '',
				command: ApplyCompletionCodeActionCommand.ID,
				arguments: [filepath, detail.codeActions]
			};
		}

		if (detail && item.useCodeSnippet) {
			const shouldCompleteFunction = await this.isValidFunctionCompletionContext(filepath, item.position);
			if (shouldCompleteFunction) {
				item.insertText = this.snippetForFunctionCall(item, detail);
			}
			return item;
		}

		return item;
	}

	private getDocumentation(
		detail: Proto.CompletionEntryDetails,
		item: MyCompletionItem
	): MarkdownString | undefined {
		const documentation = new MarkdownString();
		if (detail.source) {
			let importPath = `'${Previewer.plain(detail.source)}'`;
			if (this.client.apiVersion.has260Features() && !this.client.apiVersion.has262Features()) {
				// Try to resolve the real import name that will be added
				if (detail.codeActions && detail.codeActions[0]) {
					const action = detail.codeActions[0];
					if (action.changes[0] && action.changes[0].textChanges[0]) {
						const textChange = action.changes[0].textChanges[0];
						const matchedImport = textChange.newText.match(/(['"])(.+?)\1/);
						if (matchedImport) {
							importPath = matchedImport[0];
							item.detail += ` — from ${matchedImport[0]}`;
						}
					}
				}
				documentation.appendMarkdown(localize('autoImportLabel', 'Auto import from {0}', importPath));
			} else {
				const autoImportLabel = localize('autoImportLabel', 'Auto import from {0}', importPath);
				item.detail = `${autoImportLabel}\n${item.detail}`;
			}
			documentation.appendMarkdown('\n\n');
		}
		Previewer.addMarkdownDocumentation(documentation, detail.documentation, detail.tags);

		return documentation.value.length ? documentation : undefined;
	}

	private async isValidFunctionCompletionContext(filepath: string, position: Position): Promise<boolean> {
		// Workaround for https://github.com/Microsoft/TypeScript/issues/12677
		// Don't complete function calls inside of destructive assigments or imports
		try {
			const infoResponse = await this.client.execute('quickinfo', vsPositionToTsFileLocation(filepath, position));
			const info = infoResponse.body;
			switch (info && info.kind) {
				case 'var':
				case 'let':
				case 'const':
				case 'alias':
					return false;
				default:
					return true;
			}
		} catch (e) {
			return true;
		}
	}

	private snippetForFunctionCall(
		item: CompletionItem,
		detail: Proto.CompletionEntryDetails
	): SnippetString {
		let hasOptionalParameters = false;
		let hasAddedParameters = false;

		const snippet = new SnippetString();
		snippet.appendText(item.label || item.insertText as string);
		snippet.appendText('(');

		let parenCount = 0;
		let i = 0;
		for (; i < detail.displayParts.length; ++i) {
			const part = detail.displayParts[i];
			// Only take top level paren names
			if (part.kind === 'parameterName' && parenCount === 1) {
				const next = detail.displayParts[i + 1];
				// Skip optional parameters
				const nameIsFollowedByOptionalIndicator = next && next.text === '?';
				if (!nameIsFollowedByOptionalIndicator) {
					if (hasAddedParameters) {
						snippet.appendText(', ');
					}
					hasAddedParameters = true;
					snippet.appendPlaceholder(part.text);
				}
				hasOptionalParameters = hasOptionalParameters || nameIsFollowedByOptionalIndicator;
			} else if (part.kind === 'punctuation') {
				if (part.text === '(') {
					++parenCount;
				} else if (part.text === ')') {
					--parenCount;
				} else if (part.text === '...' && parenCount === 1) {
					// Found rest parmeter. Do not fill in any further arguments
					hasOptionalParameters = true;
					break;
				}
			}
		}
		if (hasOptionalParameters) {
			snippet.appendTabstop();
		}
		snippet.appendText(')');
		snippet.appendTabstop(0);
		return snippet;
	}

	private getConfiguration(resource: Uri): Configuration {
		// Use shared setting for js and ts
		const typeScriptConfig = workspace.getConfiguration('typescript', resource);
		return {
			useCodeSnippetsOnMethodSuggest: typeScriptConfig.get<boolean>(Configuration.useCodeSnippetsOnMethodSuggest, false),
			quickSuggestionsForPaths: typeScriptConfig.get<boolean>(Configuration.quickSuggestionsForPaths, true),
			autoImportSuggestions: typeScriptConfig.get<boolean>(Configuration.autoImportSuggestions, true),
			nameSuggestions: workspace.getConfiguration('javascript', resource).get(Configuration.nameSuggestions, true)
		};
	}
}
