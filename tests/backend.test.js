'use strict';

const assert = require('node:assert/strict');
const { ClangdHints } = require('../clangd-hints');
const { editorOffsets } = require('../ast-hints');
const manifest = require('../package.json');

async function main() {
    let enabled = true;
    let preferClangd = true;
    let installed = true;
    let running = true;
    let requests = 0;
    let stateListener;
    let changes = 0;
    const client = {
        isRunning: () => running,
        onDidChangeState(listener) { stateListener = listener; return { dispose() {} }; },
        async sendRequest() { requests++; return []; }
    };
    const vscode = {
        workspace: {
            isTrusted: true,
            getConfiguration: section => ({
                get: (key, fallback) => section === 'clangd' && key === 'enable' ? enabled
                    : key === 'useClangd' ? preferClangd : fallback
            })
        },
        extensions: {
            getExtension(id) {
                assert.equal(id, 'llvm-vs-code-extensions.vscode-clangd');
                return installed && { isActive: true, exports: { getApi: () => ({ languageClient: client }) } };
            }
        }
    };
    const clangd = new ClangdHints(vscode, () => {}, () => { changes++; });
    const document = { uri: { scheme: 'file' } };
    const server = await clangd.open(document, {});
    assert.deepEqual(await server.request('textDocument/inlayHint', {}), []);
    stateListener();
    assert.equal(changes, 1);
    running = false;
    assert.equal(await clangd.open(document, {}), undefined);
    running = true;
    enabled = false;
    assert.equal(await clangd.open(document, {}), undefined);
    enabled = true;
    preferClangd = false;
    assert.equal(await clangd.open(document, {}), undefined);
    preferClangd = true;
    installed = false;
    assert.equal(await clangd.open(document, {}), undefined);
    assert.equal(requests, 1);
    assert.deepEqual(manifest.extensionDependencies ?? [], []);
    const text = '// 中文😀\nA';
    const byte = Buffer.byteLength(text.slice(0, -1));
    assert.deepEqual(editorOffsets(text, [{ offset: byte, end: byte + 1 }]),
        [{ offset: text.length - 1, end: text.length }]);
    console.log('PASS: optional clangd client, disabled/unavailable fallback, and UTF-16 editor offsets.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
