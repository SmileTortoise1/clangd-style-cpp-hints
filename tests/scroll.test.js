'use strict';
const assert = require('node:assert/strict');
const { decorationOptions, installRenderer } = require('../render');

class Position {
    constructor(line, character) { Object.assign(this, { line, character }); }
}
class Range {
    constructor(a, b, c, d) {
        this.start = a instanceof Position ? a : new Position(a, b);
        this.end = b instanceof Position ? b : new Position(c, d);
    }
}
const document = {
    languageId: 'c', version: 1, lineCount: 450,
    lineAt: line => ({ text: 'ENUM_MEMBER', range: new Range(line, 0, line, 11) })
};
const painted = [];
const changes = [];
const editor = {
    document, visibleRanges: [new Range(42, 0, 56, 11)],
    setDecorations(_, actual) { painted.push(actual); }
};
const noop = () => ({ dispose() {} });
class ThemeColor {
    constructor(id) { this.id = id; }
}
let scroll;
let edit;
let refresh;
let release;
let enabled = true;
const vscode = {
    Range, ThemeColor, DecorationRangeBehavior: { ClosedClosed: 1 },
    window: {
        createTextEditorDecorationType: noop,
        visibleTextEditors: [editor], onDidChangeVisibleTextEditors: noop,
        onDidChangeTextEditorVisibleRanges: handler => { scroll = handler; return noop(); }
    },
    workspace: {
        getConfiguration: section => ({ get: (key, fallback) =>
            section === 'clangdStyleCppHints' && key === 'enabled' ? enabled : fallback }),
        onDidChangeTextDocument: handler => { edit = handler; return noop(); },
        onDidChangeConfiguration: noop
    }
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready(predicate) {
    for (let i = 0; i < 80; i++) {
        if (predicate()) { return; }
        await pause(15);
    }
    throw new Error('Timed out waiting for render');
}

async function main() {
    const hints = decorationOptions(vscode, document, [
        { position: new Position(42, 2), label: '01', enumValue: true, paddingRight: true },
        { position: new Position(42, 2), label: 'uint32_t size:', hintKind: 'parameter', paddingRight: true },
        { position: new Position(42, 4), label: '.command=', hintKind: 'field' },
        { position: new Position(42, 6), label: '[0]=', hintKind: 'index' },
        { position: new Position(42, 8), label: 'mode:', kind: 2 }
    ]).map(item => item.renderOptions.before);
    assert.deepEqual(hints.map(item => [item.contentText, item.color?.id, item.backgroundColor?.id]), [
        ['uint32_t size:', 'editorInlayHint.parameterForeground', 'editorInlayHint.parameterBackground'],
        ['01', 'editorInlayHint.foreground', 'editorInlayHint.background'],
        ['.command=', 'editorInlayHint.foreground', 'editorInlayHint.background'],
        ['[0]=', 'editorInlayHint.foreground', 'editorInlayHint.background'],
        ['mode:', 'editorInlayHint.parameterForeground', 'editorInlayHint.parameterBackground']
    ]);
    assert.equal(hints[1].margin, '0 0.35em 0 1ch');
    const renderer = installRenderer(vscode, handler => { refresh = handler; return noop(); }, {
        async provideInlayHints(doc, range) {
            changes.push([doc.version, range.start.line, range.end.line]);
            if (doc.version === 2 && changes.length === 2) {
                await new Promise(resolve => { release = resolve; });
            }
            return [65, 70, 352].filter(line => line >= range.start.line && line <= range.end.line)
                .map(line => ({ position: new Position(line, 0), label: String(doc.version), paddingRight: true }));
        }
    });
    try {
        await ready(() => painted.length === 1);
        assert.equal(changes[0][1], 0);
        assert(changes[0][2] > 120);
        assert(painted[0].some(item => item.range.start.line === 70));

        editor.visibleRanges = [new Range(62, 0, 78, 11)];
        scroll({ textEditor: editor });
        await pause(110);
        assert.equal(changes.length, 1, 'Scrolling into preloaded lines should reuse the same labels');
        assert.equal(painted.length, 1);

        document.version++;
        edit({ document, contentChanges: [{}] });
        await ready(() => release);
        assert.equal(painted.length, 1, 'Editing must retain the previous labels while computing new ones');
        release();
        await ready(() => painted.length === 2);
        assert(painted[1].every(item => item.renderOptions.before.contentText === '2'));

        editor.visibleRanges = [new Range(340, 0, 365, 11)];
        scroll({ textEditor: editor });
        await ready(() => painted.length === 3);
        assert(painted[2].some(item => item.range.start.line === 70));
        assert(painted[2].some(item => item.range.start.line === 352));
        assert(painted.every(batch => batch.length > 0));

        enabled = false;
        refresh();
        assert.deepEqual(painted.at(-1), []);
        console.log('PASS: theme colors, mixed labels, stable edits, preloaded scrolling, and explicit disable.');
    } finally {
        renderer.dispose();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
