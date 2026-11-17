'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { indexSource, enumGroups } = require('../source');
const { enumContext, formatEnumHints } = require('../enum-hints');
const { decorationOptions } = require('../render');
const text = [
    'typedef enum {',
    '   SMB_STATUS_OK = 0x00,',
    '   SMB_STATUS_PARAM = 0x07,',
    '   SMB_STATUS_STOP_RX,',
    '   SMB_STATUS_STOP_TX,',
    '   SMB_STATUS_ERRBASE = 0x80,',
    '   SMB_STATUS_OVERFLOW = SMB_STATUS_ERRBASE + 0x1,',
    '   SMB_STATUS_ERRCNTR = SMB_STATUS_ERRBASE + 0x2,',
    '   SMB_STATUS_LOST = SMB_STATUS_ERRBASE + 0x4,',
    '   SMB_STATUS_BUSERR = SMB_STATUS_ERRBASE + 0x8,',
    '   SMB_STATUS_TIMEOUT = SMB_STATUS_ERRBASE + 0x10,',
    '} SMB_STATUS_T;',
    'typedef enum { MST_CLK_100K, MST_CLK_400K, MST_CLK_1M } SMB_MST_CLK_T;',
    'enum E { A = FLAG, B, C = (1U << 3) | 1, D, E_NEG = -1U };',
    'enum F {',
    '#ifdef FLAG',
    'F_A,',
    '#endif',
    'F_B',
    '};'
].join('\n');
const result = enumGroups(indexSource(text).tokens).flatMap(group => group.members)
    .filter(member => member.value !== undefined).map(({ offset, value }) => [text.slice(offset).match(/^\w+/)[0], value]);
assert.deepEqual(Object.fromEntries(result), {
    SMB_STATUS_OK: '0', SMB_STATUS_PARAM: '7', SMB_STATUS_STOP_RX: '8', SMB_STATUS_STOP_TX: '9',
    SMB_STATUS_ERRBASE: '128', SMB_STATUS_OVERFLOW: '129', SMB_STATUS_ERRCNTR: '130',
    SMB_STATUS_LOST: '132', SMB_STATUS_BUSERR: '136', SMB_STATUS_TIMEOUT: '144',
    MST_CLK_100K: '0', MST_CLK_400K: '1', MST_CLK_1M: '2', C: '9', D: '10'
});

const mix = 'enum Mixed { First, Base = 0x07, Next, Decimal = 19, Last };';
const mixedMembers = enumGroups(indexSource(mix).tokens)[0].members;
assert.deepEqual(mixedMembers.map(({ hexadecimal }) => hexadecimal), [false, true, true, false, false]);

const header = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8').replace(/\r\n/g, '\n') : text;
const lines = header.split('\n');
const starts = [0];
for (const line of lines.slice(0, -1)) { starts.push(starts.at(-1) + line.length + 1); }
const document = {
    lineAt: line => ({ text: lines[line] }),
    positionAt(offset) {
        const line = starts.findLastIndex(start => start <= offset);
        return { line, character: offset - starts[line] };
    }
};
const groups = enumGroups(indexSource(header).tokens);
const options = { enumValues: true, enumValuePlacement: 'inlineComment' };
function label(name, hex) {
    const member = groups.flatMap(group => group.members).find(item => item.name === name);
    assert(member, name);
    const line = document.positionAt(member.offset).line;
    const context = enumContext(groups, starts[line], starts[line] + lines[line].length, { ...options, enumValuesHexadecimal: hex });
    return formatEnumHints(document, context, [], []).find(hint => hint.position.line === line)?.label;
}
assert.equal(label('SMB_STATUS_STOP_RX', true), '// = 0x08');
assert.equal(label('SMB_STATUS_STOP_TX', true), '// = 0x09');
assert.equal(label('SMB_STATUS_STOP_RX', false), '// = 008');
assert.equal(label('MST_CLK_100K', true), label('MST_CLK_100K', false));
console.log('PASS: SMBUS results and formatting, hexadecimal inheritance, decimal reset, and an unaffected decimal enum.');

function completionSample(text, flags = {}, semantic = [], visibleLine) {
    const lines = text.split('\n');
    const starts = [0];
    for (const line of lines.slice(0, -1)) { starts.push(starts.at(-1) + line.length + 1); }
    const doc = {
        lineCount: lines.length,
        lineAt: line => ({ text: lines[line] }),
        offsetAt: ({ line, character }) => starts[line] + character,
        positionAt(offset) {
            const line = starts.findLastIndex(start => start <= offset);
            return { line, character: offset - starts[line] };
        }
    };
    const start = visibleLine === undefined ? 0 : starts[visibleLine];
    const end = visibleLine === undefined ? text.length : start + lines[visibleLine].length;
    const context = enumContext(enumGroups(indexSource(text).tokens), start, end,
        { enumValues: true, enumValuePlacement: 'implicitAssignment', ...flags });
    const values = semantic.map(({ name, label }) => ({ position: doc.positionAt(text.indexOf(name)),
        label, length: name.length, declaration: true }));
    return { doc, hints: formatEnumHints(doc, context, values, []) };
}

const oneLine = 'enum E {a=0,b,c};';
const decorationApi = { Range: class {}, ThemeColor: class { constructor(id) { this.id = id; } } };
const compact = completionSample(oneLine);
assert.deepEqual(compact.hints.map(hint => hint.label), ['=1', '=2']);
assert.deepEqual(compact.hints.map(hint => oneLine[hint.position.character]), [',', '}']);
assert(compact.hints.every(hint => hint.marginColumns === 0));
const rendered = decorationOptions(decorationApi, compact.doc, compact.hints);
assert.deepEqual(rendered.map(item => item.renderOptions.before.contentText), ['=1', '=2']);
assert(rendered.every(item => item.renderOptions.before.color.id === 'editorInlayHint.foreground' &&
    item.renderOptions.before.backgroundColor.id === 'editorInlayHint.background'));

const multiline = completionSample('enum class E {\n\tA\t  =  0,\n\tB,\n\tCC,\n};');
assert.deepEqual(multiline.hints.map(hint => hint.label), ['=  1', '=  2']);
assert.deepEqual(multiline.hints.map(hint => hint.marginColumns), [5, 4]);
const radix = completionSample('enum E { FIRST, BASE = 0x007, NEXT, DECIMAL=19, LAST };', { enumValuesHexadecimal: true });
assert.deepEqual(radix.hints.map(hint => hint.label), ['= 0', '= 0x008', '=20']);
const fromSemantic = completionSample('enum E { INITIAL=BASE, NEXT, LAST=100 };', {}, [
    { name: 'INITIAL', label: '12' }, { name: 'NEXT', label: '13' }, { name: 'LAST', label: '100' }
]);
assert.deepEqual(fromSemantic.hints.map(hint => hint.label), ['=13']);
assert.deepEqual(completionSample('enum E { A=BASE, B };').hints, []);
assert.deepEqual(completionSample('enum E { A, B };').hints.map(hint => hint.label), ['= 0', '= 1']);
assert.deepEqual(completionSample(oneLine, { enumValues: false }).hints, []);
console.log('PASS: compact and multi-line implicit assignments, preserved hexadecimal style, and semantic-value fallback.');

function displayColumns(text, tabSize = 4) {
    return [...text].reduce((column, char) => column + (char === '\t' ? tabSize - column % tabSize : 1), 0);
}
function alignedColumns({ doc, hints }) {
    const equals = new Set();
    const commas = new Set();
    const commentShifts = new Set();
    for (const hint of hints) {
        const text = doc.lineAt(hint.position.line).text;
        const nameEnd = displayColumns(text.slice(0, hint.position.character));
        const equalsColumn = nameEnd + hint.marginColumns;
        equals.add(equalsColumn);
        if (text[hint.position.character] === ',') { commas.add(equalsColumn + hint.widthColumns); }
        if (text.includes('//')) {
            const addedColumns = hint.marginColumns + hint.widthColumns;
            const shift = addedColumns + (hint.suffixSpacing?.columns ?? 0);
            if (hint.suffixSpacing) { assert.equal(text[hint.suffixSpacing.position.character - 1], ','); }
            commentShifts.add(shift);
        }
    }
    return { equals: [...equals], commas: [...commas], commentShifts: [...commentShifts] };
}

const alignedText = ['enum E {', ...Array.from({ length: 11 }, (_, i) =>
    '\t' + (i === 5 ? 'LONGEST_MEMBER' : 'A' + i) + ',\t\t\t\t\t\t\t// ' + i), '};'].join('\n');
const aligned = completionSample(alignedText);
assert.deepEqual(alignedColumns(aligned), { equals: [19], commas: [23], commentShifts: [0] });
assert.deepEqual(alignedColumns(completionSample(alignedText, {}, [], 1)), alignedColumns(aligned));
assert.equal(aligned.hints[0].label, '= 0');
assert.equal(aligned.hints[10].label, '= 10');
const decorated = decorationOptions(decorationApi, aligned.doc, aligned.hints);
assert.equal(decorated[0].renderOptions.before.width, '4ch');
assert.equal(decorated[11].renderOptions.before.width, '0ch');
assert.match(decorated[11].renderOptions.before.margin, /^0 -\d+ch 0 0$/);
const tight = completionSample('enum E {\n\tA,\t// a\n\tLONG_NAME,\t// b\n};');
const tightColumns = alignedColumns(tight);
assert.equal(tightColumns.equals.length, 1);
assert.equal(tightColumns.commas.length, 1);
assert.equal(tightColumns.commentShifts.length, 1);
assert(tightColumns.commentShifts[0] > 0 && tightColumns.commentShifts[0] % 4 === 0);
if (process.argv[3]) {
    const sbsd = completionSample(fs.readFileSync(process.argv[3], 'utf8').replace(/\r\n/g, '\n'));
    const sbs = { doc: sbsd.doc, hints: sbsd.hints.filter(hint => /^\s*SBS/.test(sbsd.doc.lineAt(hint.position.line).text)) };
    assert(sbs.hints.length >= 50);
    const columns = alignedColumns(sbs);
    assert.equal(columns.equals.length, 1);
    assert.equal(columns.commas.length, 1);
    assert.deepEqual(columns.commentShifts, [0]);
}
console.log('PASS: aligned implicit equals and commas, preserved comment columns, and uniform movement for tight gaps.');
