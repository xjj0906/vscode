/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { assign } from 'vs/base/common/objects';
import { ILocalExtension } from 'vs/platform/extensionManagement/common/extensionManagement';
import { IssueType, ISettingSearchResult } from 'vs/platform/issue/common/issue';

export interface IssueReporterData {
	issueType?: IssueType;
	issueDescription?: string;

	versionInfo?: any;
	systemInfo?: any;
	processInfo?: any;
	workspaceInfo?: any;

	includeSystemInfo?: boolean;
	includeWorkspaceInfo?: boolean;
	includeProcessInfo?: boolean;
	includeExtensions?: boolean;
	includeSearchedExtensions?: boolean;
	includeSettingsSearchDetails?: boolean;

	numberOfThemeExtesions?: number;
	enabledNonThemeExtesions?: ILocalExtension[];
	extensionsDisabled?: boolean;
	reprosWithoutExtensions?: boolean;
	actualSearchResults?: ISettingSearchResult[];
	query?: string;
	filterResultCount?: number;
}

export class IssueReporterModel {
	private _data: IssueReporterData;

	constructor(initialData?: IssueReporterData) {
		const defaultData = {
			includeSystemInfo: true,
			includeWorkspaceInfo: true,
			includeProcessInfo: true,
			includeExtensions: true,
			includeSearchedExtensions: true,
			includeSettingsSearchDetails: true,
			reprosWithoutExtensions: false
		};

		this._data = initialData ? assign(defaultData, initialData) : defaultData;
	}

	getData(): IssueReporterData {
		return this._data;
	}

	update(newData: IssueReporterData): void {
		assign(this._data, newData);
	}

	serialize(): string {
		return `
### Issue Type
${this.getIssueTypeTitle()}

### Description

${this._data.issueDescription}

### VS Code Info

VS Code version: ${this._data.versionInfo && this._data.versionInfo.vscodeVersion}
OS version: ${this._data.versionInfo && this._data.versionInfo.os}

${this.getInfos()}`;
	}

	private getIssueTypeTitle(): string {
		if (this._data.issueType === IssueType.Bug) {
			return 'Bug';
		} else if (this._data.issueType === IssueType.PerformanceIssue) {
			return 'Performance Issue';
		} else if (this._data.issueType === IssueType.SettingsSearchIssue) {
			return 'Settings Search Issue';
		} else {
			return 'Feature Request';
		}
	}

	private getInfos(): string {
		let info = '';

		if (this._data.issueType === IssueType.Bug || this._data.issueType === IssueType.PerformanceIssue) {
			if (this._data.includeSystemInfo) {
				info += this.generateSystemInfoMd();
			}
		}

		if (this._data.issueType === IssueType.PerformanceIssue) {

			if (this._data.includeProcessInfo) {
				info += this.generateProcessInfoMd();
			}

			if (this._data.includeWorkspaceInfo) {
				info += this.generateWorkspaceInfoMd();
			}
		}

		if (this._data.issueType === IssueType.Bug || this._data.issueType === IssueType.PerformanceIssue) {
			if (this._data.includeExtensions) {
				info += this.generateExtensionsMd();
			}

			info += this._data.reprosWithoutExtensions ? '\nReproduces without extensions' : '\nReproduces only with extensions';
		}

		if (this._data.issueType === IssueType.SettingsSearchIssue) {
			if (this._data.includeSearchedExtensions) {
				info += this.generateExtensionsMd();
			}

			if (this._data.includeSettingsSearchDetails) {
				info += this.generateSettingSearchResultsMd();
				info += '\n' + this.generateSettingsSearchResultDetailsMd();
			}
		}

		return info;
	}

	private generateSystemInfoMd(): string {
		let md = `<details>
<summary>System Info</summary>

|Item|Value|
|---|---|
`;

		Object.keys(this._data.systemInfo).forEach(k => {
			md += `|${k}|${this._data.systemInfo[k]}|\n`;
		});

		md += '\n</details>';

		return md;
	}

	private generateProcessInfoMd(): string {
		let md = `<details>
<summary>Process Info</summary>

|pid|CPU|Memory (MB)|Name|
|---|---|---|---|
`;

		this._data.processInfo.forEach(p => {
			md += `|${p.pid}|${p.cpu}|${p.memory}|${p.name}|\n`;
		});

		md += '\n</details>';

		return md;
	}

	private generateWorkspaceInfoMd(): string {
		return `<details>
<summary>Workspace Info</summary>

\`\`\`
${this._data.workspaceInfo};
\`\`\`

</details>
`;
	}

	private generateExtensionsMd(): string {
		if (this._data.extensionsDisabled) {
			return 'Extensions disabled';
		}

		const themeExclusionStr = this._data.numberOfThemeExtesions ? `\n(${this._data.numberOfThemeExtesions} theme extensions excluded)` : '';

		if (!this._data.enabledNonThemeExtesions) {
			return 'Extensions: none' + themeExclusionStr;
		}

		let tableHeader = `Extension|Author (truncated)|Version
---|---|---`;
		const table = this._data.enabledNonThemeExtesions.map(e => {
			return `${e.manifest.name}|${e.manifest.publisher.substr(0, 3)}|${e.manifest.version}`;
		}).join('\n');

		return `<details><summary>Extensions (${this._data.enabledNonThemeExtesions.length})</summary>

${tableHeader}
${table}
${themeExclusionStr}

</details>`;
	}

	private generateSettingsSearchResultDetailsMd(): string {
		return `
Query: ${this._data.query}
Literal matches: ${this._data.filterResultCount}`;
	}

	private generateSettingSearchResultsMd(): string {
		if (!this._data.actualSearchResults) {
			return '';
		}

		if (!this._data.actualSearchResults.length) {
			return `No fuzzy results`;
		}

		let tableHeader = `Setting|Extension|Score
---|---|---`;
		const table = this._data.actualSearchResults.map(setting => {
			return `${setting.key}|${setting.extensionId}|${String(setting.score).slice(0, 5)}`;
		}).join('\n');

		return `<details><summary>Results</summary>

${tableHeader}
${table}

</details>`;
	}
}