'use strict';

function enumContext(groups, start, end, options) {
    const visibleGroups = groups.filter(group => group.start <= end && group.end >= start);
    const declarations = new Map();
    for (const group of visibleGroups) {
        for (const member of group.members) {
            declarations.set(member.offset, { ...member, declaration: true, group });
        }
    }
    const visible = offset => offset >= start && offset <= end;
    const completeImplicit = options.enumValuePlacement === 'implicitAssignment';
    function candidate(offset, length, semanticDeclaration) {
        const member = declarations.get(offset);
        const declaration = Boolean(member || semanticDeclaration);
        if (declaration) {
            if (!options.enumValues || (completeImplicit && !member?.implicit)) { return undefined; }
            const group = member?.group ?? visibleGroups.find(item => offset > item.start && offset < item.end);
            // The widest member determines the padding even outside the viewport.
            if (visible(offset) || (group && (!completeImplicit || member?.value === undefined))) {
                return member ?? { offset, end: offset + length, after: offset + length, declaration, group };
            }
        } else if (options.enumValueReferences && visible(offset)) {
            return { offset, end: offset + length, declaration };
        }
    }
    return { declarations, candidate, visible, options };
}

// LSP stores modifiers in the last element of each semantic token tuple.
function declarationModifier(legend) {
    return (legend?.tokenModifiers ?? []).reduce((mask, modifier, i) =>
        modifier === 'declaration' || modifier === 'definition' ? mask | (1 << i) : mask, 0);
}

function enumInteger(value) {
    if (typeof value !== 'string' || value.length > 130) { return undefined; }
    const match = /^([+-]?)(0x[\da-f](?:'?[\da-f])*|0b[01](?:'?[01])*|\d(?:'?\d)*)(?:[ulz]{0,3})$/i.exec(value.trim());
    if (!match) { return undefined; }
    let digits = match[2].replace(/'/g, '');
    if (/^0[0-7]+$/.test(digits)) { digits = '0o' + digits.slice(1); }
    const number = BigInt(digits);
    return match[1] === '-' ? -number : number;
}

function numberParts(value, hexadecimal) {
    const prefix = (value < 0n ? '-' : '') + (hexadecimal ? '0x' : '');
    const digits = (value < 0n ? -value : value).toString(hexadecimal ? 16 : 10).toUpperCase();
    return { prefix, digits };
}

function declarationLine(document, member, tabSize) {
    const at = document.positionAt(member.after);
    const text = document.lineAt(at.line).text;
    const suffix = text.slice(at.character);
    const tail = suffix.trim();
    if (tail && !/^(?:\/\/.*|(?:\/\*(?:(?!\*\/).)*\*\/\s*)+)$/.test(tail)) { return undefined; }
    const column = visualWidth(text.slice(0, at.character), tabSize);
    if (!tail) { return { position: at, column }; }
    const commentOffset = member.after + suffix.search(/\S/);
    const comment = document.positionAt(commentOffset);
    return { position: at, column, comment, commentColumn: visualWidth(text.slice(0, comment.character), tabSize),
        tabsBeforeComment: suffix.slice(0, comment.character - at.character).includes('\t') };
}

function visualWidth(text, tabSize) {
    let column = 0;
    for (const char of text) {
        if (char === '\t') { column += tabSize - column % tabSize; }
        else if (!/\p{Mark}/u.test(char)) { column += /[\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60]/u.test(char) ? 2 : 1; }
    }
    return column;
}

function assignmentStyle(document, member, tabSize) {
    const start = document.positionAt(member.offset);
    const nameEnd = document.positionAt(member.end);
    const equals = document.positionAt(member.assignment.equalsOffset);
    const line = document.lineAt(equals.line).text;
    const equalsColumn = visualWidth(line.slice(0, equals.character), tabSize);
    const before = nameEnd.line === equals.line ? line.slice(nameEnd.character, equals.character) : undefined;
    const afterStart = member.assignment.valueStart === undefined ? undefined : document.positionAt(member.assignment.valueStart);
    const after = afterStart?.line === equals.line ? line.slice(equals.character + 1, afterStart.character) : undefined;
    return {
        before: before !== undefined && /^ *$/.test(before) ? before.length : 1,
        after: after !== undefined && /^\s*$/.test(after) ? visualWidth(line.slice(0, afterStart.character), tabSize) - equalsColumn - 1 : 1,
        column: before !== undefined && /^\s*$/.test(before) && start.line === equals.line &&
            /^\s*$/.test(line.slice(0, start.character)) ? equalsColumn : undefined,
        hexDigits: member.assignment.hexDigits
    };
}

function implicitAssignments(document, declarations, values, parts, options, tabSize) {
    const hints = new Map();
    const groups = new Set(Array.from(declarations.values(), member => member.group));
    for (const group of groups) {
        const first = group.members.find(member => member.assignment);
        let style = first ? assignmentStyle(document, first, tabSize) : { before: 1, after: 1, hexDigits: 0 };
        const rows = [];
        let equalsColumn = 0;
        let valueGap = 0;
        let valueWidth = 0;
        for (const member of group.members) {
            if (member.assignment) {
                style = assignmentStyle(document, member, tabSize);
                continue;
            }
            if (!member.implicit) { continue; }
            const item = values.get(member.offset);
            const start = document.positionAt(member.offset);
            const position = document.positionAt(member.end);
            const text = document.lineAt(position.line).text;
            const line = /^\s*$/.test(text.slice(0, start.character)) && declarationLine(document, member, tabSize);
            const nameColumn = visualWidth(text.slice(0, position.character), tabSize);
            if (line) {
                equalsColumn = Math.max(equalsColumn, style.column ?? 0, nameColumn + Math.min(style.before, 1));
                valueGap = Math.max(valueGap, style.after);
            }
            if (item?.number === undefined) { continue; }
            const { prefix, digits } = parts(item);
            const hexDigits = options.enumValuesHexadecimal && item.hexadecimal ? style.hexDigits : 0;
            const number = prefix + digits.padStart(hexDigits, '0');
            if (line) { valueWidth = Math.max(valueWidth, number.length); }
            rows.push({ member, position, line, nameColumn, style, number });
        }
        const widthColumns = 1 + valueGap + valueWidth;
        let commentShift = 0;
        let tabbedComments = false;
        for (const { line, nameColumn } of rows) {
            if (!line?.comment) { continue; }
            const addedColumns = equalsColumn - nameColumn + widthColumns;
            commentShift = Math.max(commentShift, line.column + addedColumns + 1 - line.commentColumn);
            tabbedComments ||= line.tabsBeforeComment;
        }
        // A whole tab stop keeps existing tabs aligned when every comment moves.
        if (tabbedComments) { commentShift = Math.ceil(commentShift / tabSize) * tabSize; }
        for (const { member, position, line, nameColumn, style: rowStyle, number } of rows) {
            const label = '=' + ' '.repeat(line ? valueGap : rowStyle.after) + number;
            if (!line) {
                hints.set(member.offset, { position, label, enumValue: true, marginColumns: rowStyle.before });
                continue;
            }
            const marginColumns = equalsColumn - nameColumn;
            const hint = { position, label, enumValue: true, marginColumns, widthColumns };
            if (line.comment) {
                const adjustment = commentShift - marginColumns - widthColumns;
                if (adjustment) { hint.suffixSpacing = { position: line.position, columns: adjustment }; }
            }
            hints.set(member.offset, hint);
        }
    }
    return hints;
}

function formatEnumHints(document, context, cpp, clangd, authoritative = false) {
    const { candidate, visible, options } = context;
    const astPositions = authoritative && new Set(clangd.filter(hint => hint.declaration).map(hint => document.offsetAt(hint.position)));
    const declarations = authoritative
        ? new Map([...context.declarations].filter(([offset]) => astPositions.has(offset))) : context.declarations;
    const completeImplicit = options.enumValues && options.enumValuePlacement === 'implicitAssignment';
    const values = new Map();
    function add(member, value, hexadecimal) {
        if (!member) { return; }
        const before = values.get(member.offset);
        const number = enumInteger(value);
        const evaluated = number ?? before?.number;
        if (evaluated !== undefined || hexadecimal !== undefined) {
            values.set(member.offset, { ...member, number: evaluated, hexadecimal: hexadecimal ?? member.hexadecimal ?? before?.hexadecimal });
        }
    }
    for (const member of declarations.values()) {
        // Use known source values for offscreen widths without issuing hover queries.
        const declaration = completeImplicit && member.implicit ? member : candidate(member.offset, member.end - member.offset, true);
        if (!authoritative) { add(declaration, member.value); }
    }
    // Clangd's enum hover reports Clang's evaluated EnumConstantDecl value.
    for (const { position, label, length, declaration, hexadecimal } of [...cpp, ...clangd]) {
        add(candidate(document.offsetAt(position), length, declaration), label, hexadecimal);
    }
    const parts = item => numberParts(item.number, options.enumValuesHexadecimal && item.hexadecimal);
    const widths = new Map();
    for (const item of values.values()) {
        const { group } = item;
        if (!group || item.number === undefined) { continue; }
        const { prefix, digits } = parts(item);
        widths.set(group, Math.max(widths.get(group) ?? 0, prefix.length + digits.length));
    }
    const layout = new Map();
    const memberCounts = new Map();
    const tabSize = options.tabSize ?? 4;
    const assignments = completeImplicit
        ? implicitAssignments(document, declarations, values, parts, options, tabSize) : undefined;
    if (options.enumValuePlacement === 'inlineComment' && options.enumValues) {
        for (const member of declarations.values()) {
            const line = document.positionAt(member.after).line;
            memberCounts.set(line, (memberCounts.get(line) ?? 0) + 1);
        }
        for (const member of declarations.values()) {
            const line = declarationLine(document, member, tabSize);
            if (!line || memberCounts.get(line.position.line) > 1) { continue; }
            const group = layout.get(member.group) ?? { lastMemberColumn: 0, firstCommentColumn: Infinity };
            group.lastMemberColumn = Math.max(group.lastMemberColumn, line.column);
            if (line.comment) { group.firstCommentColumn = Math.min(group.firstCommentColumn, line.commentColumn); }
            layout.set(member.group, group);
        }
    }
    return [...values.values()].filter(item => item.number !== undefined && visible(item.offset)).map(item => {
        const { prefix, digits } = parts(item);
        const assignment = assignments?.get(item.offset);
        if (assignment && item.declaration) { return assignment; }
        const width = item.declaration ? (widths.get(item.group) ?? 0) - prefix.length : 0;
        const number = prefix + digits.padStart(width, '0');
        const inFront = item.declaration && options.enumValuePlacement === 'prefix';
        if (inFront) {
            return { position: document.positionAt(item.offset), label: number,
                enumValue: true, paddingRight: true };
        }
        const line = item.declaration && declarationLine(document, item, tabSize);
        if (line && (memberCounts.get(line.position.line) ?? 0) <= 1) {
            const group = layout.get(item.group);
            const hintColumn = (group?.lastMemberColumn ?? line.column) + 2;
            if (!line.comment) {
                return { position: line.position, label: `// = ${number}`, enumValue: true,
                    marginColumns: hintColumn - line.column };
            }
            const label = `/* = ${number} */`;
            const hintEnd = hintColumn + label.length;
            // Render into the existing whitespace before the comment. If the
            // shortest gap can't fit, shift all comments by the same amount.
            const shift = Math.max(0, hintEnd + 2 - (group?.firstCommentColumn ?? line.commentColumn));
            return { position: line.comment, label, enumValue: true,
                marginColumns: hintColumn - line.commentColumn, widthColumns: label.length,
                rightMarginColumns: line.commentColumn + shift - hintEnd };
        }
        return { position: document.positionAt(item.declaration ? item.after : item.end),
            label: `/* = ${number} */`, enumValue: true, paddingLeft: true,
            paddingRight: Boolean(line?.comment && line.comment.character === line.position.character) };
    });
}

module.exports = { enumContext, declarationModifier, formatEnumHints };
