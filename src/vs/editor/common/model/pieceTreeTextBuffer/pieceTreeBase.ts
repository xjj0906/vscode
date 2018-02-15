/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { Position } from 'vs/editor/common/core/position';
import { CharCode } from 'vs/base/common/charCode';
import { Range } from 'vs/editor/common/core/range';
import { ITextSnapshot } from 'vs/platform/files/common/files';
import { leftest, righttest, updateTreeMetadata, rbDelete, fixInsert, NodeColor, SENTINEL, TreeNode } from 'vs/editor/common/model/pieceTreeTextBuffer/rbTreeBase';

// const lfRegex = new RegExp(/\r\n|\r|\n/g);

export function createUintArray(arr: number[]): Uint32Array | Uint16Array {
	let r;
	if (arr[arr.length - 1] < 65536) {
		r = new Uint16Array(arr.length);
	} else {
		r = new Uint32Array(arr.length);
	}
	r.set(arr, 0);
	return r;
}

export class LineStarts {
	constructor(
		public readonly lineStarts: Uint32Array | Uint16Array | number[],
		public readonly cr: number,
		public readonly lf: number,
		public readonly crlf: number,
		public readonly isBasicASCII: boolean
	) { }
}

export function createLineStartsFast(str: string, readonly: boolean = true): Uint32Array | number[] {
	let r: number[] = [0], rLength = 1;

	for (let i = 0, len = str.length; i < len; i++) {
		const chr = str.charCodeAt(i);

		if (chr === CharCode.CarriageReturn) {
			if (i + 1 < len && str.charCodeAt(i + 1) === CharCode.LineFeed) {
				// \r\n... case
				r[rLength++] = i + 2;
				i++; // skip \n
			} else {
				// \r... case
				r[rLength++] = i + 1;
			}
		} else if (chr === CharCode.LineFeed) {
			r[rLength++] = i + 1;
		}
	}
	if (readonly) {
		return createUintArray(r);
	} else {
		return r;
	}
}

export function createLineStarts(r: number[], str: string): LineStarts {
	r.length = 0;
	r[0] = 0;
	let rLength = 1;
	let cr = 0, lf = 0, crlf = 0;
	let isBasicASCII = true;
	for (let i = 0, len = str.length; i < len; i++) {
		const chr = str.charCodeAt(i);

		if (chr === CharCode.CarriageReturn) {
			if (i + 1 < len && str.charCodeAt(i + 1) === CharCode.LineFeed) {
				// \r\n... case
				crlf++;
				r[rLength++] = i + 2;
				i++; // skip \n
			} else {
				cr++;
				// \r... case
				r[rLength++] = i + 1;
			}
		} else if (chr === CharCode.LineFeed) {
			lf++;
			r[rLength++] = i + 1;
		} else {
			if (isBasicASCII) {
				if (chr !== CharCode.Tab && (chr < 32 || chr > 126)) {
					isBasicASCII = false;
				}
			}
		}
	}
	const result = new LineStarts(createUintArray(r), cr, lf, crlf, isBasicASCII);
	r.length = 0;

	return result;
}

export interface NodePosition {
	/**
	 * Piece Index
	 */
	node: TreeNode;
	/**
	 * remainer in current piece.
	*/
	remainder: number;
	/**
	 * node start offset in document.
	 */
	nodeStartOffset: number;
}

export interface BufferCursor {
	/**
	 * Line number in current buffer
	 */
	line: number;
	/**
	 * Column number in current buffer
	 */
	column: number;
}

export class Piece {
	bufferIndex: number;
	start: BufferCursor;
	end: BufferCursor;
	length: number;
	lineFeedCnt: number;

	constructor(bufferIndex: number, start: BufferCursor, end: BufferCursor, lineFeedCnt: number, length: number) {
		this.bufferIndex = bufferIndex;
		this.start = start;
		this.end = end;
		this.lineFeedCnt = lineFeedCnt;
		this.length = length;
	}
}

export class StringBuffer {
	buffer: string;
	lineStarts: Uint32Array | Uint16Array | number[];

	constructor(buffer: string, lineStarts: Uint32Array | Uint16Array | number[]) {
		this.buffer = buffer;
		this.lineStarts = lineStarts;
	}
}

/**
 * Readonly snapshot for piece tree.
 * In a real multiple thread environment, to make snapshot reading always work correctly, we need to
 * 1. Make TreeNode.piece immutable, then reading and writing can run in parallel.
 * 2. TreeNode/Buffers normalization should not happen during snapshot reading.
 */
class PieceTreeSnapshot implements ITextSnapshot {
	private _nodes: TreeNode[]; // pieces/tree nodes in order
	private _index: number;
	private _tree: PieceTreeBase;
	private _BOM: string;

	constructor(tree: PieceTreeBase, BOM: string) {
		this._nodes = [];
		this._tree = tree;
		this._BOM = BOM;
		this._index = 0;
		if (tree.root !== SENTINEL) {
			tree.iterate(tree.root, node => {
				if (node !== SENTINEL) {
					this._nodes.push(node);
				}
				return true;
			});
		}
	}

	read(): string {
		if (this._nodes.length === 0) {
			if (this._index === 0) {
				this._index++;
				return this._BOM;
			} else {
				return null;
			}
		}

		if (this._index > this._nodes.length - 1) {
			return null;
		}

		if (this._index === 0) {
			return this._BOM + this._tree.getNodeContent(this._nodes[this._index++]);
		}
		return this._tree.getNodeContent(this._nodes[this._index++]);
	}
}

class PieceTreeSearchCache {
	private _limit: number;
	private _cache: { node: TreeNode, nodeStartOffset: number, nodeStartLineNumber?: number }[];

	constructor(limit: number) {
		this._limit = limit;
		this._cache = [];
	}

	public get(offset: number): { node: TreeNode, nodeStartOffset: number, nodeStartLineNumber?: number } {
		for (let i = this._cache.length - 1; i >= 0; i--) {
			let nodePos = this._cache[i];
			if (nodePos.nodeStartOffset <= offset && nodePos.nodeStartOffset + nodePos.node.piece.length >= offset) {
				return nodePos;
			}
		}
		return null;
	}

	public get2(lineNumber: number): { node: TreeNode, nodeStartOffset: number, nodeStartLineNumber?: number } {
		for (let i = this._cache.length - 1; i >= 0; i--) {
			let nodePos = this._cache[i];
			if (nodePos.nodeStartLineNumber && nodePos.nodeStartLineNumber < lineNumber && nodePos.nodeStartLineNumber + nodePos.node.piece.lineFeedCnt >= lineNumber) {
				return nodePos;
			}
		}
		return null;
	}

	public set(nodePosition: { node: TreeNode, nodeStartOffset: number, nodeStartLineNumber?: number }) {
		if (this._cache.length >= this._limit) {
			this._cache.shift();
		}
		this._cache.push(nodePosition);
	}

	public valdiate(offset: number) {
		let hasInvalidVal = false;
		for (let i = 0; i < this._cache.length; i++) {
			let nodePos = this._cache[i];
			if (nodePos.node.parent === null || nodePos.nodeStartOffset >= offset) {
				this._cache[i] = null;
				hasInvalidVal = true;
				continue;
			}
		}

		if (hasInvalidVal) {
			let newArr = [];
			for (let i = 0; i < this._cache.length; i++) {
				if (this._cache[i] !== null) {
					newArr.push(this._cache[i]);
				}
			}

			this._cache = newArr;
		}
	}
}

export class PieceTreeBase {
	root: TreeNode;
	protected _buffers: StringBuffer[]; // 0 is change buffer, others are readonly original buffer.
	protected _lineCnt: number;
	protected _length: number;
	protected _EOL: string;
	protected _EOLLength: number;
	protected _EOLNormalized: boolean;
	private _lastChangeBufferPos: BufferCursor;
	private _searchCache: PieceTreeSearchCache;

	constructor(chunks: StringBuffer[], eol: '\r\n' | '\n', eolNormalized: boolean) {
		this.create(chunks, eol, eolNormalized);
	}

	create(chunks: StringBuffer[], eol: '\r\n' | '\n', eolNormalized: boolean) {
		this._buffers = [
			new StringBuffer('', [0])
		];
		this._lastChangeBufferPos = { line: 0, column: 0 };
		this.root = SENTINEL;
		this._lineCnt = 1;
		this._length = 0;
		this._EOL = eol;
		this._EOLLength = eol.length;
		this._EOLNormalized = eolNormalized;

		let lastNode: TreeNode = null;
		for (let i = 0, len = chunks.length; i < len; i++) {
			if (chunks[i].buffer.length > 0) {
				if (!chunks[i].lineStarts) {
					chunks[i].lineStarts = createLineStartsFast(chunks[i].buffer);
				}

				let piece = new Piece(
					i + 1,
					{ line: 0, column: 0 },
					{ line: chunks[i].lineStarts.length - 1, column: chunks[i].buffer.length - chunks[i].lineStarts[chunks[i].lineStarts.length - 1] },
					chunks[i].lineStarts.length - 1,
					chunks[i].buffer.length
				);
				this._buffers.push(chunks[i]);
				lastNode = this.rbInsertRight(lastNode, piece);
			}
		}

		this._searchCache = new PieceTreeSearchCache(1);
		this.computeBufferMetadata();
	}

	normalizeEOL(eol: '\r\n' | '\n') {
		let averageBufferSize = 65536;
		let min = averageBufferSize - Math.floor(averageBufferSize / 3);
		let max = min * 2;

		let tempChunk = '';
		let tempChunkLen = 0;
		let chunks: StringBuffer[] = [];

		this.iterate(this.root, node => {
			let str = this.getNodeContent(node);
			let len = str.length;
			if (tempChunkLen <= min || tempChunkLen + len < max) {
				tempChunk += str;
				tempChunkLen += len;
				return true;
			}

			// flush anyways
			let text = tempChunk.replace(/\r\n|\r|\n/g, eol);
			chunks.push(new StringBuffer(text, createLineStartsFast(text)));
			tempChunk = str;
			tempChunkLen = len;
			return true;
		});

		if (tempChunkLen > 0) {
			let text = tempChunk.replace(/\r\n|\r|\n/g, eol);
			chunks.push(new StringBuffer(text, createLineStartsFast(text)));
		}

		this.create(chunks, eol, true);
	}

	// #region Buffer API
	public getEOL(): string {
		return this._EOL;
	}

	public setEOL(newEOL: '\r\n' | '\n'): void {
		this._EOL = newEOL;
		this._EOLLength = this._EOL.length;
		this.normalizeEOL(newEOL);
	}

	public createSnapshot(BOM: string): ITextSnapshot {
		return new PieceTreeSnapshot(this, BOM);
	}

	public equal(other: PieceTreeBase): boolean {
		if (this.getLength() !== other.getLength()) {
			return false;
		}
		if (this.getLineCount() !== other.getLineCount()) {
			return false;
		}

		let offset = 0;
		let ret = this.iterate(this.root, node => {
			if (node === SENTINEL) {
				return true;
			}
			let str = this.getNodeContent(node);
			let len = str.length;
			let startPosition = other.nodeAt(offset);
			let endPosition = other.nodeAt(offset + len);
			let val = other.getValueInRange2(startPosition, endPosition);

			return str === val;
		});

		return ret;
	}

	public getOffsetAt(lineNumber: number, column: number): number {
		let leftLen = 0; // inorder

		let x = this.root;

		while (x !== SENTINEL) {
			if (x.left !== SENTINEL && x.lf_left + 1 >= lineNumber) {
				x = x.left;
			} else if (x.lf_left + x.piece.lineFeedCnt + 1 >= lineNumber) {
				leftLen += x.size_left;
				// lineNumber >= 2
				let accumualtedValInCurrentIndex = this.getAccumulatedValue(x, lineNumber - x.lf_left - 2);
				return leftLen += accumualtedValInCurrentIndex + column - 1;
			} else {
				lineNumber -= x.lf_left + x.piece.lineFeedCnt;
				leftLen += x.size_left + x.piece.length;
				x = x.right;
			}
		}

		return leftLen;
	}

	public getPositionAt(offset: number): Position {
		offset = Math.floor(offset);
		offset = Math.max(0, offset);

		let x = this.root;
		let lfCnt = 0;
		let originalOffset = offset;

		while (x !== SENTINEL) {
			if (x.size_left !== 0 && x.size_left >= offset) {
				x = x.left;
			} else if (x.size_left + x.piece.length >= offset) {
				let out = this.getIndexOf(x, offset - x.size_left);

				lfCnt += x.lf_left + out.index;

				if (out.index === 0) {
					let lineStartOffset = this.getOffsetAt(lfCnt + 1, 1);
					let column = originalOffset - lineStartOffset;
					return new Position(lfCnt + 1, column + 1);
				}

				return new Position(lfCnt + 1, out.remainder + 1);
			} else {
				offset -= x.size_left + x.piece.length;
				lfCnt += x.lf_left + x.piece.lineFeedCnt;

				if (x.right === SENTINEL) {
					// last node
					let lineStartOffset = this.getOffsetAt(lfCnt + 1, 1);
					let column = originalOffset - offset - lineStartOffset;
					return new Position(lfCnt + 1, column + 1);
				} else {
					x = x.right;
				}
			}
		}

		return new Position(1, 1);
	}

	public getValueInRange(range: Range): string {
		if (range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn) {
			return '';
		}

		let startPosition = this.nodeAt2(range.startLineNumber, range.startColumn);
		let endPosition = this.nodeAt2(range.endLineNumber, range.endColumn);

		return this.getValueInRange2(startPosition, endPosition);
	}

	public getValueInRange2(startPosition: NodePosition, endPosition: NodePosition): string {
		if (startPosition.node === endPosition.node) {
			let node = startPosition.node;
			let buffer = this._buffers[node.piece.bufferIndex].buffer;
			let startOffset = this.offsetInBuffer(node.piece.bufferIndex, node.piece.start);
			return buffer.substring(startOffset + startPosition.remainder, startOffset + endPosition.remainder);
		}

		let x = startPosition.node;
		let buffer = this._buffers[x.piece.bufferIndex].buffer;
		let startOffset = this.offsetInBuffer(x.piece.bufferIndex, x.piece.start);
		let ret = buffer.substring(startOffset + startPosition.remainder, startOffset + x.piece.length);

		x = x.next();
		while (x !== SENTINEL) {
			let buffer = this._buffers[x.piece.bufferIndex].buffer;
			let startOffset = this.offsetInBuffer(x.piece.bufferIndex, x.piece.start);

			if (x === endPosition.node) {
				ret += buffer.substring(startOffset, startOffset + endPosition.remainder);
				break;
			} else {
				ret += buffer.substr(startOffset, x.piece.length);
			}

			x = x.next();
		}

		return ret;
	}

	public getLinesContent(): string[] {
		return this.getContentOfSubTree(this.root).split(/\r\n|\r|\n/);
	}

	public getLength(): number {
		return this._length;
	}

	public getLineCount(): number {
		return this._lineCnt;
	}

	public getLineContent(lineNumber): string {
		if (lineNumber === this._lineCnt) {
			return this.getLineRawContent(lineNumber);
		}

		if (this._EOLNormalized) {
			return this.getLineRawContent(lineNumber, this._EOLLength);
		} else {
			return this.getLineRawContent(lineNumber).replace(/(\r\n|\r|\n)$/, '');
		}
	}

	public getLineCharCode(lineNumber: number, index: number): number {
		let nodePos = this.nodeAt2(lineNumber, index + 1);
		let buffer = this._buffers[nodePos.node.piece.bufferIndex];
		let startOffset = this.offsetInBuffer(nodePos.node.piece.bufferIndex, nodePos.node.piece.start);
		let targetOffset = startOffset + index;

		return buffer.buffer.charCodeAt(targetOffset);
	}

	public getLineLength(lineNumber: number): number {
		if (lineNumber === this.getLineCount()) {
			let startOffset = this.getOffsetAt(lineNumber, 1);
			return this.getLength() - startOffset;
		}
		return this.getOffsetAt(lineNumber + 1, 1) - this.getOffsetAt(lineNumber, 1) - this._EOLLength;
	}

	// #endregion

	// #region Piece Table
	insert(offset: number, value: string, eolNormalized: boolean = false): void {
		this._EOLNormalized = this._EOLNormalized && eolNormalized;

		if (this.root !== SENTINEL) {
			let { node, remainder, nodeStartOffset } = this.nodeAt(offset);
			let piece = node.piece;
			let bufferIndex = piece.bufferIndex;
			let insertPosInBuffer = this.positionInBuffer(node, remainder);
			if (node.piece.bufferIndex === 0 &&
				piece.end.line === this._lastChangeBufferPos.line &&
				piece.end.column === this._lastChangeBufferPos.column &&
				(nodeStartOffset + piece.length === offset)
			) {
				// changed buffer
				this.appendToNode(node, value);
				this.computeBufferMetadata();
				return;
			}

			if (nodeStartOffset === offset) {
				this.insertContentToNodeLeft(value, node);
				this._searchCache.valdiate(offset);
			} else if (nodeStartOffset + node.piece.length > offset) {
				// we are inserting into the middle of a node.
				let nodesToDel = [];
				let newRightPiece = new Piece(
					piece.bufferIndex,
					insertPosInBuffer,
					piece.end,
					this.getLineFeedCnt(piece.bufferIndex, insertPosInBuffer, piece.end),
					this.offsetInBuffer(bufferIndex, piece.end) - this.offsetInBuffer(bufferIndex, insertPosInBuffer)
				);

				if (this.shouldCheckCRLF() && this.endWithCR(value)) {
					let headOfRight = this.nodeCharCodeAt(node, remainder);

					if (headOfRight === 10 /** \n */) {
						let newStart: BufferCursor = { line: newRightPiece.start.line + 1, column: 0 };
						newRightPiece.start = newStart;
						newRightPiece.length -= 1;
						newRightPiece.lineFeedCnt = this.getLineFeedCnt(newRightPiece.bufferIndex, newRightPiece.start, newRightPiece.end);
						value += '\n';
					}
				}

				// reuse node for content before insertion point.
				if (this.shouldCheckCRLF() && this.startWithLF(value)) {
					let tailOfLeft = this.nodeCharCodeAt(node, remainder - 1);
					if (tailOfLeft === 13 /** \r */) {
						let previousPos = this.positionInBuffer(node, remainder - 1);
						this.deleteNodeTail(node, previousPos);
						value = '\r' + value;

						if (node.piece.length === 0) {
							nodesToDel.push(node);
						}
					} else {
						this.deleteNodeTail(node, insertPosInBuffer);
					}
				} else {
					this.deleteNodeTail(node, insertPosInBuffer);
				}

				let newPiece = this.createNewPiece(value);
				if (newRightPiece.length > 0) {
					this.rbInsertRight(node, newRightPiece);
				}
				this.rbInsertRight(node, newPiece);
				this.deleteNodes(nodesToDel);
			} else {
				this.insertContentToNodeRight(value, node);
			}
		} else {
			// insert new node
			let piece = this.createNewPiece(value);
			this.rbInsertLeft(null, piece);
		}

		// todo, this is too brutal. Total line feed count should be updated the same way as lf_left.
		this.computeBufferMetadata();
	}

	delete(offset: number, cnt: number): void {
		if (cnt <= 0 || this.root === SENTINEL) {
			return;
		}

		let startPosition = this.nodeAt(offset);
		let endPosition = this.nodeAt(offset + cnt);
		let startNode = startPosition.node;
		let endNode = endPosition.node;

		if (startNode === endNode) {
			let startSplitPosInBuffer = this.positionInBuffer(startNode, startPosition.remainder);
			let endSplitPosInBuffer = this.positionInBuffer(startNode, endPosition.remainder);

			if (startPosition.nodeStartOffset === offset) {
				if (cnt === startNode.piece.length) { // delete node
					let next = startNode.next();
					rbDelete(this, startNode);
					this.validateCRLFWithPrevNode(next);
					this.computeBufferMetadata();
					return;
				}
				this.deleteNodeHead(startNode, endSplitPosInBuffer);
				this._searchCache.valdiate(offset);
				this.validateCRLFWithPrevNode(startNode);
				this.computeBufferMetadata();
				return;
			}

			if (startPosition.nodeStartOffset + startNode.piece.length === offset + cnt) {
				this.deleteNodeTail(startNode, startSplitPosInBuffer);
				this.validateCRLFWithNextNode(startNode);
				this.computeBufferMetadata();
				return;
			}

			// delete content in the middle, this node will be splitted to nodes
			this.shrinkNode(startNode, startSplitPosInBuffer, endSplitPosInBuffer);
			this.computeBufferMetadata();
			return;
		}

		let nodesToDel = [];

		let startSplitPosInBuffer = this.positionInBuffer(startNode, startPosition.remainder);
		this.deleteNodeTail(startNode, startSplitPosInBuffer);
		this._searchCache.valdiate(offset);
		if (startNode.piece.length === 0) {
			nodesToDel.push(startNode);
		}

		// update last touched node
		let endSplitPosInBuffer = this.positionInBuffer(endNode, endPosition.remainder);
		this.deleteNodeHead(endNode, endSplitPosInBuffer);
		if (endNode.piece.length === 0) {
			nodesToDel.push(endNode);
		}

		// delete nodes in between
		let secondNode = startNode.next();
		for (let node = secondNode; node !== SENTINEL && node !== endNode; node = node.next()) {
			nodesToDel.push(node);
		}

		let prev = startNode.piece.length === 0 ? startNode.prev() : startNode;
		this.deleteNodes(nodesToDel);
		this.validateCRLFWithNextNode(prev);
		this.computeBufferMetadata();
	}

	insertContentToNodeLeft(value: string, node: TreeNode) {
		// we are inserting content to the beginning of node
		let nodesToDel = [];
		if (this.shouldCheckCRLF() && this.endWithCR(value) && this.startWithLF(node)) {
			// move `\n` to new node.

			let piece = node.piece;
			let newStart: BufferCursor = { line: piece.start.line + 1, column: 0 };
			piece.start = newStart;
			piece.lineFeedCnt = this.getLineFeedCnt(piece.bufferIndex, piece.start, piece.end);
			piece.length -= 1;

			value += '\n';
			updateTreeMetadata(this, node, -1, -1);

			if (node.piece.length === 0) {
				nodesToDel.push(node);
			}
		}

		let newPiece = this.createNewPiece(value);
		let newNode = this.rbInsertLeft(node, newPiece);
		this.validateCRLFWithPrevNode(newNode);
		this.deleteNodes(nodesToDel);
	}

	insertContentToNodeRight(value: string, node: TreeNode) {
		// we are inserting to the right of this node.
		if (this.adjustCarriageReturnFromNext(value, node)) {
			// move \n to the new node.
			value += '\n';
		}

		let newPiece = this.createNewPiece(value);
		let newNode = this.rbInsertRight(node, newPiece);
		this.validateCRLFWithPrevNode(newNode);
	}

	positionInBuffer(node: TreeNode, remainder: number): BufferCursor {
		let piece = node.piece;
		let bufferIndex = node.piece.bufferIndex;
		let lineStarts = this._buffers[bufferIndex].lineStarts;

		let startOffset = lineStarts[piece.start.line] + piece.start.column;

		let offset = startOffset + remainder;

		// binary search offset between startOffset and endOffset
		let low = piece.start.line;
		let high = piece.end.line;

		let mid: number;
		let midStop: number;
		let midStart: number;

		while (low <= high) {
			mid = low + ((high - low) / 2) | 0;
			midStart = lineStarts[mid];

			if (mid === high) {
				break;
			}

			midStop = lineStarts[mid + 1];

			if (offset < midStart) {
				high = mid - 1;
			} else if (offset >= midStop) {
				low = mid + 1;
			} else {
				break;
			}
		}

		return {
			line: mid,
			column: offset - midStart
		};
	}

	getLineFeedCnt(bufferIndex: number, start: BufferCursor, end: BufferCursor): number {
		// we don't need to worry about start: abc\r|\n, or abc|\r, or abc|\n, or abc|\r\n doesn't change the fact that, there is one line break after start.
		// now let's take care of end: abc\r|\n, if end is in between \r and \n, we need to add line feed count by 1
		if (end.column === 0) {
			return end.line - start.line;
		}

		let lineStarts = this._buffers[bufferIndex].lineStarts;
		if (end.line === lineStarts.length - 1) { // it means, there is no \n after end, otherwise, there will be one more lineStart.
			return end.line - start.line;
		}

		let nextLineStartOffset = lineStarts[end.line + 1];
		let endOffset = lineStarts[end.line] + end.column;
		if (nextLineStartOffset > endOffset + 1) { // there are more than 1 character after end, which means it can't be \n
			return end.line - start.line;
		}
		// endOffset + 1 === nextLineStartOffset
		// character at endOffset is \n, so we check the character before first
		// if character at endOffset is \r, end.column is 0 and we can't get here.
		let previousCharOffset = endOffset - 1; // end.column > 0 so it's okay.
		let buffer = this._buffers[bufferIndex].buffer;

		if (buffer.charCodeAt(previousCharOffset) === 13) {
			return end.line - start.line + 1;
		} else {
			return end.line - start.line;
		}
	}

	offsetInBuffer(bufferIndex: number, cursor: BufferCursor): number {
		let lineStarts = this._buffers[bufferIndex].lineStarts;
		return lineStarts[cursor.line] + cursor.column;
	}

	deleteNodes(nodes: TreeNode[]): void {
		for (let i = 0; i < nodes.length; i++) {
			rbDelete(this, nodes[i]);
		}
	}

	createNewPiece(text: string): Piece {
		let startOffset = this._buffers[0].buffer.length;
		const lineStarts = createLineStartsFast(text, false);

		let start = this._lastChangeBufferPos;
		if (this._buffers[0].lineStarts[this._buffers[0].lineStarts.length - 1] === startOffset
			&& startOffset !== 0
			&& this.startWithLF(text)
			&& this.endWithCR(this._buffers[0].buffer) // todo, we can check this._lastChangeBufferPos's column as it's the last one
		) {
			this._lastChangeBufferPos = { line: this._lastChangeBufferPos.line, column: this._lastChangeBufferPos.column + 1 };
			start = this._lastChangeBufferPos;

			for (let i = 0; i < lineStarts.length; i++) {
				lineStarts[i] += startOffset + 1;
			}

			this._buffers[0].lineStarts = (<number[]>this._buffers[0].lineStarts).concat(<number[]>lineStarts.slice(1));
			this._buffers[0].buffer += '_' + text;
			startOffset += 1;
		} else {
			if (startOffset !== 0) {
				for (let i = 0; i < lineStarts.length; i++) {
					lineStarts[i] += startOffset;
				}
			}
			this._buffers[0].lineStarts = (<number[]>this._buffers[0].lineStarts).concat(<number[]>lineStarts.slice(1));
			this._buffers[0].buffer += text;
		}

		const endOffset = this._buffers[0].buffer.length;
		let endIndex = this._buffers[0].lineStarts.length - 1;
		let endColumn = endOffset - this._buffers[0].lineStarts[endIndex];
		let endPos = { line: endIndex, column: endColumn };
		let newPiece = new Piece(
			0,
			start,
			endPos,
			this.getLineFeedCnt(0, start, endPos),
			endOffset - startOffset
		);
		this._lastChangeBufferPos = endPos;
		return newPiece;
	}

	getLinesRawContent(): string {
		return this.getContentOfSubTree(this.root);
	}

	getLineRawContent(lineNumber: number, endOffset: number = 0): string {
		let x = this.root;

		let ret = '';
		let cache = this._searchCache.get2(lineNumber);
		if (cache) {
			x = cache.node;
			let prevAccumualtedValue = this.getAccumulatedValue(x, lineNumber - cache.nodeStartLineNumber - 1);
			let buffer = this._buffers[x.piece.bufferIndex].buffer;
			let startOffset = this.offsetInBuffer(x.piece.bufferIndex, x.piece.start);
			if (cache.nodeStartLineNumber + x.piece.lineFeedCnt === lineNumber) {
				ret = buffer.substring(startOffset + prevAccumualtedValue, startOffset + x.piece.length);
			} else {
				let accumualtedValue = this.getAccumulatedValue(x, lineNumber - cache.nodeStartLineNumber);
				return buffer.substring(startOffset + prevAccumualtedValue, startOffset + accumualtedValue - endOffset);
			}
		} else {
			let nodeStartOffset = 0;
			const originalLineNumber = lineNumber;
			while (x !== SENTINEL) {
				if (x.left !== SENTINEL && x.lf_left >= lineNumber - 1) {
					x = x.left;
				} else if (x.lf_left + x.piece.lineFeedCnt > lineNumber - 1) {
					let prevAccumualtedValue = this.getAccumulatedValue(x, lineNumber - x.lf_left - 2);
					let accumualtedValue = this.getAccumulatedValue(x, lineNumber - x.lf_left - 1);
					let buffer = this._buffers[x.piece.bufferIndex].buffer;
					let startOffset = this.offsetInBuffer(x.piece.bufferIndex, x.piece.start);
					nodeStartOffset += x.size_left;
					this._searchCache.set({
						node: x,
						nodeStartOffset,
						nodeStartLineNumber: originalLineNumber - (lineNumber - 1 - x.lf_left)
					});

					return buffer.substring(startOffset + prevAccumualtedValue, startOffset + accumualtedValue - endOffset);
				} else if (x.lf_left + x.piece.lineFeedCnt === lineNumber - 1) {
					let prevAccumualtedValue = this.getAccumulatedValue(x, lineNumber - x.lf_left - 2);
					let buffer = this._buffers[x.piece.bufferIndex].buffer;
					let startOffset = this.offsetInBuffer(x.piece.bufferIndex, x.piece.start);

					ret = buffer.substring(startOffset + prevAccumualtedValue, startOffset + x.piece.length);
					break;
				} else {
					lineNumber -= x.lf_left + x.piece.lineFeedCnt;
					nodeStartOffset += x.size_left + x.piece.length;
					x = x.right;
				}
			}
		}

		// search in order, to find the node contains end column
		x = x.next();
		while (x !== SENTINEL) {
			let buffer = this._buffers[x.piece.bufferIndex].buffer;

			if (x.piece.lineFeedCnt > 0) {
				let accumualtedValue = this.getAccumulatedValue(x, 0);
				let startOffset = this.offsetInBuffer(x.piece.bufferIndex, x.piece.start);

				ret += buffer.substring(startOffset, startOffset + accumualtedValue - endOffset);
				return ret;
			} else {
				let startOffset = this.offsetInBuffer(x.piece.bufferIndex, x.piece.start);
				ret += buffer.substr(startOffset, x.piece.length);
			}

			x = x.next();
		}

		return ret;
	}

	computeBufferMetadata() {
		let x = this.root;

		let lfCnt = 1;
		let len = 0;

		while (x !== SENTINEL) {
			lfCnt += x.lf_left + x.piece.lineFeedCnt;
			len += x.size_left + x.piece.length;
			x = x.right;
		}

		this._lineCnt = lfCnt;
		this._length = len;
		this._searchCache.valdiate(this._length);
	}

	// #region node operations
	getIndexOf(node: TreeNode, accumulatedValue: number): { index: number, remainder: number } {
		let piece = node.piece;
		let pos = this.positionInBuffer(node, accumulatedValue);
		let lineCnt = pos.line - piece.start.line;

		if (this.offsetInBuffer(piece.bufferIndex, piece.end) - this.offsetInBuffer(piece.bufferIndex, piece.start) === accumulatedValue) {
			// we are checking the end of this node, so a CRLF check is necessary.
			let realLineCnt = this.getLineFeedCnt(node.piece.bufferIndex, piece.start, pos);
			if (realLineCnt !== lineCnt) {
				// aha yes, CRLF
				return { index: realLineCnt, remainder: 0 };
			}
		}

		return { index: lineCnt, remainder: pos.column };
	}

	getAccumulatedValue(node: TreeNode, index: number) {
		if (index < 0) {
			return 0;
		}
		let piece = node.piece;
		let lineStarts = this._buffers[piece.bufferIndex].lineStarts;
		let expectedLineStartIndex = piece.start.line + index + 1;
		if (expectedLineStartIndex > piece.end.line) {
			return lineStarts[piece.end.line] + piece.end.column - lineStarts[piece.start.line] - piece.start.column;
		} else {
			return lineStarts[expectedLineStartIndex] - lineStarts[piece.start.line] - piece.start.column;
		}
	}

	deleteNodeTail(node: TreeNode, pos: BufferCursor) {
		let piece = node.piece;
		let originalLFCnt = piece.lineFeedCnt;
		let originalEndOffset = this.offsetInBuffer(piece.bufferIndex, piece.end);
		piece.end = pos;
		let newEndOffset = this.offsetInBuffer(piece.bufferIndex, piece.end);
		piece.lineFeedCnt = this.getLineFeedCnt(piece.bufferIndex, piece.start, piece.end);
		let lf_delta = piece.lineFeedCnt - originalLFCnt;
		let size_delta = newEndOffset - originalEndOffset;
		piece.length += size_delta;
		updateTreeMetadata(this, node, size_delta, lf_delta);
	}

	deleteNodeHead(node: TreeNode, pos: BufferCursor) {
		let piece = node.piece;
		let originalLFCnt = piece.lineFeedCnt;
		let originalStartOffset = this.offsetInBuffer(piece.bufferIndex, piece.start);

		piece.start = pos;
		piece.lineFeedCnt = this.getLineFeedCnt(piece.bufferIndex, piece.start, piece.end);
		let newStartOffset = this.offsetInBuffer(piece.bufferIndex, piece.start);
		let lf_delta = piece.lineFeedCnt - originalLFCnt;
		let size_delta = originalStartOffset - newStartOffset;
		piece.length += size_delta;
		updateTreeMetadata(this, node, size_delta, lf_delta);
	}

	shrinkNode(node: TreeNode, start: BufferCursor, end: BufferCursor) {
		let piece = node.piece;
		let originalStartPos = piece.start;
		let originalEndPos = piece.end;

		// old piece, originalStartPos, start
		let oldLength = piece.length;
		let oldLFCnt = piece.lineFeedCnt;
		piece.end = start;
		piece.lineFeedCnt = this.getLineFeedCnt(piece.bufferIndex, piece.start, piece.end);
		let newLength = this.offsetInBuffer(piece.bufferIndex, start) - this.offsetInBuffer(piece.bufferIndex, originalStartPos);
		let newLFCnt = piece.lineFeedCnt;
		piece.length = newLength;
		updateTreeMetadata(this, node, newLength - oldLength, newLFCnt - oldLFCnt);

		// new right piece, end, originalEndPos
		let newPiece = new Piece(
			piece.bufferIndex,
			end,
			originalEndPos,
			this.getLineFeedCnt(piece.bufferIndex, end, originalEndPos),
			this.offsetInBuffer(piece.bufferIndex, originalEndPos) - this.offsetInBuffer(piece.bufferIndex, end)
		);

		let newNode = this.rbInsertRight(node, newPiece);
		this.validateCRLFWithPrevNode(newNode);
	}

	appendToNode(node: TreeNode, value: string): void {
		if (this.adjustCarriageReturnFromNext(value, node)) {
			value += '\n';
		}

		let hitCRLF = this.shouldCheckCRLF() && this.startWithLF(value) && this.endWithCR(node);
		const startOffset = this._buffers[0].buffer.length;
		this._buffers[0].buffer += value;
		const lineStarts = createLineStartsFast(value, false);
		for (let i = 0; i < lineStarts.length; i++) {
			lineStarts[i] += startOffset;
		}
		if (hitCRLF) {
			let prevStartOffset = this._buffers[0].lineStarts[this._buffers[0].lineStarts.length - 2];
			(<number[]>this._buffers[0].lineStarts).pop();
			// _lastChangeBufferPos is already wrong
			this._lastChangeBufferPos = { line: this._lastChangeBufferPos.line - 1, column: startOffset - prevStartOffset };
		}

		this._buffers[0].lineStarts = (<number[]>this._buffers[0].lineStarts).concat(<number[]>lineStarts.slice(1));
		let endIndex = this._buffers[0].lineStarts.length - 1;
		let endColumn = this._buffers[0].buffer.length - this._buffers[0].lineStarts[endIndex];
		let endPos = { line: endIndex, column: endColumn };
		node.piece.end = endPos;
		node.piece.length += value.length;
		let oldLineFeedCnt = node.piece.lineFeedCnt;
		let newLineFeedCnt = this.getLineFeedCnt(0, node.piece.start, endPos);
		node.piece.lineFeedCnt = newLineFeedCnt;
		let lf_delta = newLineFeedCnt - oldLineFeedCnt;
		this._lastChangeBufferPos = endPos;
		updateTreeMetadata(this, node, value.length, lf_delta);
	}

	nodeAt(offset: number): NodePosition {
		let x = this.root;
		let cache = this._searchCache.get(offset);
		if (cache) {
			return {
				node: cache.node,
				nodeStartOffset: cache.nodeStartOffset,
				remainder: offset - cache.nodeStartOffset
			};
		}

		let nodeStartOffset = 0;

		while (x !== SENTINEL) {
			if (x.size_left > offset) {
				x = x.left;
			} else if (x.size_left + x.piece.length >= offset) {
				nodeStartOffset += x.size_left;
				let ret = {
					node: x,
					remainder: offset - x.size_left,
					nodeStartOffset
				};
				this._searchCache.set(ret);
				return ret;
			} else {
				offset -= x.size_left + x.piece.length;
				nodeStartOffset += x.size_left + x.piece.length;
				x = x.right;
			}
		}

		return null;
	}

	nodeAt2(lineNumber: number, column: number): NodePosition {
		let x = this.root;
		let nodeStartOffset = 0;

		while (x !== SENTINEL) {
			if (x.left !== SENTINEL && x.lf_left >= lineNumber - 1) {
				x = x.left;
			} else if (x.lf_left + x.piece.lineFeedCnt > lineNumber - 1) {
				let prevAccumualtedValue = this.getAccumulatedValue(x, lineNumber - x.lf_left - 2);
				let accumualtedValue = this.getAccumulatedValue(x, lineNumber - x.lf_left - 1);
				nodeStartOffset += x.size_left;

				return {
					node: x,
					remainder: Math.min(prevAccumualtedValue + column - 1, accumualtedValue),
					nodeStartOffset
				};
			} else if (x.lf_left + x.piece.lineFeedCnt === lineNumber - 1) {
				let prevAccumualtedValue = this.getAccumulatedValue(x, lineNumber - x.lf_left - 2);
				if (prevAccumualtedValue + column - 1 <= x.piece.length) {
					return {
						node: x,
						remainder: prevAccumualtedValue + column - 1,
						nodeStartOffset
					};
				} else {
					column -= x.piece.length - prevAccumualtedValue;
					break;
				}
			} else {
				lineNumber -= x.lf_left + x.piece.lineFeedCnt;
				nodeStartOffset += x.size_left + x.piece.length;
				x = x.right;
			}
		}

		// search in order, to find the node contains position.column
		x = x.next();
		while (x !== SENTINEL) {

			if (x.piece.lineFeedCnt > 0) {
				let accumualtedValue = this.getAccumulatedValue(x, 0);
				let nodeStartOffset = this.offsetOfNode(x);
				return {
					node: x,
					remainder: Math.min(column - 1, accumualtedValue),
					nodeStartOffset
				};
			} else {
				if (x.piece.length >= column - 1) {
					let nodeStartOffset = this.offsetOfNode(x);
					return {
						node: x,
						remainder: column - 1,
						nodeStartOffset
					};
				} else {
					column -= x.piece.length;
				}
			}

			x = x.next();
		}

		return null;
	}

	nodeCharCodeAt(node: TreeNode, offset: number): number {
		if (node.piece.lineFeedCnt < 1) {
			return -1;
		}
		let buffer = this._buffers[node.piece.bufferIndex];
		let newOffset = this.offsetInBuffer(node.piece.bufferIndex, node.piece.start) + offset;
		return buffer.buffer.charCodeAt(newOffset);
	}

	offsetOfNode(node: TreeNode): number {
		if (!node) {
			return 0;
		}
		let pos = node.size_left;
		while (node !== this.root) {
			if (node.parent.right === node) {
				pos += node.parent.size_left + node.parent.piece.length;
			}

			node = node.parent;
		}

		return pos;
	}

	// #endregion

	// #region CRLF
	shouldCheckCRLF() {
		return !(this._EOLNormalized && this._EOL === '\n');
	}

	startWithLF(val: string | TreeNode): boolean {
		if (typeof val === 'string') {
			return val.charCodeAt(0) === 10;
		}

		if (val === SENTINEL || val.piece.lineFeedCnt === 0) {
			return false;
		}

		let piece = val.piece;
		let lineStarts = this._buffers[piece.bufferIndex].lineStarts;
		let line = piece.start.line;
		let startOffset = lineStarts[line] + piece.start.column;
		if (line === lineStarts.length - 1) {
			// last line, so there is no line feed at the end of this line
			return false;
		}
		let nextLineOffset = lineStarts[line + 1];
		if (nextLineOffset > startOffset + 1) {
			return false;
		}
		return this._buffers[piece.bufferIndex].buffer.charCodeAt(startOffset) === 10;
	}

	endWithCR(val: string | TreeNode): boolean {
		if (typeof val === 'string') {
			return val.charCodeAt(val.length - 1) === 13;
		}

		if (val === SENTINEL || val.piece.lineFeedCnt === 0) {
			return false;
		}

		return this.nodeCharCodeAt(val, val.piece.length - 1) === 13;
	}

	validateCRLFWithPrevNode(nextNode: TreeNode) {
		if (this.shouldCheckCRLF() && this.startWithLF(nextNode)) {
			let node = nextNode.prev();
			if (this.endWithCR(node)) {
				this.fixCRLF(node, nextNode);
			}
		}
	}

	validateCRLFWithNextNode(node: TreeNode) {
		if (this.shouldCheckCRLF() && this.endWithCR(node)) {
			let nextNode = node.next();
			if (this.startWithLF(nextNode)) {
				this.fixCRLF(node, nextNode);
			}
		}
	}

	fixCRLF(prev: TreeNode, next: TreeNode) {
		let nodesToDel = [];
		// update node
		let lineStarts = this._buffers[prev.piece.bufferIndex].lineStarts;
		if (prev.piece.end.column === 0) {
			// it means, last line ends with \r, not \r\n
			let newEnd: BufferCursor = { line: prev.piece.end.line - 1, column: lineStarts[prev.piece.end.line] - lineStarts[prev.piece.end.line - 1] - 1 };
			prev.piece.end = newEnd;
		} else {
			// \r\n
			let newEnd: BufferCursor = { line: prev.piece.end.line, column: prev.piece.end.column - 1 };
			prev.piece.end = newEnd;
		}

		prev.piece.length -= 1;
		prev.piece.lineFeedCnt -= 1;

		updateTreeMetadata(this, prev, - 1, -1);
		if (prev.piece.length === 0) {
			nodesToDel.push(prev);
		}

		// update nextNode
		let newStart: BufferCursor = { line: next.piece.start.line + 1, column: 0 };
		next.piece.start = newStart;
		next.piece.length -= 1;
		next.piece.lineFeedCnt = this.getLineFeedCnt(next.piece.bufferIndex, next.piece.start, next.piece.end);
		// }

		updateTreeMetadata(this, next, - 1, -1);
		if (next.piece.length === 0) {
			nodesToDel.push(next);
		}

		// create new piece which contains \r\n
		let piece = this.createNewPiece('\r\n');
		this.rbInsertRight(prev, piece);
		// delete empty nodes

		for (let i = 0; i < nodesToDel.length; i++) {
			rbDelete(this, nodesToDel[i]);
		}
	}

	adjustCarriageReturnFromNext(value: string, node: TreeNode): boolean {
		if (this.shouldCheckCRLF() && this.endWithCR(value)) {
			let nextNode = node.next();
			if (this.startWithLF(nextNode)) {
				// move `\n` forward
				value += '\n';

				if (nextNode.piece.length === 1) {
					rbDelete(this, nextNode);
				} else {

					let piece = nextNode.piece;
					let newStart: BufferCursor = { line: piece.start.line + 1, column: 0 };
					piece.start = newStart;
					piece.length -= 1;
					piece.lineFeedCnt = this.getLineFeedCnt(piece.bufferIndex, piece.start, piece.end);
					updateTreeMetadata(this, nextNode, -1, -1);
				}
				return true;
			}
		}

		return false;
	}

	// #endregion

	// #endregion

	// #region Tree operations
	iterate(node: TreeNode, callback: (node: TreeNode) => boolean): boolean {
		if (node === SENTINEL) {
			return callback(SENTINEL);
		}

		let leftRet = this.iterate(node.left, callback);
		if (!leftRet) {
			return leftRet;
		}

		return callback(node) && this.iterate(node.right, callback);
	}

	getNodeContent(node: TreeNode) {
		if (node === SENTINEL) {
			return '';
		}
		let buffer = this._buffers[node.piece.bufferIndex];
		let currentContent;
		let piece = node.piece;
		let startOffset = this.offsetInBuffer(piece.bufferIndex, piece.start);
		let endOffset = this.offsetInBuffer(piece.bufferIndex, piece.end);
		currentContent = buffer.buffer.substring(startOffset, endOffset);
		return currentContent;
	}

	/**
	 *      node              node
	 *     /  \              /  \
	 *    a   b    <----   a    b
	 *                         /
	 *                        z
	 */
	rbInsertRight(node: TreeNode, p: Piece): TreeNode {
		let z = new TreeNode(p, NodeColor.Red);
		z.left = SENTINEL;
		z.right = SENTINEL;
		z.parent = SENTINEL;
		z.size_left = 0;
		z.lf_left = 0;

		let x = this.root;
		if (x === SENTINEL) {
			this.root = z;
			z.color = NodeColor.Black;
		} else if (node.right === SENTINEL) {
			node.right = z;
			z.parent = node;
		} else {
			let nextNode = leftest(node.right);
			nextNode.left = z;
			z.parent = nextNode;
		}

		fixInsert(this, z);
		return z;
	}

	/**
	 *      node              node
	 *     /  \              /  \
	 *    a   b     ---->   a    b
	 *                       \
	 *                        z
	 */
	rbInsertLeft(node: TreeNode, p: Piece): TreeNode {
		let z = new TreeNode(p, NodeColor.Red);
		z.left = SENTINEL;
		z.right = SENTINEL;
		z.parent = SENTINEL;
		z.size_left = 0;
		z.lf_left = 0;

		let x = this.root;
		if (x === SENTINEL) {
			this.root = z;
			z.color = NodeColor.Black;
		} else if (node.left === SENTINEL) {
			node.left = z;
			z.parent = node;
		} else {
			let prevNode = righttest(node.left); // a
			prevNode.right = z;
			z.parent = prevNode;
		}

		fixInsert(this, z);
		return z;
	}

	getContentOfSubTree(node: TreeNode): string {
		let str = '';

		this.iterate(node, node => {
			str += this.getNodeContent(node);
			return true;
		});

		return str;
	}
	// #endregion
}
