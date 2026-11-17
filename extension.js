'use strict';

const vscode = require('vscode');
const source = require('./source');
const intel = require('./intellisense');
const { ClangdHints } = require('./clangd-hints');
const { AstHints } = require('./ast-hints');
const { enumContext, declarationModifier, formatEnumHints } = require('./enum-hints');
const { indexedEnums, quotedIncludes, includedEnumNames, indexHeader, resolveEnumReference } = require('./enum-references');
const { installRenderer } = require('./render');
const settingsId = 'clangdStyleCppHints';

function withTimeout(task, timeout = 1800) {
    let timer;
    return Promise.race([
        task,
        new Promise(resolve => { timer = setTimeout(resolve, timeout); })
    ]).catch(() => undefined).finally(() => clearTimeout(timer));
}

function run(command, ...args) {
    return withTimeout(vscode.commands.executeCommand(command, ...args));
}

function enumOrCallTokens(legend, tokens) {
    const result = [];
    const declarations = declarationModifier(legend);
    let line = 0;
    let column = 0;
    for (let i = 0; i < (tokens?.data?.length ?? 0); i += 5) {
        const [deltaLine, deltaColumn, length, type, modifiers] = tokens.data.subarray(i, i + 5);
        line += deltaLine;
        column = deltaLine ? deltaColumn : column + deltaColumn;
        const kind = legend?.tokenTypes[type];
        if (['enumMember', 'function', 'method', 'templateFunction', 'templateMethod', 'variable'].includes(kind)) {
            result.push({ position: new vscode.Position(line, column), length, kind, declaration: Boolean(modifiers & declarations) });
        }
    }
    return result;
}

function show(document, offset, text, isPrefix = false, gap = true, hintKind) {
    return {
        position: document.positionAt(offset), label: text, hintKind,
        paddingLeft: !isPrefix && gap, paddingRight: isPrefix && gap
    };
}

function compareHints(a, b) {
    return a.position.compareTo(b.position) ||
        Number(Boolean(a.enumValue)) - Number(Boolean(b.enumValue));
}

function combineHints(...sources) {
    const hints = new Map();
    for (const hint of sources.flat()) {
        const kind = hint.enumValue ? 'enum' : hint.hintKind ?? (hint.kind === 2 ? 'parameter'
            : hint.label.startsWith('[') ? 'index' : hint.label.startsWith('.') ? 'field'
                : hint.kind === 1 ? 'deduced' : hint.label);
        const key = `${hint.position.line}:${hint.position.character}:${kind}`;
        const previous = hints.get(key);
        if (!previous || (kind === 'parameter' && hint.hasParameterType && !previous.hasParameterType)) {
            hints.set(key, hint);
        }
    }
    return [...hints.values()];
}

async function fieldNames(document, type, current) {
    const definitions = await run('vscode.executeDefinitionProvider', document.uri, document.positionAt(type.start));
    if (definitions?.length !== 1) {
        return undefined;
    }
    const location = definitions[0];
    const uri = location.targetUri ?? location.uri;
    const range = location.targetSelectionRange ?? location.range;
    if (!uri || !range) {
        return undefined;
    }
    if (uri.toString() === document.uri.toString()) {
        return source.structFields(current.tokens, document.offsetAt(range.start));
    }
    const header = await withTimeout(vscode.workspace.openTextDocument(uri));
    if (!header || header.lineCount > 12000) {
        return undefined;
    }
    return source.structFields(source.indexSource(header.getText()).tokens, header.offsetAt(range.start));
}

function declarationSignature(current, declaration) {
    const parameters = [];
    for (const { start, end } of declaration.items) {
        const text = current.text.slice(current.tokens[start].start, current.tokens[end - 1].end);
        if (text === 'void' && declaration.items.length === 1) { break; }
        if (text === '...') { return { parameters, variadic: true }; }
        const parameter = intel.parameterDeclaration(text);
        if (!parameter.type) { return undefined; }
        parameters.push(parameter);
    }
    return { parameters };
}

function localSignature(current, name, index, document) {
    if (document.languageId !== 'c' || ['.', '->', '::'].includes(current.tokens[index - 1]?.value)) { return undefined; }
    const offset = current.tokens[index].start;
    const declarations = current.functions.get(name)?.filter(item => item.name.start < offset) ?? [];
    const signatures = declarations.map(item => declarationSignature(current, item));
    return declarations.some(item => !item.conditional) && signatures.every(Boolean) &&
        new Set(signatures.map(item => JSON.stringify(item))).size === 1 ? signatures[0] : undefined;
}

async function signatureFromTargets(document, current, token, targets) {
    if (!targets?.length || targets.length > 4) { return undefined; }
    const signatures = [];
    for (const target of targets) {
        const uri = target.targetUri ?? target.uri;
        const range = target.targetSelectionRange ?? target.range;
        if (!uri || !range) { continue; }
        const sameDocument = uri.toString() === document.uri.toString();
        const header = sameDocument ? document : await withTimeout(vscode.workspace.openTextDocument(uri));
        if (!header || header.lineCount > 15000) { continue; }
        const anchor = header.offsetAt(range.start);
        const indexed = sameDocument ? current : lookup(current.headers, uri.toString() + ':' + header.version, () => {
            const text = header.getText();
            return text.length <= 1024 * 1024 ? { text, ...source.indexSource(text) } : undefined;
        });
        const contents = await indexed;
        if (!contents) { continue; }
        const rangeEnd = range.end ? Math.min(header.offsetAt(range.end), anchor + 1200) : anchor;
        const candidates = contents.offsets.has(anchor) && contents.tokens[contents.offsets.get(anchor)]?.value === token.value
            ? [contents.offsets.get(anchor)] : contents.tokens.flatMap((item, index) => item.value === token.value &&
                ((item.start > anchor && item.start < rangeEnd) ||
                    (Math.abs(item.start - anchor) <= 300 && header.positionAt(item.start).line === range.start.line)) ? [index] : []);
        if (candidates.length !== 1) { continue; }
        const decl = source.functionDeclaration(contents.tokens, candidates[0]);
        const signature = decl && declarationSignature(contents, decl);
        if (signature) { signatures.push(signature); }
    }
    return signatures.length === targets.length && new Set(signatures.map(item => JSON.stringify(item))).size === 1
        ? signatures[0] : undefined;
}

async function linkedSignature(document, current, token, tryHover) {
    const position = document.positionAt(token.start);
    for (const command of ['vscode.executeDefinitionProvider', 'vscode.executeDeclarationProvider']) {
        const targets = await run(command, document.uri, position);
        const signature = await signatureFromTargets(document, current, token, targets);
        if (signature) { return signature; }
    }
    if (tryHover) {
        return intel.hoveredSignature(await run('vscode.executeHoverProvider', document.uri, position), token.value);
    }
}

function parameterOptions(settings, cppSettings, services) {
    switch (settings.get('parameterHintStyle', 'name')) {
        case 'nameAndType':
            return { parameterNames: true, parameterTypes: true };
        case 'disabled':
            return { parameterNames: false, parameterTypes: false, suppressParameterHints: true };
        default:
            return {
                parameterNames: !services || !cppSettings.get('inlayHints.parameterNames.enabled', false),
                parameterTypes: false,
                nativeNameStyle: {
                    hideLeadingUnderscores: cppSettings.get('inlayHints.parameterNames.hideLeadingUnderscores', true),
                    suppressWhenArgumentContainsName: cppSettings.get('inlayHints.parameterNames.suppressWhenArgumentContainsName', true)
                }
            };
    }
}

function nativeStyleName(name, argument, settings) {
    const displayName = settings.hideLeadingUnderscores ? name.replace(/^_+(?=[^_])/, '') : name;
    if (settings.suppressWhenArgumentContainsName) {
        const words = argument.match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? [];
        if (words.includes(name) || words.includes(displayName)) { return undefined; }
    }
    return displayName;
}

function astLabels(document, text, items, options) {
    return items.flatMap(item => {
        if (item.kind === 'parameter') {
            const argument = text.slice(item.offset, item.end);
            const name = item.name && options.parameterNames && (options.nativeNameStyle
                ? nativeStyleName(item.name, argument, options.nativeNameStyle)
                : item.name === argument.trim() ? undefined : item.name);
            const type = options.parameterTypes ? item.type : undefined;
            const label = [type, name].filter(Boolean).join(' ');
            return label ? [{ ...show(document, item.offset, label + ':', true, true, 'parameter'),
                hasParameterType: Boolean(type) }] : [];
        }
        if (item.kind === 'enum' && item.end > item.offset) {
            return [{ position: document.positionAt(item.offset), label: item.label, length: item.end - item.offset,
                enumValue: true, declaration: item.declaration, hexadecimal: item.hexadecimal }];
        }
        if (item.kind === 'deduced' && options.deducedTypes) {
            return [show(document, item.offset, item.label, false, item.label.startsWith('->'), 'deduced')];
        }
        if ((item.kind === 'field' && options.structFields) || (item.kind === 'index' && options.arrayIndices)) {
            return [show(document, item.offset, item.label, true, false, item.kind)];
        }
        return [];
    });
}

async function callHints(document, token, current, index, call, options, services) {
    const first = call.items[0];
    const at = current.tokens[first.start].start;
    const help = services && await run('vscode.executeSignatureHelpProvider', document.uri, document.positionAt(at));
    if (help?.signatures?.length > 1) { return []; }
    const signature = intel.signatureInfo(help, token.value);
    const missingTypes = options.parameterTypes && (!signature?.parameters.length || signature.parameters.some(param => !param.type));
    const possibleAlias = document.languageId === 'c' && options.parameterTypes && signature?.parameters.some(param =>
        /^(?:(?:const|volatile)\s+)*(?:signed|unsigned|char|short|int|long)(?:\s+(?:char|short|int|long))*$/.test(param.type ?? ''));
    let declaration = localSignature(current, token.value, index, document);
    if ((!signature?.parameters.length || missingTypes || possibleAlias) && !declaration && services) {
        declaration = await linkedSignature(document, current, token, !signature?.parameters.length || missingTypes);
    }
    const parameters = signature?.parameters?.length ? signature.parameters.map((param, i) => {
        const original = declaration?.parameters.length === signature.parameters.length && declaration.parameters[i];
        // Retain the source spelling of embedded typedefs and recover types
        // that the language service couldn't resolve for an AC5 header.
        return original && (!param.name || !original.name || param.name === original.name)
            ? { name: param.name ?? original.name, type: original.type ?? param.type } : param;
    }) : declaration?.parameters;
    if (!parameters || (call.items.length > parameters.length && !signature?.variadic && !declaration?.variadic)) { return []; }
    const hints = [];
    call.items.forEach(({ start, end }, i) => {
        const param = parameters[i];
        if (!param) { return; }
        const arg = current.tokens[start];
        if (options.nativeNameStyle) {
            const argument = current.text.slice(current.tokens[start - 1].end, current.tokens[end].start);
            const name = param.name && nativeStyleName(param.name, argument, options.nativeNameStyle);
            if (name) { hints.push(show(document, arg.start, name + ':', true, true, 'parameter')); }
            return;
        }
        const before = current.text.slice(current.tokens[start - 1].end, arg.start);
        const annotated = /\/\*\s*([\p{L}_][\p{L}\p{N}_]*)\s*[:=]\s*\*\//u.exec(before)?.[1] === param.name;
        const ref = /[^&]&$/.test(param.type ?? '') && !/\bconst\b/.test(param.type) ? '&' : '';
        const redundant = !ref && start + 1 === end && arg.value === param.name;
        const showName = options.parameterNames && param.name && !annotated && !redundant;
        const type = options.parameterTypes ? param.type : undefined;
        const label = [type, showName ? (type ? '' : ref) + param.name : undefined].filter(Boolean).join(' ');
        if (label) {
            hints.push({ ...show(document, arg.start, label + ':', true, true, 'parameter'), hasParameterType: Boolean(type) });
        }
    });
    return hints;
}

function aggregateHints(document, current, start, end, options, jobs) {
    const hints = [];
    const { tokens } = current;
    const includes = offset => offset >= start && offset <= end;
    for (const { index, type, isArray } of current.aggregates) {
        const close = tokens[tokens[index].close];
        if (tokens[index].start > end || !close || close.end < start) {
            continue;
        }
        const list = source.splitList(tokens, index);
        if (!list || list.ambiguous) {
            continue;
        }
        const items = isArray ? source.arrayItems(tokens, list) : [];
        if (isArray && options.arrayIndices) {
            for (const item of items) {
                const offset = tokens[item.item.start].start;
                if (includes(offset)) {
                    hints.push(show(document, offset, '[' + item.index + ']=', true, false, 'index'));
                }
            }
        }
        if (!options.structFields) {
            continue;
        }
        const rows = isArray ? items.flatMap(({ item }) => {
            const row = tokens[item.start];
            if (row.value !== '{' || tokens[row.close]?.end < start || row.start > end) {
                return [];
            }
            return [source.splitList(tokens, item.start)];
        }) : [list];
        const positional = rows.filter(row => row && !row.ambiguous &&
            row.items.every(({ start }) => !['.', '['].includes(tokens[start].value)));
        if (!positional.length) {
            continue;
        }
        jobs.push(() => lookup(current.fields, type.start, () => fieldNames(document, type, current))
            .then(fields => {
                if (!fields) { return []; }
                return positional.flatMap(row => row.items.length > fields.length ? [] :
                    row.items.flatMap(({ start: first }, i) => includes(tokens[first].start)
                        ? [show(document, tokens[first].start, '.' + fields[i] + '=', true, false, 'field')]
                        : []));
            }));
    }
    return hints;
}

function lookup(cache, key, work) {
    if (!cache.has(key)) {
        const value = Promise.resolve().then(work).catch(() => undefined).then(result => {
            if (result === undefined || (Array.isArray(result) && !result.length)) {
                cache.delete(key);
            }
            return result;
        });
        cache.set(key, value);
    }
    return cache.get(key);
}

function enumReferenceJob(document, current, token, semantic, query, find, openDocument) {
    return lookup(current.details, 'enum-ref:' + token.start, async () => {
        const position = document.positionAt(token.start);
        const origin = await resolveEnumReference(document, position, token.value, query, find, openDocument);
        let value = origin?.value;
        if (value === undefined && (semantic || origin)) {
            value = intel.enumValue(await query('vscode.executeHoverProvider', document.uri, position), token.value);
        }
        if (value === undefined && !origin) { return undefined; }
        return [{ position, label: value, length: token.end - token.start, hexadecimal: origin?.hexadecimal, enumValue: true }];
    });
}

function activate(context) {
    const changed = new vscode.EventEmitter();
    const log = vscode.window?.createOutputChannel('Clangd-Style C/C++ Inlay Hints');
    const clangd = new ClangdHints(vscode, line => log?.appendLine(line), () => changed.fire());
    const ast = new AstHints(vscode, context.extensionPath ?? __dirname, line => log?.appendLine(line));
    let documents = new WeakMap();
    let includeIndexes = new WeakMap();
    let headerIndexes = new WeakMap();
    let refreshTimer;
    const openHeader = uri => withTimeout(vscode.workspace.openTextDocument(uri));
    function refresh() {
        documents = new WeakMap();
        includeIndexes = new WeakMap();
        headerIndexes = new WeakMap();
        clangd.dispose();
        ast.dispose();
        changed.fire();
    }
    function requestRefresh() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            documents = new WeakMap();
            includeIndexes = new WeakMap();
            headerIndexes = new WeakMap();
            ast.dispose();
            changed.fire();
        }, 500);
    }
    if (log) { context.subscriptions.push(log); }
    context.subscriptions.push(changed, clangd, ast, { dispose: () => clearTimeout(refreshTimer) },
        vscode.commands.registerCommand(settingsId + '.refresh', refresh),
        vscode.workspace.onDidChangeConfiguration(event => {
            if ([settingsId, 'C_Cpp', 'clangd', 'editor.semanticHighlighting'].some(section => event.affectsConfiguration(section))) {
                refresh();
            }
        }),
        vscode.workspace.onDidSaveTextDocument(document => {
            if (/(?:^|[/\\])(?:compile_commands\.json|compile_flags\.txt|c_cpp_properties\.json|\.clangd)$/.test(document.uri.fsPath ?? '')) {
                refresh();
            } else {
                requestRefresh();
            }
        }),
        installRenderer(vscode, changed.event, {
            async provideInlayHints(document, range, cancellation) {
                const settings = vscode.workspace.getConfiguration(settingsId, document);
                if (!settings.get('enabled', true) || document.lineCount > 15000) {
                    return [];
                }
                const cppSettings = vscode.workspace.getConfiguration('C_Cpp', document);
                const services = Boolean(vscode.extensions?.getExtension('ms-vscode.cpptools'))
                    && String(cppSettings.get('intelliSenseEngine', 'default')).toLowerCase() !== 'disabled';
                const options = {
                    ...parameterOptions(settings, cppSettings, services),
                    ...Object.fromEntries(['deducedTypes', 'enumValues', 'arrayIndices', 'structFields']
                        .map(key => [key, settings.get(key, true)])),
                    enumValuePlacement: settings.get('enumValuePlacement', 'prefix'),
                    enumValueReferences: settings.get('enumValueReferences', false),
                    enumValuesHexadecimal: settings.get('enumValuesHexadecimal', false),
                    tabSize: cancellation.tabSize
                };
                const version = document.version;
                let current = documents.get(document);
                if (current?.version !== version) {
                    const text = document.getText();
                    if (text.length > 1024 * 1024) { return []; }
                    current = { text, ...source.indexSource(text), version, details: new Map(), fields: new Map(), headers: new Map() };
                    current.functions = document.languageId === 'c' ? source.cFunctions(current.tokens) : new Map();
                    current.aggregates = current.tokens.flatMap((_, index) => {
                        const aggregate = source.aggregateAt(current.tokens, index);
                        return aggregate ? [{ index, ...aggregate }] : [];
                    });
                    documents.set(document, current);
                }
                const start = document.offsetAt(range.start);
                const end = document.offsetAt(range.end);
                let enums;
                if (options.enumValues || options.enumValueReferences) {
                    enums = enumContext(indexedEnums(current), start, end, options);
                }
                const stale = () => cancellation.isCancellationRequested ||
                    document.version !== version || documents.get(document) !== current;
                const finish = (hints, syntax = [], authoritative = false) => {
                    const evaluated = enums ? formatEnumHints(document, enums,
                        hints.filter(hint => hint.enumValue), syntax.filter(hint => hint.enumValue), authoritative) : [];
                    return combineHints(hints.filter(hint => !hint.enumValue), syntax.filter(hint => !hint.enumValue), evaluated)
                        .filter(hint => range.contains(hint.position))
                        .sort(compareHints);
                };
                if (settings.get('useClangd', true)) {
                    try {
                        const server = await withTimeout(clangd.open(document, cancellation), 5500);
                        if (stale()) { return []; }
                        if (server) {
                            const clangOptions = { ...options, ...parameterOptions(settings, cppSettings, false) };
                            const extracted = await ast.hints(document);
                            if (stale()) { return []; }
                            const supplemental = extracted && {
                                ...clangOptions, enumValues: false, enumValueReferences: false,
                                parameterNames: Boolean(server.official) && clangOptions.parameterNames,
                                parameterTypes: false,
                                structFields: Boolean(server.official) && clangOptions.structFields,
                                arrayIndices: Boolean(server.official) && clangOptions.arrayIndices,
                                deducedTypes: Boolean(server.official) && clangOptions.deducedTypes
                            };
                            const results = await clangd.hints(server, document, range,
                                supplemental || clangOptions, cancellation, enums);
                            if (stale()) { return []; }
                            const languageHints = (results ?? []).map(hint => ({ ...hint,
                                position: new vscode.Position(hint.position.line, hint.position.character) }));
                            if (extracted) {
                                const labels = astLabels(document, current.text, extracted, clangOptions);
                                if (!server.official) { return finish(languageHints, labels, true); }
                                const hintKey = hint => `${hint.position.line}:${hint.position.character}:${hint.label}`;
                                const native = new Set(languageHints.map(hintKey));
                                return finish([], labels.filter(hint => hint.enumValue || !native.has(hintKey(hint))), true);
                            }
                            if (results) {
                                return finish([], server.official
                                    ? languageHints.filter(hint => hint.enumValue || hint.hasParameterType) : languageHints);
                            }
                        }
                    } catch (error) {
                        log?.appendLine(error.message);
                    }
                }
                if (stale()) { return []; }
                const jobs = [];
                const unresolvedEnums = [];
                const references = new Map();
                const headerIndex = header => {
                    if (header === document) { return current; }
                    const cached = headerIndexes.get(header);
                    if (cached?.version === header.version) { return cached.index; }
                    const index = indexHeader(header);
                    headerIndexes.set(header, { version: header.version, index });
                    return index;
                };
                const hints = aggregateHints(document, current, start, end, options, jobs);
                const showFunctions = options.parameterNames || options.parameterTypes;
                const semanticKinds = new Map();
                if (services && (enums || options.deducedTypes || showFunctions)) {
                    const semantic = await lookup(current.details, 'tokens', async () => {
                        const legend = await run('vscode.provideDocumentSemanticTokensLegend', document.uri);
                        if (!legend) { return undefined; }
                        const tokens = await run('vscode.provideDocumentSemanticTokens', document.uri);
                        return tokens?.data?.length ? enumOrCallTokens(legend, tokens) : undefined;
                    });
                    if (stale()) { return []; }
                    if (!semantic && !current.retried) {
                        current.retried = true;
                        cancellation.waitingForSemanticTokens = true;
                        setTimeout(() => {
                            if (documents.get(document) === current) { changed.fire(); }
                        }, 1200);
                    }
                    for (const item of semantic ?? []) {
                        const offset = document.offsetAt(item.position);
                        const enumMember = item.kind === 'enumMember' && enums?.candidate(offset, item.length, item.declaration);
                        if (!enumMember && (offset < start || offset > end)) { continue; }
                        const index = current.offsets.get(offset);
                        const token = current.tokens[index];
                        if (!token || token.end - token.start !== item.length) { continue; }
                        semanticKinds.set(index, item.kind);
                        if (enumMember && !enumMember.declaration) {
                            references.set(token.start, { token, line: item.position.line, semantic: true });
                            continue;
                        }
                        if (enumMember?.declaration && enumMember.value !== undefined) { continue; }
                        const autoVariable = options.deducedTypes && document.languageId === 'cpp' &&
                            item.kind === 'variable' && source.isSimpleAuto(current.tokens, index);
                        const followedBy = current.tokens[index + 1];
                        const functionEnd = current.tokens[followedBy?.close];
                        const autoFunction = options.deducedTypes && document.languageId === 'cpp' &&
                            ['function', 'method', 'templateFunction', 'templateMethod'].includes(item.kind) &&
                            followedBy?.value === '(' && current.tokens[followedBy.close + 1]?.value === '{' &&
                            source.isSimpleAuto(current.tokens, index);
                        if (enumMember || autoVariable || autoFunction) {
                            const queue = enumMember?.declaration && enumMember.value === undefined ? unresolvedEnums : jobs;
                            queue.push(() => lookup(current.details, offset, async () => {
                                const hover = await run('vscode.executeHoverProvider', document.uri, item.position);
                                const value = enumMember
                                    ? intel.enumValue(hover, token.value)
                                    : autoFunction ? intel.deducedReturnType(hover, token.value) : intel.deducedType(hover, token.value);
                                if (value === undefined) { return undefined; }
                                return enumMember
                                    ? [{ position: item.position, label: value, length: item.length, declaration: item.declaration, enumValue: true }]
                                    : autoFunction ? [show(document, functionEnd.end, '-> ' + value, false, true, 'deduced')]
                                        : [show(document, token.end, ': ' + value, false, false, 'deduced')];
                            }));
                        }
                    }
                }
                if (services && options.enumValueReferences) {
                    const includes = quotedIncludes(current.tokens);
                    const key = JSON.stringify(includes);
                    let cached = includeIndexes.get(document);
                    if (cached?.key !== key) {
                        cached = { key, names: includedEnumNames(vscode, document, includes, openHeader, headerIndex) };
                        includeIndexes.set(document, cached);
                    }
                    const names = new Set(await cached.names);
                    if (stale()) { return []; }
                    for (const group of current.enumGroups) {
                        for (const member of group.members) { names.add(member.name); }
                    }
                    for (let i = 0; i < current.tokens.length; i++) {
                        const token = current.tokens[i];
                        if (token.start > end) { break; }
                        if (token.start < start || !names.has(token.value) || semanticKinds.has(i) || references.has(token.start) ||
                            enums.candidate(token.start, token.end - token.start, false)?.declaration !== false) { continue; }
                        references.set(token.start, { token, line: document.positionAt(token.start).line, semantic: false });
                    }
                }
                if (showFunctions) {
                    let remaining = 60;
                    for (let i = 0; i < current.tokens.length && remaining; i++) {
                        const token = current.tokens[i];
                        if (token.start > end) { break; }
                        if (token.start < start || current.tokens[i + 1]?.value !== '(' ||
                            ['variable', 'enumMember'].includes(semanticKinds.get(i)) ||
                            (!services && !current.functions.has(token.value))) { continue; }
                        const call = source.findCall(current.tokens, i);
                        if (!call || call.ambiguous || !call.items.length || source.functionDeclaration(current.tokens, i)) { continue; }
                        remaining--;
                        jobs.push(() => lookup(current.details, 'call:' + token.start,
                            () => callHints(document, token, current, i, call, options, services)));
                    }
                }
                const distance = line => (cancellation.visibleSpans ?? []).reduce((best, span) =>
                    Math.min(best, Math.max(span.first - line, line - span.last, 0)), Infinity);
                const referenceJobs = [...references.values()]
                    .sort((a, b) => (distance(a.line) - distance(b.line) || Number(b.semantic) - Number(a.semantic)))
                    .slice(0, 50).map(({ token, semantic }) => () =>
                        enumReferenceJob(document, current, token, semantic, run, headerIndex, openHeader));
                const work = referenceJobs.concat(unresolvedEnums, jobs);
                let cursor = 0;
                const limit = Math.min(work.length, 100);
                await Promise.all(Array.from({ length: Math.min(limit, 4) }, async () => {
                    while (cursor < limit && !stale()) {
                        const additions = await work[cursor++]();
                        if (additions) { hints.push(...additions); }
                    }
                }));
                if (stale()) { return []; }
                return finish(hints);
            }
        }, log));
    if (vscode.workspace.onDidCloseTextDocument) {
        context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
            clangd.close(document);
            ast.close(document);
        }));
    }
    if (vscode.extensions?.onDidChange) { context.subscriptions.push(vscode.extensions.onDidChange(refresh)); }
}

module.exports = { activate };
