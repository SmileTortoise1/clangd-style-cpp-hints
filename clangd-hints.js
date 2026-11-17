'use strict';

const { ClangdClient, documentUri } = require('./clangd-client');
const { clangdCommand } = require('./clangd-config');
const { enumValue, parameterType } = require('./intellisense');
const { declarationModifier } = require('./enum-hints');

function nativeHint(item, options) {
    const text = typeof item.label === 'string' ? item.label : item.label?.map(part => part.value).join('') ?? '';
    const label = text.trim();
    if (!label || (options.suppressParameterHints && (item.kind === 2 || label.startsWith(',')))) { return undefined; }
    let hintKind;
    if (label.startsWith('[') && label.endsWith('=')) {
        if (!options.arrayIndices) { return undefined; }
        hintKind = 'index';
    } else if (label.startsWith('.') && label.endsWith('=')) {
        if (!options.structFields) { return undefined; }
        hintKind = 'field';
    } else if (item.kind === 2) {
        if (!options.parameterNames && !options.parameterTypes) { return undefined; }
    } else if (item.kind === 1) {
        if (!options.deducedTypes) { return undefined; }
    } else if (!label.startsWith(',') && !label.startsWith('//')) {
        return undefined;
    }
    return {
        position: item.position, label, kind: item.kind, hintKind,
        paddingLeft: item.paddingLeft ?? /^\s/.test(text),
        paddingRight: item.paddingRight ?? /\s$/.test(text)
    };
}

function hoverEnum(response, name) {
    const value = response?.contents?.value;
    if (typeof value === 'string') {
        const match = /^\s*(?:\*\*Value\*\*|Value)\s*(?::|=)?\s*\x60?([+-]?(?:0x[\da-f]+|\d+))\x60?\s*$/im.exec(value);
        if (match) { return match[1]; }
    }
    const contents = Array.isArray(response?.contents) ? response.contents : [response?.contents].filter(Boolean);
    return enumValue([{ contents }], name);
}

function enumPositions(legend, semantic, select) {
    const type = legend?.tokenTypes?.indexOf('enumMember') ?? -1;
    if (type < 0) { return []; }
    const declarations = declarationModifier(legend);
    const result = [];
    let line = 0;
    let character = 0;
    for (let i = 0; i < (semantic?.data?.length ?? 0); i += 5) {
        const [deltaLine, deltaCharacter, length, tokenType, modifiers] = semantic.data.slice(i, i + 5);
        line += deltaLine;
        character = deltaLine ? deltaCharacter : character + deltaCharacter;
        if (tokenType !== type) { continue; }
        const declaration = Boolean(modifiers & declarations);
        const position = { line, character };
        const candidate = select(position, length, declaration);
        if (candidate) { result.push({ position, length, declaration, candidate }); }
    }
    return result;
}

class ClangdHints {
    constructor(vscode, log, onStateChange = () => {}) {
        this.vscode = vscode;
        this.log = log;
        this.onStateChange = onStateChange;
        this.servers = new Map();
        this.configuration = new WeakMap();
        this.data = new WeakMap();
    }

    async open(document, cancellation) {
        const vscode = this.vscode;
        if (!vscode.workspace.isTrusted || document.uri.scheme !== 'file') { return undefined; }
        const settings = vscode.workspace.getConfiguration('clangdStyleCppHints', document);
        const clangd = vscode.workspace.getConfiguration('clangd', document);
        if (!settings.get('useClangd', true) || !clangd.get('enable', true)) { return undefined; }
        const official = vscode.extensions?.getExtension('llvm-vs-code-extensions.vscode-clangd');
        if (official) {
            const api = official.isActive ? official.exports : await official.activate();
            const client = api?.getApi?.(1)?.languageClient;
            if (client !== this.officialClient) {
                this.officialState?.dispose();
                this.officialClient = client;
                this.officialState = client?.onDidChangeState?.(this.onStateChange);
            }
            if (client?.isRunning?.() && !cancellation.isCancellationRequested) {
                return {
                    official: true,
                    capabilities: client.initializeResult?.capabilities,
                    request: (method, params) => this.officialRequest(client, method, params)
                };
            }
            return undefined;
        }
        const binaryPath = settings.get('clangdPath', '');
        const configured = settings.inspect?.('useClangd');
        if (!binaryPath && ![configured?.workspaceFolderValue, configured?.workspaceValue,
            configured?.globalValue].includes(true)) { return undefined; }
        const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
        const binary = (binaryPath || clangd.get('path', '') || 'clangd').trim();
        const flags = settings.get('clangdFallbackFlags', []);
        const configurationName = settings.get('clangdConfiguration', '');
        let config = this.configuration.get(document);
        if (!config) {
            config = folder ? clangdCommand(document.uri.fsPath, folder.fsPath, document.languageId, configurationName, flags)
                : Promise.resolve({});
            this.configuration.set(document, config);
        }
        const { command, ambiguous } = await config;
        if (ambiguous || cancellation.isCancellationRequested) { return undefined; }
        const key = JSON.stringify([folder?.toString(), binary, flags]);
        if (!this.servers.has(key)) {
            try {
                this.servers.set(key, new ClangdClient(binary, folder && {
                    uri: folder.toString(), fsPath: folder.fsPath, name: folder.path.split('/').pop()
                }, flags, this.log));
            } catch (error) {
                this.log(error.message);
                this.servers.set(key, null);
            }
        }
        const server = this.servers.get(key);
        if (!server || !await server.update(document, command)) { return undefined; }
        return server;
    }

    async officialRequest(client, method, params) {
        let timer;
        try {
            return await Promise.race([
                client.sendRequest(method, params),
                new Promise(resolve => { timer = setTimeout(resolve, 1800); })
            ]);
        } catch (error) {
            this.log('clangd ' + method + ': ' + error.message);
            return undefined;
        } finally {
            clearTimeout(timer);
        }
    }

    async hints(server, document, range, options, cancellation, enums) {
        if (cancellation.isCancellationRequested) { return undefined; }
        const vscode = this.vscode;
        const textDocument = { uri: documentUri(document) };
        const version = document.version;
        const position = value => ({ line: value.line, character: value.character });
        const request = { textDocument, range: { start: position(range.start), end: position(range.end) } };
        let data = this.data.get(document);
        if (data?.version !== version) {
            data = { version, enumValues: new Map(), signatures: new Map() };
            this.data.set(document, data);
        }
        const showEnums = options.enumValues || options.enumValueReferences;
        if (showEnums) {
            data.semantic ??= server.request('textDocument/semanticTokens/full', { textDocument });
        }
        const [native, semantic] = await Promise.all([
            server.request('textDocument/inlayHint', request),
            data.semantic
        ]);
        if (cancellation.isCancellationRequested || document.version !== version) {
            return undefined;
        }
        if (native === undefined && semantic === undefined) { return undefined; }
        // A missing AC5 header or an unusable command can invalidate clangd's
        // view of the active target. Fall back to the user's C/C++ configuration.
        const diagnostics = server.diagnostics?.get(textDocument.uri)?.diagnostics ?? [];
        if (diagnostics.some(item => ['pp_file_not_found', 'drv_unknown_argument',
            'err_fe_error_reading', 'drv_unknown_target_triple'].includes(item.code))) {
            return undefined;
        }
        const hints = (Array.isArray(native) ? native : []).map(item => nativeHint(item, options)).filter(Boolean);
        const parameterHints = options.parameterTypes ? hints.filter(item => item.kind === 2) : [];
        const types = (async () => {
            let i = 0;
            const limit = Math.min(parameterHints.length, 60);
            await Promise.all(Array.from({ length: Math.min(4, limit) }, async () => {
                while (i < limit && !cancellation.isCancellationRequested && document.version === version) {
                    const item = parameterHints[i++];
                    const name = /^&?([\p{L}_][\p{L}\p{N}_]*):$/u.exec(item.label)?.[1];
                    if (!name) { continue; }
                    const key = item.position.line + ':' + item.position.character;
                    if (!data.signatures.has(key)) {
                        data.signatures.set(key, server.request('textDocument/signatureHelp',
                            { textDocument, position: item.position }));
                    }
                    const type = parameterType(await data.signatures.get(key), name);
                    if (type) {
                        item.label = options.parameterNames ? type + ' ' + name + ':' : type + ':';
                        item.hasParameterType = true;
                    }
                }
            }));
        })();
        if (showEnums) {
            const text = document.getText();
            const offsetAt = at => document.offsetAt(new vscode.Position(at.line, at.character));
            const errors = diagnostics.filter(item => item.severity === 1 && item.range)
                .map(item => ({ start: offsetAt(item.range.start), end: offsetAt(item.range.end) }));
            const select = (at, length, declared) => {
                const offset = offsetAt(at);
                if (!enums) {
                    if (at.line < range.start.line || (at.line === range.start.line && at.character < range.start.character) ||
                        at.line > range.end.line || (at.line === range.end.line && at.character >= range.end.character)) { return undefined; }
                    return { offset };
                }
                const member = enums.candidate(offset, length, declared);
                if (member) {
                    const scope = member.group ?? { start: offset, end: offset + length };
                    if (errors.some(error => error.start < scope.end && error.end >= scope.start)) { return undefined; }
                    return member;
                }
            };
            const unresolved = item => item.candidate.declaration && item.candidate.value === undefined ? 1 : 0;
            const positions = enumPositions(server.capabilities.semanticTokensProvider?.legend, semantic, select)
                .sort((a, b) => unresolved(b) - unresolved(a)).slice(0, 100);
            let cursor = 0;
            await Promise.all(Array.from({ length: Math.min(4, positions.length) }, async () => {
                while (cursor < positions.length && !cancellation.isCancellationRequested && document.version === version) {
                    const { position: at, length, declaration, candidate: { offset } } = positions[cursor++];
                    if (!data.enumValues.has(offset)) {
                        data.enumValues.set(offset, server.request('textDocument/hover', { textDocument, position: at })
                            .then(hover => hoverEnum(hover, text.slice(offset, offset + length))));
                    }
                    const value = await data.enumValues.get(offset);
                    if (value !== undefined) {
                        hints.push({ position: at, label: value, length, declaration, enumValue: true, paddingRight: true });
                    }
                }
            }));
        }
        await types;
        if (cancellation.isCancellationRequested || document.version !== version) { return undefined; }
        return hints.filter(item => options.parameterNames || item.kind !== 2 || item.hasParameterType);
    }

    close(document) {
        for (const server of this.servers.values()) { server?.close(document); }
    }

    dispose() {
        this.officialState?.dispose();
        this.officialState = undefined;
        this.officialClient = undefined;
        for (const server of this.servers.values()) { server?.dispose(); }
        this.servers.clear();
        this.configuration = new WeakMap();
        this.data = new WeakMap();
    }
}

module.exports = { ClangdHints, nativeHint, hoverEnum };
