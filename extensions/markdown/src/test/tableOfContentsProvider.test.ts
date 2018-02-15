/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as vscode from 'vscode';
import 'mocha';

import { TableOfContentsProvider } from '../tableOfContentsProvider';
import { MarkdownEngine } from '../markdownEngine';

const testFileName = vscode.Uri.parse('test.md');

suite('markdown.TableOfContentsProvider', () => {
	test('Lookup should not return anything for empty document', async () => {
		const doc = new InMemoryDocument(testFileName, '');
		const provider = new TableOfContentsProvider(new MarkdownEngine(), doc);

		assert.strictEqual(await provider.lookup(''), undefined);
		assert.strictEqual(await provider.lookup('foo'), undefined);
	});

	test('Lookup should not return anything for document with no headers', async () => {
		const doc = new InMemoryDocument(testFileName, 'a *b*\nc');
		const provider = new TableOfContentsProvider(new MarkdownEngine(), doc);

		assert.strictEqual(await provider.lookup(''), undefined);
		assert.strictEqual(await provider.lookup('foo'), undefined);
		assert.strictEqual(await provider.lookup('a'), undefined);
		assert.strictEqual(await provider.lookup('b'), undefined);
	});

	test('Lookup should return basic #header', async () => {
		const doc = new InMemoryDocument(testFileName, `# a\nx\n# c`);
		const provider = new TableOfContentsProvider(new MarkdownEngine(), doc);

		{
			const entry = await provider.lookup('a');
			assert.ok(entry);
			assert.strictEqual(entry!.line, 0);
		}
		{
			assert.strictEqual(await provider.lookup('x'), undefined);
		}
		{
			const entry = await provider.lookup('c');
			assert.ok(entry);
			assert.strictEqual(entry!.line, 2);
		}
	});

	test('Lookups should be case in-sensitive', async () => {
		const doc = new InMemoryDocument(testFileName, `# fOo\n`);
		const provider = new TableOfContentsProvider(new MarkdownEngine(), doc);

		assert.strictEqual((await provider.lookup('fOo'))!.line, 0);
		assert.strictEqual((await provider.lookup('foo'))!.line, 0);
		assert.strictEqual((await provider.lookup('FOO'))!.line, 0);
	});

	test('Lookups should ignore leading and trailing white-space, and collapse internal whitespace', async () => {
		const doc = new InMemoryDocument(testFileName, `#      f o  o    \n`);
		const provider = new TableOfContentsProvider(new MarkdownEngine(), doc);

		assert.strictEqual((await provider.lookup('f o  o'))!.line, 0);
		assert.strictEqual((await provider.lookup('  f o  o'))!.line, 0);
		assert.strictEqual((await provider.lookup('  f o  o  '))!.line, 0);
		assert.strictEqual((await provider.lookup('f o o'))!.line, 0);
		assert.strictEqual((await provider.lookup('f o       o'))!.line, 0);

		assert.strictEqual(await provider.lookup('f'), undefined);
		assert.strictEqual(await provider.lookup('foo'), undefined);
		assert.strictEqual(await provider.lookup('fo o'), undefined);
	});
});

class InMemoryDocument implements vscode.TextDocument {
	private readonly _lines: string[];

	constructor(
		public readonly uri: vscode.Uri,
		private readonly _contents: string
	) {
		this._lines = this._contents.split(/\n/g);
	}

	fileName: string = '';
	isUntitled: boolean = false;
	languageId: string = '';
	version: number = 1;
	isDirty: boolean = false;
	isClosed: boolean = false;
	eol: vscode.EndOfLine = vscode.EndOfLine.LF;

	get lineCount(): number {
		return this._lines.length;
	}

	lineAt(line: any): vscode.TextLine {
		return {
			lineNumber: line,
			text: this._lines[line],
			range: new vscode.Range(0, 0, 0, 0),
			firstNonWhitespaceCharacterIndex: 0,
			rangeIncludingLineBreak: new vscode.Range(0, 0, 0, 0),
			isEmptyOrWhitespace: false
		};
	}
	offsetAt(_position: vscode.Position): never {
		throw new Error('Method not implemented.');
	}
	positionAt(_offset: number): never {
		throw new Error('Method not implemented.');
	}
	getText(_range?: vscode.Range | undefined): string {
		return this._contents;
	}
	getWordRangeAtPosition(_position: vscode.Position, _regex?: RegExp | undefined): never {
		throw new Error('Method not implemented.');
	}
	validateRange(_range: vscode.Range): never {
		throw new Error('Method not implemented.');
	}
	validatePosition(_position: vscode.Position): never {
		throw new Error('Method not implemented.');
	}
	save(): never {
		throw new Error('Method not implemented.');
	}
}
