'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { clangdCommand } = require('./clangd-config');

function runTool(binary, input, job, log) {
    return new Promise(resolve => {
        if (job.cancelled) { resolve(undefined); return; }
        const child = spawn(binary, [], { cwd: input.directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let size = 0;
        const chunks = [];
        let diagnostics = '';
        let done = false;
        const finish = result => {
            if (done) { return; }
            done = true;
            clearTimeout(timer);
            resolve(result);
        };
        job.stop = () => {
            job.cancelled = true;
            child.kill();
            finish(undefined);
        };
        const timer = setTimeout(() => {
            log('LibTooling timed out.');
            job.stop();
        }, 4500);
        child.once('error', error => { log('LibTooling: ' + error.message); finish(undefined); });
        child.stdin.on('error', () => {});
        child.stderr.on('data', chunk => { if (diagnostics.length < 2048) { diagnostics += chunk.toString(); } });
        child.stdout.on('data', chunk => {
            size += chunk.length;
            if (size <= 8 * 1024 * 1024) { chunks.push(chunk); }
            else { job.stop(); }
        });
        child.once('close', code => {
            if (done) { return; }
            if (code !== 0) {
                log('LibTooling stopped (' + code + '): ' + diagnostics.trim().slice(0, 500));
                finish(undefined);
                return;
            }
            try {
                const result = JSON.parse(Buffer.concat(chunks).toString());
                finish(Array.isArray(result) ? result : undefined);
            } catch {
                log('LibTooling returned an invalid response.');
                finish(undefined);
            }
        });
        child.stdin.end(JSON.stringify(input));
    });
}

// Clang offsets are UTF-8 byte offsets, while VS Code uses UTF-16 code units.
function editorOffsets(text, items) {
    const bytes = Buffer.from(text);
    const offsets = [...new Set(items.flatMap(item => [item?.offset, item?.end]))]
        .filter(value => Number.isSafeInteger(value) && value >= 0 && value <= bytes.length)
        .sort((a, b) => a - b);
    const positions = new Map();
    let last = 0;
    let units = 0;
    for (const offset of offsets) {
        units += bytes.toString('utf8', last, offset).length;
        positions.set(offset, units);
        last = offset;
    }
    return items.flatMap(item => positions.has(item?.offset)
        ? [{ ...item, offset: positions.get(item.offset), end: positions.get(item.end) }] : []);
}

function compilationDatabaseDirectory(args, root) {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const directory = arg === '--compile-commands-dir' ? args[i + 1]
            : arg.startsWith('--compile-commands-dir=') ? arg.slice('--compile-commands-dir='.length) : undefined;
        if (directory) { return path.resolve(root, directory.replaceAll('${workspaceFolder}', root)); }
    }
}

async function clangdOverridesCompileFlags(file) {
    const userConfig = process.platform === 'win32' ? process.env.LOCALAPPDATA
        : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Preferences')
            : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const files = userConfig ? [path.join(userConfig, 'clangd', 'config.yaml')] : [];
    for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
        files.push(path.join(directory, '.clangd'));
        if (directory === path.dirname(directory)) { break; }
    }
    const results = await Promise.all(files.map(async config => {
        try {
            const text = await fs.readFile(config, 'utf8');
            return /\bCompileFlags['"]?\s*:/.test(text);
        } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') { throw error; }
            return false;
        }
    }));
    return results.includes(true);
}

class AstHints {
    constructor(vscode, extensionPath, log) {
        this.vscode = vscode;
        this.log = log;
        this.jobs = new Map();
        this.directory = path.join(extensionPath, 'native', process.platform + '-' + process.arch);
        this.binary = path.join(this.directory, process.platform === 'win32' ? 'cpp-hint-ast.exe' : 'cpp-hint-ast');
        this.available = fs.access(this.binary).then(() => true, () => false);
    }

    hints(document) {
        const previous = this.jobs.get(document);
        if (previous?.version === document.version) { return previous.answer; }
        this.close(document);
        const job = { version: document.version, stop() { job.cancelled = true; } };
        job.answer = this.parse(document, job).catch(error => {
            this.log('LibTooling: ' + error.message);
            return undefined;
        });
        this.jobs.set(document, job);
        return job.answer;
    }

    async parse(document, job) {
        if (!await this.available || job.cancelled || document.version !== job.version) { return undefined; }
        const { workspace } = this.vscode;
        const file = document.uri.fsPath;
        const folder = workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
        const root = folder ?? path.dirname(file);
        const settings = workspace.getConfiguration('clangdStyleCppHints', document);
        const clangd = workspace.getConfiguration('clangd', document);
        const flags = settings.get('clangdFallbackFlags', []);
        const clangdArguments = clangd.get('arguments', []);
        if (!clangdArguments.includes('--enable-config=false') && await clangdOverridesCompileFlags(file)) {
            // clangd applies YAML fragments and flag removal rules before parsing.
            // Reuse its semantic results when the companion cannot use the same command.
            return undefined;
        }
        const databaseDirectory = compilationDatabaseDirectory(clangdArguments, root);
        const { command, ambiguous } = await clangdCommand(file, root, document.languageId,
            settings.get('clangdConfiguration', ''), flags, { databaseDirectory });
        if (ambiguous || job.cancelled || document.version !== job.version) { return undefined; }
        const directory = command?.workingDirectory ?? root;
        const language = document.languageId === 'cpp' ? 'c++' : 'c';
        const args = [...(command?.compilationCommand ?? [
            language === 'c++' ? 'clang++' : 'clang', '-x', language, ...clangd.get('fallbackFlags', []), ...flags, file
        ])];
        const unsaved = Object.create(null);
        for (const other of workspace.textDocuments) {
            if (other !== document && other.isDirty && other.uri.scheme === 'file' &&
                (other.languageId === 'c' || other.languageId === 'cpp')) {
                unsaved[other.uri.fsPath] = other.getText();
            }
        }
        const text = document.getText();
        const resource = path.join(this.directory, 'resource');
        if (await fs.access(path.join(resource, 'include')).then(() => true, () => false) &&
            !args.some(arg => arg === '-resource-dir' || arg.startsWith('-resource-dir='))) {
            args.splice(1, 0, '-resource-dir=' + resource);
        }
        const result = await runTool(this.binary, { file, directory, args, text, unsaved }, job, this.log);
        return result && editorOffsets(text, result);
    }

    close(document) {
        this.jobs.get(document)?.stop();
        this.jobs.delete(document);
    }

    dispose() {
        for (const document of this.jobs.keys()) { this.close(document); }
    }
}

module.exports = { AstHints, editorOffsets };
