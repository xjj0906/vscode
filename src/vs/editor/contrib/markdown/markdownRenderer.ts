/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import { IMarkdownString } from 'vs/base/common/htmlContent';
import { renderMarkdown, RenderOptions } from 'vs/base/browser/htmlContentRenderer';
import { IOpenerService, NullOpenerService } from 'vs/platform/opener/common/opener';
import { IModeService } from 'vs/editor/common/services/modeService';
import URI from 'vs/base/common/uri';
import { onUnexpectedError } from 'vs/base/common/errors';
import { tokenizeToString } from 'vs/editor/common/modes/textToHtmlTokenizer';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { optional } from 'vs/platform/instantiation/common/instantiation';
import Event, { Emitter } from 'vs/base/common/event';

export class MarkdownRenderer {

	private _onDidRenderCodeBlock = new Emitter<void>();
	readonly onDidRenderCodeBlock: Event<void> = this._onDidRenderCodeBlock.event;

	private readonly _options: RenderOptions;

	constructor(
		editor: ICodeEditor,
		@IModeService private readonly _modeService: IModeService,
		@optional(IOpenerService) private readonly _openerService: IOpenerService = NullOpenerService,
	) {
		this._options = {
			actionCallback: (content) => {
				this._openerService.open(URI.parse(content)).then(void 0, onUnexpectedError);
			},
			codeBlockRenderer: (languageAlias, value): TPromise<string> => {
				// In markdown,
				// it is possible that we stumble upon language aliases (e.g.js instead of javascript)
				// it is possible no alias is given in which case we fall back to the current editor lang
				const modeId = languageAlias
					? this._modeService.getModeIdForLanguageName(languageAlias)
					: editor.getModel().getLanguageIdentifier().language;

				return this._modeService.getOrCreateMode(modeId).then(_ => {
					return tokenizeToString(value, modeId);
				}).then(code => {
					return `<span style="font-family: ${editor.getConfiguration().fontInfo.fontFamily}">${code}</span>`;
				});
			},
			codeBlockRenderCallback: () => this._onDidRenderCodeBlock.fire()
		};
	}

	render(markdown: IMarkdownString, options?: RenderOptions): HTMLElement {
		if (!markdown) {
			return document.createElement('span');
		}
		if (options) {
			return renderMarkdown(markdown, { ...options, ...this._options });
		} else {
			return renderMarkdown(markdown, this._options);
		}
	}
}
