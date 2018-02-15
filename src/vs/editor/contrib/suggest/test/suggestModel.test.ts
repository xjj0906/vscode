/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as assert from 'assert';
import Event from 'vs/base/common/event';
import URI from 'vs/base/common/uri';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { TextModel } from 'vs/editor/common/model/textModel';
import { Handler } from 'vs/editor/common/editorCommon';
import { ISuggestSupport, ISuggestResult, SuggestRegistry, SuggestTriggerKind } from 'vs/editor/common/modes';
import { SuggestModel, LineContext } from 'vs/editor/contrib/suggest/suggestModel';
import { TestCodeEditor, MockScopeLocation } from 'vs/editor/test/browser/testCodeEditor';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { InstantiationService } from 'vs/platform/instantiation/common/instantiationService';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { MockContextKeyService } from 'vs/platform/keybinding/test/common/mockKeybindingService';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { NullTelemetryService } from 'vs/platform/telemetry/common/telemetryUtils';
import { EditOperation } from 'vs/editor/common/core/editOperation';
import { Range } from 'vs/editor/common/core/range';
import { CoreEditingCommands } from 'vs/editor/browser/controller/coreCommands';
import { SuggestController } from 'vs/editor/contrib/suggest/suggestController';
import { IStorageService, NullStorageService } from 'vs/platform/storage/common/storage';
import { SnippetController2 } from 'vs/editor/contrib/snippet/snippetController2';
import { ISelectedSuggestion } from 'vs/editor/contrib/suggest/suggestWidget';

function createMockEditor(model: TextModel): TestCodeEditor {
	const contextKeyService = new MockContextKeyService();
	const telemetryService = NullTelemetryService;
	const instantiationService = new InstantiationService(new ServiceCollection(
		[IContextKeyService, contextKeyService],
		[ITelemetryService, telemetryService],
		[IStorageService, NullStorageService]
	));

	const editor = new TestCodeEditor(new MockScopeLocation(), {}, instantiationService, contextKeyService);
	editor.setModel(model);
	return editor;
}

suite('SuggestModel - Context', function () {

	let model: TextModel;

	setup(function () {
		model = TextModel.createFromString('Das Pferd frisst keinen Gurkensalat - Philipp Reis 1861.\nWer hat\'s erfunden?');
	});

	teardown(function () {
		model.dispose();
	});

	test('Context - shouldAutoTrigger', function () {

		function assertAutoTrigger(offset: number, expected: boolean): void {
			const pos = model.getPositionAt(offset);
			const editor = createMockEditor(model);
			editor.setPosition(pos);
			assert.equal(LineContext.shouldAutoTrigger(editor), expected);
			editor.dispose();
		}

		assertAutoTrigger(3, true); // end of word, Das|
		assertAutoTrigger(4, false); // no word Das |
		assertAutoTrigger(1, false); // middle of word D|as
		assertAutoTrigger(55, false); // number, 1861|
	});

});

suite('SuggestModel - TriggerAndCancelOracle', function () {


	const alwaysEmptySupport: ISuggestSupport = {
		provideCompletionItems(doc, pos): ISuggestResult {
			return {
				incomplete: false,
				suggestions: []
			};
		}
	};

	const alwaysSomethingSupport: ISuggestSupport = {
		provideCompletionItems(doc, pos): ISuggestResult {
			return {
				incomplete: false,
				suggestions: [{
					label: doc.getWordUntilPosition(pos).word,
					type: 'property',
					insertText: 'foofoo'
				}]
			};
		}
	};

	let disposables: IDisposable[] = [];
	let model: TextModel;

	setup(function () {
		disposables = dispose(disposables);
		model = TextModel.createFromString('abc def', undefined, undefined, URI.parse('test:somefile.ttt'));
		disposables.push(model);
	});

	function withOracle(callback: (model: SuggestModel, editor: TestCodeEditor) => any): Promise<any> {

		return new Promise((resolve, reject) => {
			const editor = createMockEditor(model);
			const oracle = new SuggestModel(editor);
			disposables.push(oracle, editor);

			try {
				resolve(callback(oracle, editor));
			} catch (err) {
				reject(err);
			}
		});
	}

	function assertEvent<E>(event: Event<E>, action: () => any, assert: (e: E) => any) {
		return new Promise((resolve, reject) => {
			const sub = event(e => {
				sub.dispose();
				try {
					resolve(assert(e));
				} catch (err) {
					reject(err);
				}
			});
			try {
				action();
			} catch (err) {
				reject(err);
			}
		});
	}

	test('events - cancel/trigger', function () {
		return withOracle(model => {

			return Promise.all([
				assertEvent(model.onDidCancel, function () {
					model.cancel();
				}, function (event) {
					assert.equal(event.retrigger, false);
				}),

				assertEvent(model.onDidCancel, function () {
					model.cancel(true);
				}, function (event) {
					assert.equal(event.retrigger, true);
				}),

				// cancel on trigger
				assertEvent(model.onDidCancel, function () {
					model.trigger({ auto: false });
				}, function (event) {
					assert.equal(event.retrigger, false);
				}),

				assertEvent(model.onDidCancel, function () {
					model.trigger({ auto: false }, true);
				}, function (event) {
					assert.equal(event.retrigger, true);
				}),

				assertEvent(model.onDidTrigger, function () {
					model.trigger({ auto: true });
				}, function (event) {
					assert.equal(event.auto, true);
				}),

				assertEvent(model.onDidTrigger, function () {
					model.trigger({ auto: false });
				}, function (event) {
					assert.equal(event.auto, false);
				})
			]);
		});
	});


	test('events - suggest/empty', function () {

		disposables.push(SuggestRegistry.register({ scheme: 'test' }, alwaysEmptySupport));

		return withOracle(model => {
			return Promise.all([
				assertEvent(model.onDidCancel, function () {
					model.trigger({ auto: true });
				}, function (event) {
					assert.equal(event.retrigger, false);
				}),
				assertEvent(model.onDidSuggest, function () {
					model.trigger({ auto: false });
				}, function (event) {
					assert.equal(event.auto, false);
					assert.equal(event.isFrozen, false);
					assert.equal(event.completionModel.items.length, 0);
				})
			]);
		});
	});

	test('trigger - on type', function () {

		disposables.push(SuggestRegistry.register({ scheme: 'test' }, alwaysSomethingSupport));

		return withOracle((model, editor) => {
			return assertEvent(model.onDidSuggest, () => {
				editor.setPosition({ lineNumber: 1, column: 4 });
				editor.trigger('keyboard', Handler.Type, { text: 'd' });

			}, event => {
				assert.equal(event.auto, true);
				assert.equal(event.completionModel.items.length, 1);
				const [first] = event.completionModel.items;

				assert.equal(first.support, alwaysSomethingSupport);
			});
		});
	});

	test('#17400: Keep filtering suggestModel.ts after space', function () {

		disposables.push(SuggestRegistry.register({ scheme: 'test' }, {
			provideCompletionItems(doc, pos): ISuggestResult {
				return {
					incomplete: false,
					suggestions: [{
						label: 'My Table',
						type: 'property',
						insertText: 'My Table'
					}]
				};
			}
		}));

		model.setValue('');

		return withOracle((model, editor) => {

			return assertEvent(model.onDidSuggest, () => {
				// make sure completionModel starts here!
				model.trigger({ auto: true });
			}, event => {

				return assertEvent(model.onDidSuggest, () => {
					editor.setPosition({ lineNumber: 1, column: 1 });
					editor.trigger('keyboard', Handler.Type, { text: 'My' });

				}, event => {
					assert.equal(event.auto, true);
					assert.equal(event.completionModel.items.length, 1);
					const [first] = event.completionModel.items;
					assert.equal(first.suggestion.label, 'My Table');

					return assertEvent(model.onDidSuggest, () => {
						editor.setPosition({ lineNumber: 1, column: 3 });
						editor.trigger('keyboard', Handler.Type, { text: ' ' });

					}, event => {
						assert.equal(event.auto, true);
						assert.equal(event.completionModel.items.length, 1);
						const [first] = event.completionModel.items;
						assert.equal(first.suggestion.label, 'My Table');
					});
				});
			});
		});
	});

	test('#21484: Trigger character always force a new completion session', function () {

		disposables.push(SuggestRegistry.register({ scheme: 'test' }, {
			provideCompletionItems(doc, pos): ISuggestResult {
				return {
					incomplete: false,
					suggestions: [{
						label: 'foo.bar',
						type: 'property',
						insertText: 'foo.bar',
						overwriteBefore: pos.column - 1
					}]
				};
			}
		}));

		disposables.push(SuggestRegistry.register({ scheme: 'test' }, {
			triggerCharacters: ['.'],
			provideCompletionItems(doc, pos): ISuggestResult {
				return {
					incomplete: false,
					suggestions: [{
						label: 'boom',
						type: 'property',
						insertText: 'boom',
						overwriteBefore: doc.getLineContent(pos.lineNumber)[pos.column - 2] === '.' ? 0 : pos.column - 1
					}]
				};
			}
		}));

		model.setValue('');

		return withOracle((model, editor) => {

			return assertEvent(model.onDidSuggest, () => {
				editor.setPosition({ lineNumber: 1, column: 1 });
				editor.trigger('keyboard', Handler.Type, { text: 'foo' });

			}, event => {
				assert.equal(event.auto, true);
				assert.equal(event.completionModel.items.length, 1);
				const [first] = event.completionModel.items;
				assert.equal(first.suggestion.label, 'foo.bar');

				return assertEvent(model.onDidSuggest, () => {
					editor.trigger('keyboard', Handler.Type, { text: '.' });

				}, event => {
					assert.equal(event.auto, true);
					assert.equal(event.completionModel.items.length, 2);
					const [first, second] = event.completionModel.items;
					assert.equal(first.suggestion.label, 'foo.bar');
					assert.equal(second.suggestion.label, 'boom');
				});
			});
		});
	});

	test('Intellisense Completion doesn\'t respect space after equal sign (.html file), #29353 [1/2]', function () {

		disposables.push(SuggestRegistry.register({ scheme: 'test' }, alwaysSomethingSupport));

		return withOracle((model, editor) => {

			editor.getModel().setValue('fo');
			editor.setPosition({ lineNumber: 1, column: 3 });

			return assertEvent(model.onDidSuggest, () => {
				model.trigger({ auto: false });
			}, event => {
				assert.equal(event.auto, false);
				assert.equal(event.isFrozen, false);
				assert.equal(event.completionModel.items.length, 1);

				return assertEvent(model.onDidCancel, () => {
					editor.trigger('keyboard', Handler.Type, { text: '+' });
				}, event => {
					assert.equal(event.retrigger, false);
				});
			});
		});
	});

	test('Intellisense Completion doesn\'t respect space after equal sign (.html file), #29353 [2/2]', function () {

		disposables.push(SuggestRegistry.register({ scheme: 'test' }, alwaysSomethingSupport));

		return withOracle((model, editor) => {

			editor.getModel().setValue('fo');
			editor.setPosition({ lineNumber: 1, column: 3 });

			return assertEvent(model.onDidSuggest, () => {
				model.trigger({ auto: false });
			}, event => {
				assert.equal(event.auto, false);
				assert.equal(event.isFrozen, false);
				assert.equal(event.completionModel.items.length, 1);

				return assertEvent(model.onDidCancel, () => {
					editor.trigger('keyboard', Handler.Type, { text: ' ' });
				}, event => {
					assert.equal(event.retrigger, false);
				});
			});
		});
	});

	test('Incomplete suggestion results cause re-triggering when typing w/o further context, #28400 (1/2)', function () {

		disposables.push(SuggestRegistry.register({ scheme: 'test' }, {
			provideCompletionItems(doc, pos): ISuggestResult {
				return {
					incomplete: true,
					suggestions: [{
						label: 'foo',
						type: 'property',
						insertText: 'foo',
						overwriteBefore: pos.column - 1
					}]
				};
			}
		}));

		return withOracle((model, editor) => {

			editor.getModel().setValue('foo');
			editor.setPosition({ lineNumber: 1, column: 4 });

			return assertEvent(model.onDidSuggest, () => {
				model.trigger({ auto: false });
			}, event => {
				assert.equal(event.auto, false);
				assert.equal(event.completionModel.incomplete, true);
				assert.equal(event.completionModel.items.length, 1);

				return assertEvent(model.onDidCancel, () => {
					editor.trigger('keyboard', Handler.Type, { text: ';' });
				}, event => {
					assert.equal(event.retrigger, false);
				});
			});
		});
	});

	test('Incomplete suggestion results cause re-triggering when typing w/o further context, #28400 (2/2)', function () {

		disposables.push(SuggestRegistry.register({ scheme: 'test' }, {
			provideCompletionItems(doc, pos): ISuggestResult {
				return {
					incomplete: true,
					suggestions: [{
						label: 'foo;',
						type: 'property',
						insertText: 'foo',
						overwriteBefore: pos.column - 1
					}]
				};
			}
		}));

		return withOracle((model, editor) => {

			editor.getModel().setValue('foo');
			editor.setPosition({ lineNumber: 1, column: 4 });

			return assertEvent(model.onDidSuggest, () => {
				model.trigger({ auto: false });
			}, event => {
				assert.equal(event.auto, false);
				assert.equal(event.completionModel.incomplete, true);
				assert.equal(event.completionModel.items.length, 1);

				return assertEvent(model.onDidSuggest, () => {
					// while we cancel incrementally enriching the set of
					// completions we still filter against those that we have
					// until now
					editor.trigger('keyboard', Handler.Type, { text: ';' });
				}, event => {
					assert.equal(event.auto, false);
					assert.equal(event.completionModel.incomplete, true);
					assert.equal(event.completionModel.items.length, 1);

				});
			});
		});
	});

	test('Trigger character is provided in suggest context', function () {
		let triggerCharacter = '';
		disposables.push(SuggestRegistry.register({ scheme: 'test' }, {
			triggerCharacters: ['.'],
			provideCompletionItems(doc, pos, context): ISuggestResult {
				assert.equal(context.triggerKind, SuggestTriggerKind.TriggerCharacter);
				triggerCharacter = context.triggerCharacter;
				return {
					incomplete: false,
					suggestions: [
						{
							label: 'foo.bar',
							type: 'property',
							insertText: 'foo.bar',
							overwriteBefore: pos.column - 1
						}
					]
				};
			}
		}));

		model.setValue('');

		return withOracle((model, editor) => {

			return assertEvent(model.onDidSuggest, () => {
				editor.setPosition({ lineNumber: 1, column: 1 });
				editor.trigger('keyboard', Handler.Type, { text: 'foo.' });
			}, event => {
				assert.equal(triggerCharacter, '.');
			});
		});
	});

	test('Mac press and hold accent character insertion does not update suggestions, #35269', function () {
		disposables.push(SuggestRegistry.register({ scheme: 'test' }, {
			provideCompletionItems(doc, pos): ISuggestResult {
				return {
					incomplete: true,
					suggestions: [{
						label: 'abc',
						type: 'property',
						insertText: 'abc',
						overwriteBefore: pos.column - 1
					}, {
						label: 'äbc',
						type: 'property',
						insertText: 'äbc',
						overwriteBefore: pos.column - 1
					}]
				};
			}
		}));

		model.setValue('');
		return withOracle((model, editor) => {

			return assertEvent(model.onDidSuggest, () => {
				editor.setPosition({ lineNumber: 1, column: 1 });
				editor.trigger('keyboard', Handler.Type, { text: 'a' });
			}, event => {
				assert.equal(event.completionModel.items.length, 1);
				assert.equal(event.completionModel.items[0].suggestion.label, 'abc');

				return assertEvent(model.onDidSuggest, () => {
					editor.executeEdits('test', [EditOperation.replace(new Range(1, 1, 1, 2), 'ä')]);

				}, event => {
					// suggest model changed to äbc
					assert.equal(event.completionModel.items.length, 1);
					assert.equal(event.completionModel.items[0].suggestion.label, 'äbc');

				});
			});
		});
	});

	test('Backspace should not always cancel code completion, #36491', function () {
		disposables.push(SuggestRegistry.register({ scheme: 'test' }, alwaysSomethingSupport));

		return withOracle(async (model, editor) => {
			await assertEvent(model.onDidSuggest, () => {
				editor.setPosition({ lineNumber: 1, column: 4 });
				editor.trigger('keyboard', Handler.Type, { text: 'd' });

			}, event => {
				assert.equal(event.auto, true);
				assert.equal(event.completionModel.items.length, 1);
				const [first] = event.completionModel.items;

				assert.equal(first.support, alwaysSomethingSupport);
			});

			await assertEvent(model.onDidSuggest, () => {
				CoreEditingCommands.DeleteLeft.runEditorCommand(null, editor, null);

			}, event => {
				assert.equal(event.auto, true);
				assert.equal(event.completionModel.items.length, 1);
				const [first] = event.completionModel.items;

				assert.equal(first.support, alwaysSomethingSupport);
			});
		});
	});

	test('Text changes for completion CodeAction are affected by the completion #39893', function () {
		disposables.push(SuggestRegistry.register({ scheme: 'test' }, {
			provideCompletionItems(doc, pos): ISuggestResult {
				return {
					incomplete: true,
					suggestions: [{
						label: 'bar',
						type: 'property',
						insertText: 'bar',
						overwriteBefore: 2,
						additionalTextEdits: [{
							text: ', bar',
							range: { startLineNumber: 1, endLineNumber: 1, startColumn: 17, endColumn: 17 }
						}]
					}]
				};
			}
		}));

		model.setValue('ba; import { foo } from "./b"');

		return withOracle(async (sugget, editor) => {
			class TestCtrl extends SuggestController {
				_onDidSelectItem(item: ISelectedSuggestion) {
					super._onDidSelectItem(item);
				}
			}
			const ctrl = <TestCtrl>editor.registerAndInstantiateContribution(TestCtrl);
			editor.registerAndInstantiateContribution(SnippetController2);

			await assertEvent(sugget.onDidSuggest, () => {
				editor.setPosition({ lineNumber: 1, column: 3 });
				sugget.trigger({ auto: false });
			}, event => {

				assert.equal(event.completionModel.items.length, 1);
				const [first] = event.completionModel.items;
				assert.equal(first.suggestion.label, 'bar');

				ctrl._onDidSelectItem({ item: first, index: 0, model: event.completionModel });
			});

			assert.equal(
				model.getValue(),
				'bar; import { foo, bar } from "./b"'
			);
		});
	});
});
