'use strict';

const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

function documentUri(document) {
    return pathToFileURL(document.uri.fsPath).href;
}

class ClangdClient {
    constructor(binary, root, fallbackFlags = [], log = () => {}) {
        this.log = log;
        this.documents = new Map();
        this.pending = new Map();
        this.input = Buffer.alloc(0);
        this.sequence = 0;
        this.closed = false;
        this.child = spawn(binary, ['--background-index=false', '--clang-tidy=false', '--log=error'], {
            cwd: root?.fsPath, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
        });
        this.child.once('error', error => this.fail(error.message));
        this.child.once('exit', (code, signal) => this.fail('clangd exited (' + (signal ?? code) + ')'));
        this.child.stdin.on('error', error => this.fail(error.message));
        this.child.stdout.on('data', chunk => this.receive(chunk));
        this.child.stderr.on('data', chunk => this.log(chunk.toString().trimEnd()));
        const rootUri = root?.uri ?? null;
        this.ready = this.request('initialize', {
            processId: process.pid,
            rootUri,
            workspaceFolders: rootUri ? [{ uri: rootUri, name: root.name }] : null,
            capabilities: {
                general: { positionEncodings: ['utf-16'] },
                textDocument: {
                    hover: { contentFormat: ['markdown'] },
                    signatureHelp: { signatureInformation: { parameterInformation: { labelOffsetSupport: true } } }
                }
            },
            initializationOptions: { fallbackFlags }
        }, 5000).then(result => {
            if (result) {
                this.capabilities = result.capabilities ?? {};
                this.notify('initialized', {});
            } else {
                this.dispose();
            }
            return Boolean(result);
        });
    }

    send(message) {
        if (this.closed) { return; }
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
        this.child.stdin.write(Buffer.concat([
            Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body
        ]));
    }

    notify(method, params) {
        this.send({ method, params });
    }

    request(method, params, timeout = 3500) {
        if (this.closed) { return Promise.resolve(undefined); }
        return new Promise(resolve => {
            const id = ++this.sequence;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                this.notify('$/cancelRequest', { id });
                resolve(undefined);
            }, timeout);
            this.pending.set(id, message => {
                clearTimeout(timer);
                if (message?.error && message.error.code !== -32800) {
                    this.log(method + ': ' + message.error.message);
                }
                resolve(message?.result);
            });
            this.send({ id, method, params });
        });
    }

    receive(chunk) {
        this.input = Buffer.concat([this.input, chunk]);
        if (this.input.length > 32 * 1024 * 1024) {
            this.fail('clangd response exceeded 32 MiB');
            return;
        }
        while (this.input.length) {
            const header = this.input.indexOf('\r\n\r\n');
            if (header === -1) { return; }
            const size = Number(/Content-Length: *(\d+)/i.exec(this.input.subarray(0, header).toString())?.[1]);
            if (!Number.isSafeInteger(size) || size > 32 * 1024 * 1024) {
                this.fail('Invalid clangd response length');
                return;
            }
            if (this.input.length < header + 4 + size) { return; }
            const body = this.input.subarray(header + 4, header + 4 + size);
            this.input = this.input.subarray(header + 4 + size);
            try {
                const message = JSON.parse(body.toString());
                if (message.method && message.id !== undefined) {
                    const result = message.method === 'workspace/configuration'
                        ? (message.params.items ?? []).map(() => null) : null;
                    this.send({ id: message.id, result });
                } else if (message.method === 'textDocument/publishDiagnostics') {
                    this.diagnostics ??= new Map();
                    this.diagnostics.set(message.params.uri, message.params);
                } else if (message.id !== undefined) {
                    const complete = this.pending.get(message.id);
                    this.pending.delete(message.id);
                    complete?.(message);
                }
            } catch (error) {
                this.log('Invalid clangd message: ' + error.message);
            }
        }
    }

    async update(document, command) {
        if (!await this.ready || this.closed || document.isClosed) { return false; }
        const uri = documentUri(document);
        const previous = this.documents.get(uri);
        const version = document.version;
        if (previous === version) { return true; }
        if (command && previous === undefined) {
            this.notify('workspace/didChangeConfiguration', {
                settings: { compilationDatabaseChanges: { [document.uri.fsPath]: command } }
            });
        }
        const text = document.getText();
        if (previous === undefined) {
            this.notify('textDocument/didOpen', {
                textDocument: { uri, languageId: document.languageId, version, text }
            });
        } else {
            this.notify('textDocument/didChange', {
                textDocument: { uri, version }, contentChanges: [{ text }]
            });
        }
        this.documents.set(uri, version);
        return true;
    }

    close(document) {
        if (document.uri.scheme !== 'file') { return; }
        const uri = documentUri(document);
        this.diagnostics?.delete(uri);
        if (this.documents.delete(uri)) {
            this.notify('textDocument/didClose', { textDocument: { uri } });
        }
    }

    fail(reason) {
        if (!this.closed) { this.log(reason); }
        this.dispose();
    }

    dispose() {
        if (this.closed) { return; }
        this.closed = true;
        for (const complete of this.pending.values()) { complete(); }
        this.pending.clear();
        this.documents.clear();
        this.diagnostics?.clear();
        if (this.child.exitCode === null && this.child.signalCode === null) {
            this.child.kill();
        }
    }
}

module.exports = { ClangdClient, documentUri };
