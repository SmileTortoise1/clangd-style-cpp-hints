'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const isArmcc = name => /(?:^|[/\\])armcc(?:\.exe)?$/i.test(name ?? '');
const norm = file => process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file);

// Compilation databases on Windows usually quote paths with spaces.
function splitCommand(command = '') {
    const tokens = [];
    const pattern = /(?:[^\s"']|"(?:\\["\\]|[^"])*"|'[^']*')+/g;
    for (const match of command.matchAll(pattern)) {
        tokens.push(match[0].replace(/"((?:\\["\\]|[^"])*)"|'([^']*)'/g,
            (_, double, single) => single ?? double.replace(/\\(["\\])/g, '$1')));
    }
    return tokens;
}

function armccFlags(args) {
    // Use clang's freestanding stdint.h on the ARM target rather than
    // including a hosted/desktop C runtime from the machine running VS Code.
    const flags = ['--target=arm-none-eabi', '-ffreestanding'];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (['-I', '-D', '-U', '-include', '-isystem', '--preinclude', '--cpu'].includes(arg)) {
            const value = args[i + 1];
            if (!value || value.startsWith('-')) { continue; }
            i++;
            if (arg === '--cpu') {
                if (/^cortex-[amr]\d+[a-z]*$/i.test(value)) { flags.push('-mcpu=' + value.toLowerCase()); }
            } else {
                flags.push(arg === '--preinclude' ? '-include' : arg, value);
            }
        } else if (/^-[IDU].+/.test(arg) || /^-std=/.test(arg)) {
            flags.push(arg);
        } else if (/^--cpu=cortex-[amr]\d+[a-z]*$/i.test(arg)) {
            flags.push('-mcpu=' + arg.slice(6).toLowerCase());
        } else if (arg.startsWith('--preinclude=')) {
            flags.push('-include', arg.slice(13));
        } else if (arg === '--c99' || arg === '--c90') {
            flags.push('-std=' + arg.slice(2));
        } else if (arg === '--cpp' || arg === '--cpp11') {
            flags.push('-x', 'c++');
            if (arg === '--cpp11') { flags.push('-std=c++11'); }
        }
    }
    return flags;
}

async function readJson(file, comments = false) {
    try {
        const info = await fs.stat(file);
        if (info.size > 16 * 1024 * 1024) { return undefined; }
        let text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
        if (comments) {
            text = text
                .replace(/"(?:\\[\s\S]|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
                    match => match.startsWith('"') ? match : '')
                .replace(/"(?:\\[\s\S]|[^"\\])*"|,\s*(?=[}\]])/g,
                    match => match.startsWith('"') ? match : '');
        }
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function absolute(value, root, file) {
    return value.replace(/\$\{workspace(?:Folder|Root)\}/g, () => root)
        .replace(/\$\{fileDirname\}/g, () => path.dirname(file))
        .replace(/\$\{env:([^}]+)\}/g, (match, name) => process.env[name] ?? match);
}

function expandPath(value, root, file) {
    const expanded = typeof value === 'string' && absolute(value, root, file);
    return expanded && !expanded.includes('\x24{') ? path.resolve(root, expanded.replace(/[/\\]\*\*?$/, '')) : undefined;
}

async function addArmccHeaders(flags, executable, root) {
    if (!isArmcc(executable)) { return; }
    const directory = path.resolve(root, path.dirname(executable), '..', 'include');
    try {
        if ((await fs.stat(directory)).isDirectory()) { flags.push('-isystem', directory); }
    } catch {
        // A bare "armcc" entry may be resolved through PATH during the real build.
    }
}

function ancestors(directory, root) {
    const result = [];
    for (let current = directory; ; current = path.dirname(current)) {
        result.push(current);
        if (norm(current) === norm(root) || current === path.dirname(current)) { break; }
    }
    return result;
}

async function clangdCommand(file, root, language, configurationName, extraFlags = [], tooling) {
    const properties = await readJson(path.join(root, '.vscode', 'c_cpp_properties.json'), true);
    const configurations = properties?.configurations ?? [];
    const selected = configurationName
        ? configurations.find(entry => entry.name === configurationName)
        : configurations.length === 1 ? configurations[0] : undefined;
    const databases = Array.isArray(selected?.compileCommands)
        ? selected.compileCommands : [selected?.compileCommands];
    const parents = ancestors(path.dirname(file), root);
    const candidates = new Set([
        ...(tooling?.databaseDirectory ? [path.join(tooling.databaseDirectory, 'compile_commands.json')] : []),
        ...databases.map(db => expandPath(db, root, file)).filter(Boolean),
        ...parents.map(dir => path.join(dir, 'compile_commands.json')),
        ...parents.map(dir => path.join(dir, 'build', 'compile_commands.json'))
    ]);
    for (const database of candidates) {
        const entries = await readJson(database);
        if (!Array.isArray(entries)) { continue; }
        const fileFor = item => item?.file && item.directory && path.resolve(path.dirname(database), item.directory, item.file);
        const entry = entries.find(item => fileFor(item) && norm(fileFor(item)) === norm(file));
        if (!entry) { continue; }
        const workingDirectory = path.resolve(path.dirname(database), entry.directory);
        const args = Array.isArray(entry.arguments) ? entry.arguments : splitCommand(entry.command);
        if (!args.length) { continue; }
        if (!isArmcc(args[0])) {
            if (tooling) {
                return { command: { workingDirectory, compilationCommand: args } };
            }
            return {};  // Let clangd load an existing native compilation database.
        }
        const flags = armccFlags(args.slice(1));
        await addArmccHeaders(flags, args[0], workingDirectory);
        return { command: { workingDirectory, compilationCommand: [
            language === 'cpp' ? 'clang++' : 'clang', ...flags, ...extraFlags, file
        ] } };
    }
    if (!selected && configurations.length > 1 && !extraFlags.length) {
        return { ambiguous: true };
    }
    if (!selected) {
        if (tooling) {
            for (const directory of [tooling.databaseDirectory, ...parents].filter(Boolean)) {
                try {
                    const flags = (await fs.readFile(path.join(directory, 'compile_flags.txt'), 'utf8'))
                        .replace(/^\uFEFF/, '').split(/\r?\n/).map(flag => flag.trim()).filter(Boolean);
                    return { command: { workingDirectory: directory, compilationCommand: [
                        language === 'cpp' ? 'clang++' : 'clang', '-x', language === 'cpp' ? 'c++' : 'c', ...flags, ...extraFlags, file
                    ] } };
                } catch (error) {
                    if (error.code !== 'ENOENT') { throw error; }
                }
            }
        }
        return {};  // Preserve clangd's normal fallback, including any .clangd config.
    }
    if (!isArmcc(selected.compilerPath) && !selected.includePath?.length && !selected.defines?.length) {
        return {};
    }
    const directory = root;
    const target = /-arm$/i.test(selected.intelliSenseMode ?? '') ? 'arm-none-eabi'
        : /-arm64$/i.test(selected.intelliSenseMode ?? '') ? 'aarch64-none-elf' : undefined;
    const flags = isArmcc(selected.compilerPath) ? armccFlags(selected.compilerArgs ?? [])
        : target ? ['--target=' + target] : [];
    for (const include of selected.includePath ?? []) {
        const resolved = expandPath(include, root, file);
        if (resolved) { flags.push('-I', resolved); }
    }
    for (const definition of selected.defines ?? []) {
        const resolved = absolute(definition, root, file);
        if (!resolved.includes('\x24{')) { flags.push('-D' + resolved); }
    }
    for (const header of selected.forcedInclude ?? []) {
        const resolved = expandPath(header, root, file);
        if (resolved) { flags.push('-include', resolved); }
    }
    const standard = language === 'cpp' ? selected.cppStandard : selected.cStandard;
    if (standard && !standard.includes('\x24{')) { flags.push('-std=' + standard); }
    await addArmccHeaders(flags, absolute(selected.compilerPath ?? '', root, file), root);
    return { command: { workingDirectory: directory, compilationCommand: [
        language === 'cpp' ? 'clang++' : 'clang', ...flags, ...extraFlags, file
    ] } };
}

module.exports = { clangdCommand, armccFlags, splitCommand };
