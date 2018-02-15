/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as strings from 'vs/base/common/strings';
import { Position, IPosition } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import * as editorCommon from 'vs/editor/common/editorCommon';
import { TokenizationRegistry, ColorId, LanguageId } from 'vs/editor/common/modes';
import { tokenizeLineToHTML } from 'vs/editor/common/modes/textToHtmlTokenizer';
import { ViewModelDecorations } from 'vs/editor/common/viewModel/viewModelDecorations';
import { MinimapLinesRenderingData, ViewLineRenderingData, ViewModelDecoration, IViewModel, ICoordinatesConverter, ViewEventsCollector, IOverviewRulerDecorations } from 'vs/editor/common/viewModel/viewModel';
import { SplitLinesCollection, IViewModelLinesCollection, IdentityLinesCollection } from 'vs/editor/common/viewModel/splitLinesCollection';
import * as viewEvents from 'vs/editor/common/view/viewEvents';
import { MinimapTokensColorTracker } from 'vs/editor/common/view/minimapCharRenderer';
import * as textModelEvents from 'vs/editor/common/model/textModelEvents';
import { IConfigurationChangedEvent } from 'vs/editor/common/config/editorOptions';
import { CharacterHardWrappingLineMapperFactory } from 'vs/editor/common/viewModel/characterHardWrappingLineMapper';
import { ViewLayout } from 'vs/editor/common/viewLayout/viewLayout';
import { Color } from 'vs/base/common/color';
import { IDisposable } from 'vs/base/common/lifecycle';
import { ITheme } from 'vs/platform/theme/common/themeService';
import { ModelDecorationOverviewRulerOptions } from 'vs/editor/common/model/textModel';
import { ITextModel, EndOfLinePreference } from 'vs/editor/common/model';

const USE_IDENTITY_LINES_COLLECTION = true;

export class ViewModel extends viewEvents.ViewEventEmitter implements IViewModel {

	private readonly editorId: number;
	private readonly configuration: editorCommon.IConfiguration;
	private readonly model: ITextModel;
	private readonly lines: IViewModelLinesCollection;
	public readonly coordinatesConverter: ICoordinatesConverter;
	public readonly viewLayout: ViewLayout;

	private readonly decorations: ViewModelDecorations;

	private _centeredViewLine: number;

	constructor(editorId: number, configuration: editorCommon.IConfiguration, model: ITextModel, scheduleAtNextAnimationFrame: (callback: () => void) => IDisposable) {
		super();

		this.editorId = editorId;
		this.configuration = configuration;
		this.model = model;

		if (USE_IDENTITY_LINES_COLLECTION && this.model.isTooLargeForTokenization()) {

			this.lines = new IdentityLinesCollection(this.model);

		} else {
			const conf = this.configuration.editor;

			let hardWrappingLineMapperFactory = new CharacterHardWrappingLineMapperFactory(
				conf.wrappingInfo.wordWrapBreakBeforeCharacters,
				conf.wrappingInfo.wordWrapBreakAfterCharacters,
				conf.wrappingInfo.wordWrapBreakObtrusiveCharacters
			);

			this.lines = new SplitLinesCollection(
				this.model,
				hardWrappingLineMapperFactory,
				this.model.getOptions().tabSize,
				conf.wrappingInfo.wrappingColumn,
				conf.fontInfo.typicalFullwidthCharacterWidth / conf.fontInfo.typicalHalfwidthCharacterWidth,
				conf.wrappingInfo.wrappingIndent
			);
		}

		this.coordinatesConverter = this.lines.createCoordinatesConverter();

		this.viewLayout = this._register(new ViewLayout(this.configuration, this.getLineCount(), scheduleAtNextAnimationFrame));

		this._register(this.viewLayout.onDidScroll((e) => {
			this._emit([new viewEvents.ViewScrollChangedEvent(e)]);
		}));

		this._centeredViewLine = -1;

		this.decorations = new ViewModelDecorations(this.editorId, this.model, this.configuration, this.lines, this.coordinatesConverter);

		this._registerModelEvents();

		this._register(this.configuration.onDidChange((e) => {
			const eventsCollector = new ViewEventsCollector();
			this._onConfigurationChanged(eventsCollector, e);
			this._emit(eventsCollector.finalize());
		}));

		this._register(MinimapTokensColorTracker.getInstance().onDidChange(() => {
			this._emit([new viewEvents.ViewTokensColorsChangedEvent()]);
		}));
	}

	public dispose(): void {
		// First remove listeners, as disposing the lines might end up sending
		// model decoration changed events ... and we no longer care about them ...
		super.dispose();
		this.decorations.dispose();
		this.lines.dispose();
	}

	private _onConfigurationChanged(eventsCollector: ViewEventsCollector, e: IConfigurationChangedEvent): void {

		// We might need to restore the current centered view range, so save it (if available)
		const previousCenteredModelRange = this.getCenteredRangeInViewport();
		let revealPreviousCenteredModelRange = false;

		const conf = this.configuration.editor;

		if (this.lines.setWrappingSettings(conf.wrappingInfo.wrappingIndent, conf.wrappingInfo.wrappingColumn, conf.fontInfo.typicalFullwidthCharacterWidth / conf.fontInfo.typicalHalfwidthCharacterWidth)) {
			eventsCollector.emit(new viewEvents.ViewFlushedEvent());
			eventsCollector.emit(new viewEvents.ViewLineMappingChangedEvent());
			eventsCollector.emit(new viewEvents.ViewDecorationsChangedEvent());
			this.decorations.onLineMappingChanged();
			this.viewLayout.onFlushed(this.getLineCount());

			if (this.viewLayout.getCurrentScrollTop() !== 0) {
				// Never change the scroll position from 0 to something else...
				revealPreviousCenteredModelRange = true;
			}
		}

		if (e.readOnly) {
			// Must read again all decorations due to readOnly filtering
			this.decorations.reset();
			eventsCollector.emit(new viewEvents.ViewDecorationsChangedEvent());
		}

		eventsCollector.emit(new viewEvents.ViewConfigurationChangedEvent(e));
		this.viewLayout.onConfigurationChanged(e);

		if (revealPreviousCenteredModelRange && previousCenteredModelRange) {
			// modelLine -> viewLine
			const newCenteredViewRange = this.coordinatesConverter.convertModelRangeToViewRange(previousCenteredModelRange);

			// Send a reveal event to restore the centered content
			eventsCollector.emit(new viewEvents.ViewRevealRangeRequestEvent(
				newCenteredViewRange,
				viewEvents.VerticalRevealType.Center,
				false,
				editorCommon.ScrollType.Immediate
			));
		}
	}

	private _registerModelEvents(): void {

		this._register(this.model.onDidChangeRawContent((e) => {
			const eventsCollector = new ViewEventsCollector();

			// Update the configuration and reset the centered view line
			this._centeredViewLine = -1;
			this.configuration.setMaxLineNumber(this.model.getLineCount());

			let hadOtherModelChange = false;
			let hadModelLineChangeThatChangedLineMapping = false;

			const changes = e.changes;
			const versionId = e.versionId;

			for (let j = 0, lenJ = changes.length; j < lenJ; j++) {
				const change = changes[j];

				switch (change.changeType) {
					case textModelEvents.RawContentChangedType.Flush: {
						this.lines.onModelFlushed();
						eventsCollector.emit(new viewEvents.ViewFlushedEvent());
						this.decorations.reset();
						this.viewLayout.onFlushed(this.getLineCount());
						hadOtherModelChange = true;
						break;
					}
					case textModelEvents.RawContentChangedType.LinesDeleted: {
						const linesDeletedEvent = this.lines.onModelLinesDeleted(versionId, change.fromLineNumber, change.toLineNumber);
						if (linesDeletedEvent !== null) {
							eventsCollector.emit(linesDeletedEvent);
							this.viewLayout.onLinesDeleted(linesDeletedEvent.fromLineNumber, linesDeletedEvent.toLineNumber);
						}
						hadOtherModelChange = true;
						break;
					}
					case textModelEvents.RawContentChangedType.LinesInserted: {
						const linesInsertedEvent = this.lines.onModelLinesInserted(versionId, change.fromLineNumber, change.toLineNumber, change.detail);
						if (linesInsertedEvent !== null) {
							eventsCollector.emit(linesInsertedEvent);
							this.viewLayout.onLinesInserted(linesInsertedEvent.fromLineNumber, linesInsertedEvent.toLineNumber);
						}
						hadOtherModelChange = true;
						break;
					}
					case textModelEvents.RawContentChangedType.LineChanged: {
						const [lineMappingChanged, linesChangedEvent, linesInsertedEvent, linesDeletedEvent] = this.lines.onModelLineChanged(versionId, change.lineNumber, change.detail);
						hadModelLineChangeThatChangedLineMapping = lineMappingChanged;
						if (linesChangedEvent) {
							eventsCollector.emit(linesChangedEvent);
						}
						if (linesInsertedEvent) {
							eventsCollector.emit(linesInsertedEvent);
							this.viewLayout.onLinesInserted(linesInsertedEvent.fromLineNumber, linesInsertedEvent.toLineNumber);
						}
						if (linesDeletedEvent) {
							eventsCollector.emit(linesDeletedEvent);
							this.viewLayout.onLinesDeleted(linesDeletedEvent.fromLineNumber, linesDeletedEvent.toLineNumber);
						}
						break;
					}
					case textModelEvents.RawContentChangedType.EOLChanged: {
						// Nothing to do. The new version will be accepted below
						break;
					}
				}
			}
			this.lines.acceptVersionId(versionId);

			if (!hadOtherModelChange && hadModelLineChangeThatChangedLineMapping) {
				eventsCollector.emit(new viewEvents.ViewLineMappingChangedEvent());
				eventsCollector.emit(new viewEvents.ViewDecorationsChangedEvent());
				this.decorations.onLineMappingChanged();
			}

			this._emit(eventsCollector.finalize());
		}));

		this._register(this.model.onDidChangeTokens((e) => {
			let viewRanges: { fromLineNumber: number; toLineNumber: number; }[] = [];
			for (let j = 0, lenJ = e.ranges.length; j < lenJ; j++) {
				const modelRange = e.ranges[j];
				const viewStartLineNumber = this.coordinatesConverter.convertModelPositionToViewPosition(new Position(modelRange.fromLineNumber, 1)).lineNumber;
				const viewEndLineNumber = this.coordinatesConverter.convertModelPositionToViewPosition(new Position(modelRange.toLineNumber, this.model.getLineMaxColumn(modelRange.toLineNumber))).lineNumber;
				viewRanges[j] = {
					fromLineNumber: viewStartLineNumber,
					toLineNumber: viewEndLineNumber
				};
			}
			this._emit([new viewEvents.ViewTokensChangedEvent(viewRanges)]);
		}));

		this._register(this.model.onDidChangeLanguageConfiguration((e) => {
			this._emit([new viewEvents.ViewLanguageConfigurationEvent()]);
		}));

		this._register(this.model.onDidChangeOptions((e) => {
			// A tab size change causes a line mapping changed event => all view parts will repaint OK, no further event needed here
			if (this.lines.setTabSize(this.model.getOptions().tabSize)) {
				this.decorations.onLineMappingChanged();
				this.viewLayout.onFlushed(this.getLineCount());
				this._emit([
					new viewEvents.ViewFlushedEvent(),
					new viewEvents.ViewLineMappingChangedEvent(),
					new viewEvents.ViewDecorationsChangedEvent(),
				]);
			}
		}));

		this._register(this.model.onDidChangeDecorations((e) => {
			this.decorations.onModelDecorationsChanged();
			this._emit([new viewEvents.ViewDecorationsChangedEvent()]);
		}));
	}

	public setHiddenAreas(ranges: Range[]): void {
		let eventsCollector = new ViewEventsCollector();
		let lineMappingChanged = this.lines.setHiddenAreas(ranges);
		if (lineMappingChanged) {
			eventsCollector.emit(new viewEvents.ViewFlushedEvent());
			eventsCollector.emit(new viewEvents.ViewLineMappingChangedEvent());
			eventsCollector.emit(new viewEvents.ViewDecorationsChangedEvent());
			this.decorations.onLineMappingChanged();
			this.viewLayout.onFlushed(this.getLineCount());
		}
		this._emit(eventsCollector.finalize());
	}

	public getCenteredRangeInViewport(): Range {
		if (this._centeredViewLine === -1) {
			// Never got rendered or not rendered since last content change event
			return null;
		}
		let viewLineNumber = this._centeredViewLine;
		let currentCenteredViewRange = new Range(viewLineNumber, this.getLineMinColumn(viewLineNumber), viewLineNumber, this.getLineMaxColumn(viewLineNumber));
		return this.coordinatesConverter.convertViewRangeToModelRange(currentCenteredViewRange);
	}

	public getCompletelyVisibleViewRange(): Range {
		const partialData = this.viewLayout.getLinesViewportData();
		const startViewLineNumber = partialData.completelyVisibleStartLineNumber;
		const endViewLineNumber = partialData.completelyVisibleEndLineNumber;

		return new Range(
			startViewLineNumber, this.getLineMinColumn(startViewLineNumber),
			endViewLineNumber, this.getLineMaxColumn(endViewLineNumber)
		);
	}

	public getCompletelyVisibleViewRangeAtScrollTop(scrollTop: number): Range {
		const partialData = this.viewLayout.getLinesViewportDataAtScrollTop(scrollTop);
		const startViewLineNumber = partialData.completelyVisibleStartLineNumber;
		const endViewLineNumber = partialData.completelyVisibleEndLineNumber;

		return new Range(
			startViewLineNumber, this.getLineMinColumn(startViewLineNumber),
			endViewLineNumber, this.getLineMaxColumn(endViewLineNumber)
		);
	}

	public getTabSize(): number {
		return this.model.getOptions().tabSize;
	}

	public getLineCount(): number {
		return this.lines.getViewLineCount();
	}

	/**
	 * Gives a hint that a lot of requests are about to come in for these line numbers.
	 */
	public setViewport(startLineNumber: number, endLineNumber: number, centeredLineNumber: number): void {
		this._centeredViewLine = centeredLineNumber;
		this.lines.warmUpLookupCache(startLineNumber, endLineNumber);
	}

	public getLinesIndentGuides(startLineNumber: number, endLineNumber: number): number[] {
		return this.lines.getViewLinesIndentGuides(startLineNumber, endLineNumber);
	}

	public getLineContent(lineNumber: number): string {
		return this.lines.getViewLineContent(lineNumber);
	}

	public getLineMinColumn(lineNumber: number): number {
		return this.lines.getViewLineMinColumn(lineNumber);
	}

	public getLineMaxColumn(lineNumber: number): number {
		return this.lines.getViewLineMaxColumn(lineNumber);
	}

	public getLineFirstNonWhitespaceColumn(lineNumber: number): number {
		const result = strings.firstNonWhitespaceIndex(this.getLineContent(lineNumber));
		if (result === -1) {
			return 0;
		}
		return result + 1;
	}

	public getLineLastNonWhitespaceColumn(lineNumber: number): number {
		const result = strings.lastNonWhitespaceIndex(this.getLineContent(lineNumber));
		if (result === -1) {
			return 0;
		}
		return result + 2;
	}

	public getDecorationsInViewport(visibleRange: Range): ViewModelDecoration[] {
		return this.decorations.getDecorationsViewportData(visibleRange).decorations;
	}

	public getViewLineRenderingData(visibleRange: Range, lineNumber: number): ViewLineRenderingData {
		let mightContainRTL = this.model.mightContainRTL();
		let mightContainNonBasicASCII = this.model.mightContainNonBasicASCII();
		let tabSize = this.getTabSize();
		let lineData = this.lines.getViewLineData(lineNumber);
		let allInlineDecorations = this.decorations.getDecorationsViewportData(visibleRange).inlineDecorations;
		let inlineDecorations = allInlineDecorations[lineNumber - visibleRange.startLineNumber];

		return new ViewLineRenderingData(
			lineData.minColumn,
			lineData.maxColumn,
			lineData.content,
			mightContainRTL,
			mightContainNonBasicASCII,
			lineData.tokens,
			inlineDecorations,
			tabSize
		);
	}

	public getMinimapLinesRenderingData(startLineNumber: number, endLineNumber: number, needed: boolean[]): MinimapLinesRenderingData {
		let result = this.lines.getViewLinesData(startLineNumber, endLineNumber, needed);
		return new MinimapLinesRenderingData(
			this.getTabSize(),
			result
		);
	}

	public getAllOverviewRulerDecorations(theme: ITheme): IOverviewRulerDecorations {
		return this.lines.getAllOverviewRulerDecorations(this.editorId, this.configuration.editor.readOnly, theme);
	}

	public invalidateOverviewRulerColorCache(): void {
		const decorations = this.model.getOverviewRulerDecorations();
		for (let i = 0, len = decorations.length; i < len; i++) {
			const decoration = decorations[i];
			const opts = <ModelDecorationOverviewRulerOptions>decoration.options.overviewRuler;
			opts._resolvedColor = null;
		}
	}

	public getValueInRange(range: Range, eol: EndOfLinePreference): string {
		const modelRange = this.coordinatesConverter.convertViewRangeToModelRange(range);
		return this.model.getValueInRange(modelRange, eol);
	}

	public getModelLineMaxColumn(modelLineNumber: number): number {
		return this.model.getLineMaxColumn(modelLineNumber);
	}

	public validateModelPosition(position: IPosition): Position {
		return this.model.validatePosition(position);
	}

	public deduceModelPositionRelativeToViewPosition(viewAnchorPosition: Position, deltaOffset: number, lineFeedCnt: number): Position {
		const modelAnchor = this.coordinatesConverter.convertViewPositionToModelPosition(viewAnchorPosition);
		if (this.model.getEOL().length === 2) {
			// This model uses CRLF, so the delta must take that into account
			if (deltaOffset < 0) {
				deltaOffset -= lineFeedCnt;
			} else {
				deltaOffset += lineFeedCnt;
			}
		}

		const modelAnchorOffset = this.model.getOffsetAt(modelAnchor);
		const resultOffset = modelAnchorOffset + deltaOffset;
		return this.model.getPositionAt(resultOffset);
	}

	public getEOL(): string {
		return this.model.getEOL();
	}

	public getPlainTextToCopy(ranges: Range[], emptySelectionClipboard: boolean): string | string[] {
		const newLineCharacter = this.model.getEOL();

		ranges = ranges.slice(0);
		ranges.sort(Range.compareRangesUsingStarts);
		const nonEmptyRanges = ranges.filter((r) => !r.isEmpty());

		if (nonEmptyRanges.length === 0) {
			if (!emptySelectionClipboard) {
				return '';
			}

			const modelLineNumbers = ranges.map((r) => {
				const viewLineStart = new Position(r.startLineNumber, 1);
				return this.coordinatesConverter.convertViewPositionToModelPosition(viewLineStart).lineNumber;
			});

			let result = '';
			for (let i = 0; i < modelLineNumbers.length; i++) {
				if (i > 0 && modelLineNumbers[i - 1] === modelLineNumbers[i]) {
					continue;
				}
				result += this.model.getLineContent(modelLineNumbers[i]) + newLineCharacter;
			}
			return result;
		}

		let result: string[] = [];
		for (let i = 0; i < nonEmptyRanges.length; i++) {
			result.push(this.getValueInRange(nonEmptyRanges[i], EndOfLinePreference.TextDefined));
		}
		return result.length === 1 ? result[0] : result;
	}

	public getHTMLToCopy(viewRanges: Range[], emptySelectionClipboard: boolean): string {
		if (this.model.getLanguageIdentifier().id === LanguageId.PlainText) {
			return null;
		}

		if (viewRanges.length !== 1) {
			// no multiple selection support at this time
			return null;
		}

		let range = this.coordinatesConverter.convertViewRangeToModelRange(viewRanges[0]);
		if (range.isEmpty()) {
			if (!emptySelectionClipboard) {
				// nothing to copy
				return null;
			}
			let lineNumber = range.startLineNumber;
			range = new Range(lineNumber, this.model.getLineMinColumn(lineNumber), lineNumber, this.model.getLineMaxColumn(lineNumber));
		}

		const fontInfo = this.configuration.editor.fontInfo;
		const colorMap = this._getColorMap();

		return (
			`<div style="`
			+ `color: ${colorMap[ColorId.DefaultForeground]};`
			+ `background-color: ${colorMap[ColorId.DefaultBackground]};`
			+ `font-family: ${fontInfo.fontFamily};`
			+ `font-weight: ${fontInfo.fontWeight};`
			+ `font-size: ${fontInfo.fontSize}px;`
			+ `line-height: ${fontInfo.lineHeight}px;`
			+ `white-space: pre;`
			+ `">`
			+ this._getHTMLToCopy(range, colorMap)
			+ '</div>'
		);
	}

	private _getHTMLToCopy(modelRange: Range, colorMap: string[]): string {
		const startLineNumber = modelRange.startLineNumber;
		const startColumn = modelRange.startColumn;
		const endLineNumber = modelRange.endLineNumber;
		const endColumn = modelRange.endColumn;

		const tabSize = this.getTabSize();

		let result = '';

		for (let lineNumber = startLineNumber; lineNumber <= endLineNumber; lineNumber++) {
			const lineTokens = this.model.getLineTokens(lineNumber);
			const lineContent = lineTokens.getLineContent();
			const startOffset = (lineNumber === startLineNumber ? startColumn - 1 : 0);
			const endOffset = (lineNumber === endLineNumber ? endColumn - 1 : lineContent.length);

			if (lineContent === '') {
				result += '<br>';
			} else {
				result += tokenizeLineToHTML(lineContent, lineTokens.inflate(), colorMap, startOffset, endOffset, tabSize);
			}
		}

		return result;
	}

	private _getColorMap(): string[] {
		let colorMap = TokenizationRegistry.getColorMap();
		let result: string[] = [null];
		for (let i = 1, len = colorMap.length; i < len; i++) {
			result[i] = Color.Format.CSS.formatHex(colorMap[i]);
		}
		return result;
	}
}
