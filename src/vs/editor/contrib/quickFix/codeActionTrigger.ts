/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { startsWith } from 'vs/base/common/strings';

export class CodeActionKind {
	private static readonly sep = '.';

	public static readonly Empty = new CodeActionKind('');
	public static readonly Refactor = new CodeActionKind('refactor');

	constructor(
		public readonly value: string
	) { }

	public contains(other: string): boolean {
		return this.value === other || startsWith(other, this.value + CodeActionKind.sep);
	}
}

export enum CodeActionAutoApply {
	IfSingle = 1,
	First = 2,
	Never = 3
}

export interface CodeActionTrigger {
	type: 'auto' | 'manual';
	kind?: CodeActionKind;
	autoApply?: CodeActionAutoApply;
}