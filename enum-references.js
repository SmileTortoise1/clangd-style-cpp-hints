'use strict';

const { indexSource, enumGroups } = require('./source');

function indexedEnums(index) {
    return index.enumGroups ??= enumGroups(index.tokens);
}

function quotedIncludes(tokens) {
    return tokens.filter(token => token.directive)
        .map(token => /^\s*#\s*include\s*"([^"\r\n]+)"/.exec(token.value)?.[1]).filter(Boolean);
}

async function includedEnumNames(vscode, document, includes, openDocument, find) {
    const names = new Set();
    if (!vscode.Uri?.joinPath || !vscode.workspace.openTextDocument) { return names; }
    const visited = new Set([document.uri.toString()]);
    let remaining = 48;
    let pending = includes.map(header => vscode.Uri.joinPath(document.uri, '..', header.replace(/\\/g, '/')));
    for (let depth = 0; depth < 3 && pending.length && remaining; depth++) {
        const layer = [];
        for (const uri of pending) {
            if (!remaining) { break; }
            const key = uri.toString();
            if (visited.has(key)) { continue; }
            visited.add(key);
            remaining--;
            layer.push(uri);
        }
        pending = [];
        // Explore each level in small batches, using only quoted project includes.
        for (let start = 0; start < layer.length; start += 8) {
            const headers = await Promise.all(layer.slice(start, start + 8).map(uri => openDocument(uri)));
            for (const header of headers.filter(Boolean)) {
                const contents = await find(header);
                if (!contents) { continue; }
                for (const group of indexedEnums(contents)) {
                    for (const member of group.members) { names.add(member.name); }
                }
                for (const next of quotedIncludes(contents.tokens)) {
                    pending.push(vscode.Uri.joinPath(header.uri, '..', next.replace(/\\/g, '/')));
                }
            }
        }
    }
    return names;
}

function indexHeader(header) {
    if (header.lineCount > 15000) { return undefined; }
    const text = header.getText();
    return text.length <= 1024 * 1024 ? { text, ...indexSource(text) } : undefined;
}

function membersNamed(index, name) {
    if (!index.enumMembersByName) {
        const members = new Map();
        for (const group of indexedEnums(index)) {
            for (const member of group.members) {
                const matches = members.get(member.name) ?? [];
                matches.push(member);
                members.set(member.name, matches);
            }
        }
        index.enumMembersByName = members;
    }
    return index.enumMembersByName.get(name) ?? [];
}

async function resolveEnumReference(document, position, name, query, find, openDocument) {
    for (const command of ['vscode.executeDefinitionProvider', 'vscode.executeDeclarationProvider']) {
        const targets = await query(command, document.uri, position);
        if (!targets?.length || targets.length > 4) { continue; }
        const matches = new Map();
        for (const target of targets) {
            const uri = target.targetUri ?? target.uri;
            const range = target.targetSelectionRange ?? target.range;
            if (!uri || !range?.start) { continue; }
            const sameFile = uri.toString() === document.uri.toString();
            const header = sameFile ? document : await openDocument(uri);
            const contents = header && await find(header);
            if (!contents) { continue; }
            const start = header.offsetAt(range.start);
            const end = range.end ? header.offsetAt(range.end) : start;
            const candidates = membersNamed(contents, name).filter(member => (
                member.offset === start || (member.offset >= start && member.offset < end) ||
                (Math.abs(member.offset - start) <= 200 && header.positionAt(member.offset).line === range.start.line)));
            if (candidates.length === 1) {
                const member = candidates[0];
                matches.set(uri.toString() + ':' + member.offset, member);
            }
        }
        if (matches.size === 1) { return matches.values().next().value; }
        if (matches.size > 1) { return undefined; }
    }
}

module.exports = { indexedEnums, quotedIncludes, includedEnumNames, indexHeader, resolveEnumReference };
