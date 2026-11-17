'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const { parameterDeclaration, deducedReturnType, signatureInfo } = require('../intellisense');

const [appCall, appHeader, appSource] = process.argv.slice(2);
const logCall = appCall ? fs.readFileSync(appCall, 'utf8').split(/\r?\n/)
    .find(line => line.includes('log_memcpy(&d->tx_array[1]') && line.includes('0x20')).trim()
    : 'log_memcpy(&d->tx_array[1], (const void *)addr, 0x20);';
const logPrototype = 'void log_memcpy(void * dst, const void *src, uint32_t size)';
const logHeaderText = appHeader ? fs.readFileSync(appHeader, 'utf8') : logPrototype + ';';
const logSourceText = appSource ? fs.readFileSync(appSource, 'utf8') : logPrototype + ' {}';

const body = [
    'static uint32_t sbs_cap_mode(uint32_t capmah);',
    'static void apply_count(const int16_t * _count);',
    'int value;',
    'void demo(void) {',
    '    value = sbs_cap_mode(sbs_uint16_limit(BMS_PARAM->board.design_capacity));',
    '    apply_count(&limit);',
    '    unresolved(12);',
    '    overloaded(4);',
    '    ' + logCall,
    '    ' + logCall.replace('0x20', '/* size */ 0x40'),
    '}',
].join('\n');
const header = '#ifndef LIMIT_H\n#define LIMIT_H\nuint16_t sbs_uint16_limit(uint32_t a);\n#endif\n';
class Position {
    constructor(line, character) { Object.assign(this, { line, character }); }
    compareTo(other) { return this.line - other.line || this.character - other.character; }
}
function document(text, filename) {
    const parts = text.split('\n');
    const offsets = [0];
    for (const part of parts.slice(0, -1)) { offsets.push(offsets.at(-1) + part.length + 1); }
    return {
        uri: { scheme: 'file', fsPath: filename, toString: () => 'file:///' + filename },
        lineCount: parts.length, version: 1, languageId: 'c', getText: () => text,
        offsetAt: pos => offsets[pos.line] + pos.character,
        positionAt(offset) {
            const line = offsets.findLastIndex(start => start <= offset);
            return new Position(line, offset - offsets[line]);
        }
    };
}
const doc = document(body, 'demo.c');
const declarations = document(header, 'limit.h');
const logHeader = document(logHeaderText, 'log.h');
const logSource = document(logSourceText, 'log.c');
const calls = [];
const signature = (name, param) => ({ label: `int ${name}(${param})`, parameters: [{ label: param }] });
let useClangd = false;
let engine = 'default';
let style = 'nameAndType';
let nativeNames = false;
let hideUnderscores = true;
let suppressNames = true;
const dispose = () => ({ dispose() {} });
let provider;
let changedConfiguration;
let optionalRequests = 0;
const disabledType = '<\u9519\u8bef\u7c7b\u578b>';
const logHelp = suffix => ({ signatures: [{
    label: `void log_memcpy(void *dst, const void *src, ${suffix})`,
    parameters: [{ label: 'dst' }, { label: 'src' }, { label: 'size' }]
}] });
const logTarget = (target, text) => {
    const name = text.indexOf('log_memcpy', text.indexOf('void log_memcpy('));
    assert(name >= 0);
    return { targetUri: target.uri, targetSelectionRange: { start: target.positionAt(name) } };
};
const vscode = {
    extensions: { getExtension: id => id === 'ms-vscode.cpptools' ? {} : undefined },
    Position, EventEmitter: class { fire() {} event() {} dispose() {} },
    commands: {
        registerCommand: dispose,
        async executeCommand(name, _, position) {
            calls.push(name);
            assert.notEqual(engine, 'disabled');
            if (name === 'vscode.provideDocumentSemanticTokensLegend') { return undefined; }
            if (name === 'vscode.executeSignatureHelpProvider') {
                const at = doc.offsetAt(position);
                const preceding = body.slice(0, at).match(/(\w+)\($/)[1];
                if (preceding === 'overloaded') {
                    return { signatures: [signature(preceding, 'long n'), signature(preceding, 'int n')] };
                }
                if (preceding === 'log_memcpy') {
                    return logHelp(body.slice(at, body.indexOf('\n', at)).includes('0x20')
                        ? disabledType + ' size' : 'unsigned int size');
                }
                if (preceding === 'apply_count') { return undefined; }
                const arg = { sbs_cap_mode: 'capmah', sbs_uint16_limit: 'a', unresolved: 'count' }[preceding];
                return { signatures: [signature(preceding, disabledType + ' ' + arg)] };
            }
            if (name === 'vscode.executeDefinitionProvider') {
                const text = body.slice(doc.offsetAt(position));
                if (text.startsWith('sbs_uint16_limit')) {
                    return [{ targetUri: declarations.uri,
                        targetSelectionRange: { start: declarations.positionAt(header.indexOf('sbs_uint16_limit')) } }];
                }
                if (text.startsWith('log_memcpy') && text.split('\n', 1)[0].includes('0x40')) {
                    return [logTarget(logSource, logSourceText)];
                }
                return [];
            }
            if (name === 'vscode.executeDeclarationProvider') {
                return body.slice(doc.offsetAt(position)).startsWith('log_memcpy') ? [logTarget(logHeader, logHeaderText)] : [];
            }
            if (name === 'vscode.executeHoverProvider') { return []; }
            assert.fail(name);
        }
    },
    workspace: {
        onDidChangeConfiguration(listener) { changedConfiguration = listener; return dispose(); },
        onDidSaveTextDocument: dispose,
        getConfiguration(section) {
            return {
                get(key, fallback) {
                    if (section === 'C_Cpp') {
                        return {
                            intelliSenseEngine: engine,
                            'inlayHints.parameterNames.enabled': nativeNames,
                            'inlayHints.parameterNames.hideLeadingUnderscores': hideUnderscores,
                            'inlayHints.parameterNames.suppressWhenArgumentContainsName': suppressNames
                        }[key] ?? fallback;
                    }
                    if (key === 'parameterHintStyle') { return style ?? fallback; }
                    if (key === 'parameterTypes') { return true; }
                    if (key === 'useClangd') { return useClangd; }
                    return fallback;
                },
                update() { assert.fail('The extension must not write any settings'); }
            };
        },
        async openTextDocument(uri) { return [declarations, logHeader, logSource].find(item => item.uri === uri); }
    },
};
const load = Module._load;
Module._load = (name, ...args) => {
    if (name === 'vscode') { return vscode; }
    if (name === './render') { return { installRenderer(_, __, next) { provider = next; return dispose(); } }; }
    if (name === './clangd-hints') { return { ClangdHints: class {
        async open() { return useClangd ? {} : undefined; }
        async hints(_, __, ___, options) {
            optionalRequests++;
            assert(useClangd);
            if (style === 'disabled') {
                assert.deepEqual([options.parameterNames, options.parameterTypes, options.suppressParameterHints], [false, false, true]);
                return [];
            }
            return undefined; // clangd cannot build this AC5 translation unit.
        }
        dispose() {}
    } }; }
    return load(name, ...args);
};
const { activate } = require('../extension');
Module._load = load;

async function main() {
    activate({ subscriptions: [] });
    const range = { start: doc.positionAt(0), end: doc.positionAt(body.length),
        contains(pos) { return pos.compareTo(this.start) >= 0 && pos.compareTo(this.end) <= 0; } };
    const run = () => provider.provideInlayHints(doc, range, { isCancellationRequested: false });
    const logHints = ['void * dst:', 'const void * src:', 'uint32_t size:'];
    const expected = ['uint32_t capmah:', 'uint32_t a:', 'const int16_t * _count:', 'count:', ...logHints, ...logHints];
    const result = await run();
    assert.deepEqual(result.map(item => item.label), expected);
    for (const hint of result.filter(item => item.label === 'uint32_t size:')) {
        assert.match(body.slice(doc.offsetAt(hint.position)), /^0x(?:20|40)\)/);
    }
    assert.deepEqual(signatureInfo(logHelp('size'), 'log_memcpy').parameters[2], { name: 'size', type: undefined });
    assert.equal(doc.offsetAt(result[0].position), body.indexOf('sbs_uint16_limit('));
    assert.equal(doc.offsetAt(result[1].position), body.indexOf('BMS_PARAM'));
    assert.equal(optionalRequests, 0);
    assert(calls.includes('vscode.executeSignatureHelpProvider') && calls.includes('vscode.executeDefinitionProvider'));
    useClangd = true;
    assert.deepEqual((await run()).map(item => item.label), expected, 'one parameter label per argument with optional clangd');
    assert.equal(optionalRequests, 1);
    useClangd = false;
    engine = 'disabled';
    calls.length = 0;
    doc.version++;
    assert.deepEqual((await run()).map(item => item.label), ['uint32_t capmah:', 'const int16_t * _count:']);
    assert.deepEqual(calls, [], 'read-only local fallback must not require IntelliSense when disabled');
    const refresh = () => changedConfiguration({ affectsConfiguration: key => key === 'clangdStyleCppHints' });
    const labels = async () => (await run()).map(item => item.label);
    engine = 'default';
    style = 'name';
    refresh();
    assert.deepEqual(await labels(), ['capmah:', 'a:', 'count:', 'count:', 'dst:', 'src:', 'size:', 'dst:', 'src:']);
    hideUnderscores = false;
    suppressNames = false;
    refresh();
    assert.deepEqual(await labels(), ['capmah:', 'a:', '_count:', 'count:', 'dst:', 'src:', 'size:', 'dst:', 'src:', 'size:']);
    nativeNames = true;
    refresh();
    assert.deepEqual(await labels(), [], 'Microsoft C/C++ owns the name-only hints when enabled');
    nativeNames = false;
    style = undefined;
    refresh();
    assert.deepEqual(await labels(), ['capmah:', 'a:', '_count:', 'count:', 'dst:', 'src:', 'size:', 'dst:', 'src:', 'size:'],
        'default name-only style ignores the old parameterTypes setting');
    style = 'nameAndType';
    refresh();
    assert.deepEqual(await labels(), expected);
    style = 'disabled';
    useClangd = true;
    calls.length = 0;
    refresh();
    assert.deepEqual(await labels(), []);
    assert(!calls.includes('vscode.executeSignatureHelpProvider'));
    assert.equal(parameterDeclaration('<error type> capmah').type, undefined);
    assert.equal(parameterDeclaration('const uint32_t').name, undefined);
    assert.equal(deducedReturnType([{ contents: [{ language: 'cpp', value: 'uint32_t make_val(int x)' }] }], 'make_val'), 'uint32_t');
    console.log('PASS: nested AC5 typedef hints without clangd or semantic tokens, header fallback, no error labels or provider duplicates, no settings writes.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
