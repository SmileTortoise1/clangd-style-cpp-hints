'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const binary = path.resolve(process.argv[2]);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-hint-ast-'));
try {
    const header = path.join(directory, 'flags.h');
    const file = path.join(directory, 'test.cpp');
    fs.writeFileSync(header, '#define BASE 0x10\n');
    fs.writeFileSync(file, 'int outdated;\n');
    const text = [
        '#include "flags.h"',
        '// 枚举和结构体',
        'typedef unsigned uint32_t;',
        'enum class A { First = BASE, Next };',
        'enum class B { Next = 7 };',
        'void dispatch(A mode, uint32_t size);',
        'struct Point { int x, y; };',
        'Point points[] = {{1, 2}, {3, 4}};',
        'auto test() {',
        '  auto n = 32u;',
        '  dispatch(A::Next, 4u);',
        '  return static_cast<int>(B::Next) + n;',
        '}'
    ].join('\n');
    const args = ['clang++', '-std=c++17', file];
    const found = spawnSync(binary, [], { cwd: directory, encoding: 'utf8',
        input: JSON.stringify({ file, directory, args, text, unsaved: { [header]: '#define BASE 0x20\n' } }) });
    assert.equal(found.status, 0, found.error?.message || found.stderr);
    const hints = JSON.parse(found.stdout);
    const enumReferences = hints.filter(hint => hint.kind === 'enum' && !hint.declaration);
    assert.deepEqual(enumReferences.map(hint => [hint.label, hint.hexadecimal]), [['33', true], ['7', false]]);
    assert(enumReferences.every(hint => Buffer.from(text).toString('utf8', hint.offset, hint.end) === 'Next'));
    assert.deepEqual(hints.filter(hint => hint.kind === 'parameter').map(hint => [hint.name, hint.type]),
        [['mode', 'A'], ['size', 'uint32_t']]);
    assert.deepEqual(hints.filter(hint => hint.kind === 'field').map(hint => hint.label),
        ['.x=', '.y=', '.x=', '.y=']);
    assert.deepEqual(hints.filter(hint => hint.kind === 'index').map(hint => hint.label), ['[0]=', '[1]=']);
    assert(hints.some(hint => hint.kind === 'deduced' && hint.label.startsWith('-> ')), 'deduced return');
    assert(hints.some(hint => hint.kind === 'deduced' && hint.label.startsWith(': ')), 'deduced variable');
    const cFile = path.join(directory, 'test.c');
    const resource = path.join(path.dirname(binary), 'resource');
    if (fs.existsSync(path.join(resource, 'include'))) {
        const c = '#include <stdint.h>\ntypedef enum { OFF, ON } Mode;\nvoid set_mode(Mode mode, uint32_t size);\nvoid run(void) { set_mode(ON, 5u); }\n';
        fs.writeFileSync(cFile, '');
        const result = spawnSync(binary, [], { cwd: directory, encoding: 'utf8',
            input: JSON.stringify({ file: cFile, directory, args: [
                'clang', '-std=c11', '--target=arm-none-eabi', '-ffreestanding', '-resource-dir=' + resource, cFile
            ], text: c }) });
        assert.equal(result.status, 0, result.error?.message || result.stderr);
        const cHints = JSON.parse(result.stdout);
        assert(cHints.some(hint => hint.kind === 'enum' && !hint.declaration && hint.label === '1'));
        assert(cHints.some(hint => hint.kind === 'parameter' && hint.name === 'size' && hint.type === 'uint32_t'));
    }
    console.log('PASS: real Clang AST, scoped enum binding, macro overlays, typedef parameter, inferred types and aggregate fields.');
} finally {
    for (const name of fs.readdirSync(directory)) { fs.unlinkSync(path.join(directory, name)); }
    fs.rmdirSync(directory);
}
