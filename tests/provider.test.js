'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const source = require('../source');
const intel = require('../intellisense');

const lines = [
    'typedef struct { unsigned command; void (*handler)(void); } ProtocolCommand_t;',
    'enum Mode { IDLE, MODE_RUN = 0x10, NEXT };',
    'int read_reg(unsigned addr, unsigned width);',
    'static const ProtocolCommand_t ProtocolCommand[] = {',
    '    { MODE_RUN, HandleQueryCommand },',
    '    [0x3] = { NEXT, HandleNextCommand },',
    '    { IDLE, HandleIdleCommand }',
    '};',
    'auto result = read_reg(0x20, calc(2, 3));',
    '// MODE_RUN read_reg(0,0)',
    'enum BuildMode { BUILD = BOARD_MODE, FOLLOW };',
    'int mode() { return FOLLOW; }'
];
const body = lines.join('\n');
const offsets = lines.map((_, i) => lines.slice(0, i).join('\n').length + (i ? 1 : 0));
class Position {
    constructor(line, character) { Object.assign(this, { line, character }); }
    compareTo(other) { return this.line - other.line || this.character - other.character; }
}
class Range {
    constructor(start, end) { Object.assign(this, { start, end }); }
}
const doc = {
    uri: { toString: () => 'file:///demo.cpp' }, languageId: 'cpp',
    lineCount: lines.length, version: 1,
    getText(range) {
        return range ? body.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : body;
    },
    lineAt: line => ({ text: lines[line] }),
    offsetAt: pos => offsets[pos.line] + pos.character,
    positionAt(offset) {
        const line = offsets.findLastIndex(start => start <= offset);
        return new Position(line, offset - offsets[line]);
    }
};
const tokens = [[1, 'MODE_RUN', 0], [2, 'read_reg', 1], [4, 'MODE_RUN', 0], [5, 'NEXT', 0],
    [6, 'IDLE', 0], [8, 'result', 2], [8, 'read_reg', 1], [10, 'BUILD', 0], [10, 'FOLLOW', 0], [11, 'FOLLOW', 0]];
let prevLine = 0;
let prevCol = 0;
const data = new Uint32Array(tokens.flatMap(([line, name, type]) => {
    const col = lines[line].indexOf(name);
    const entry = [line - prevLine, line === prevLine ? col - prevCol : col, name.length, type, 0];
    prevLine = line;
    prevCol = col;
    return entry;
}));
const none = () => ({ dispose() {} });
let provider;
let enumSettings = {};
const hoverQueries = [];
const enumHoverQueries = () => hoverQueries.filter(name => ['MODE_RUN', 'NEXT', 'IDLE', 'BUILD', 'FOLLOW'].includes(name)).sort();
const commands = {
    'vscode.provideDocumentSemanticTokensLegend': () => ({ tokenTypes: ['enumMember', 'function', 'variable'] }),
    'vscode.provideDocumentSemanticTokens': () => ({ data }),
    'vscode.executeDefinitionProvider': (_, position) => {
        const symbol = /^\w+/.exec(body.slice(doc.offsetAt(position)))?.[0];
        return [{ uri: doc.uri, range: { start: doc.positionAt(body.indexOf(symbol)) } }];
    },
    'vscode.executeHoverProvider': (_, position) => {
        const token = /^\w+/.exec(body.slice(doc.offsetAt(position)))[0];
        hoverQueries.push(token);
        const detail = { MODE_RUN: 'enum Mode::MODE_RUN = 16', NEXT: 'enum Mode::NEXT = 17',
            IDLE: 'enum Mode::IDLE = 0', result: 'int result', BUILD: 'enum BuildMode::BUILD = 40',
            FOLLOW: 'enum BuildMode::FOLLOW = 41' }[token];
        return [{ contents: [{ value: '\x60\x60\x60cpp\n' + detail + '\n\x60\x60\x60\nDocumentation' }] }];
    },
    'vscode.executeSignatureHelpProvider': (_, position) => {
        assert.equal(body.slice(doc.offsetAt(position), doc.offsetAt(position) + 4), '0x20');
        return { signatures: [{ label: 'int read_reg(unsigned addr, unsigned width)',
            parameters: [{ label: [13, 26] }, { label: 'unsigned width' }] }] };
    }
};
const vscode = {
    extensions: { getExtension: id => id === 'ms-vscode.cpptools' ? {} : undefined },
    Position, Range,
    EventEmitter: class { event() {} fire() {} dispose() {} },
    InlayHint: class { constructor(position, label) { Object.assign(this, { position, label }); } },
    commands: { registerCommand: none, executeCommand: async (name, ...args) => commands[name](...args) },
    workspace: {
        getConfiguration: () => ({ get: (key, fallback) => enumSettings[key] ?? fallback }),
        onDidSaveTextDocument: none, onDidChangeConfiguration: none
    },
};
const original = Module._load;
Module._load = (request, ...rest) => request === 'vscode' ? vscode : request === './render'
    ? { installRenderer: (_, __, instance) => { provider = instance; return none(); } }
    : original(request, ...rest);
const extension = require('../extension');
Module._load = original;
function region(start, end) {
    return { start: doc.positionAt(start), end: doc.positionAt(end),
        contains(pos) { return pos.compareTo(this.start) >= 0 && pos.compareTo(this.end) <= 0; } };
}
async function test() {
    extension.activate({ subscriptions: [] });
    const cancellation = { isCancellationRequested: false };
    const hints = await provider.provideInlayHints(doc, region(0, body.length), cancellation);
    const summary = hints.map(hint => (hint.position.line + 1) + ':' + hint.label);
    assert.deepEqual(summary, [
        '2:00', '2:16', '2:17', '5:[0]=', '5:.command=', '5:.handler=',
        '7:[4]=', '7:.command=', '7:.handler=', '9:: int',
        '9:addr:', '9:width:', '11:40', '11:41'
    ]);
    assert.deepEqual(enumHoverQueries(), ['BUILD', 'FOLLOW'],
        'declarations solved from source skip hover, while unresolved macros still use it');
    assert.equal(body.slice(doc.offsetAt(hints[1].position), doc.offsetAt(hints[1].position) + 8), 'MODE_RUN');
    assert.equal(body[doc.offsetAt(hints[3].position)], '{');
    assert.equal(hints[3].paddingRight, false);
    const visible = await provider.provideInlayHints(doc, region(offsets[6], offsets[7]), cancellation);
    assert.equal(visible[0].label, '[4]=');
    assert.equal(intel.enumValue([{ contents: [{ language: 'cpp', value: 'enum Mode::B = (1U << 3)' }] }], 'B'), undefined);
    assert.equal(intel.signatureInfo({ signatures: [{ label: 'void f(int n)' }, { label: 'void f(long n)' }] }, 'f'), undefined);
    const conditional = source.indexSource('int a[] = {\n#if BOARD\n 1,\n#endif\n2};');
    assert.equal(source.splitList(conditional.tokens, 5), undefined);
    const macro = source.indexSource('int a[] = {1, [START] = 2, 3};');
    const brace = macro.tokens.findIndex(t => t.value === '{');
    assert.deepEqual(source.arrayItems(macro.tokens, source.splitList(macro.tokens, brace)).map(x => x.index), [0n]);
    const enumeration = source.indexSource('enum F { A = -0x2L, B = 1 << 2, C = 010 };');
    assert.deepEqual(source.enumGroups(enumeration.tokens)[0].members.map(member => member.value), ['-2', '4', '8']);
    enumSettings = { enumValues: false, enumValueReferences: true, enumValuesHexadecimal: true };
    hoverQueries.length = 0;
    doc.version++;
    const references = await provider.provideInlayHints(doc, region(0, body.length), cancellation);
    assert.deepEqual(references.filter(hint => hint.enumValue).map(hint => [hint.position.line, hint.label]),
        [[4, '/* = 0x10 */'], [5, '/* = 0x11 */'], [6, '/* = 0 */'], [11, '/* = 41 */']]);
    assert.deepEqual(enumHoverQueries(), ['FOLLOW'],
        'references use the declaration value and only fall back to hover when it is unknown');
    enumSettings = {};
    doc.version++;
    commands['vscode.provideDocumentSemanticTokensLegend'] = () => undefined;
    const local = await provider.provideInlayHints(doc, region(0, body.length), cancellation);
    assert.deepEqual(local.filter(hint => hint.enumValue).map(hint => hint.label), ['00', '16', '17']);
    console.log(summary.join('\n'));
}
test().catch(error => { console.error(error); process.exitCode = 1; });
