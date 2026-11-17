# Clangd-Style C/C++ Inlay Hints

See enum values, parameter names and types, inferred C++ types, struct fields, and array indices inline in VS Code. Use the extension with either clangd or Microsoft C/C++.

## Highlights

- **Enum values** appear at declarations and optionally at references. Show values before the member, as a virtual comment, or as an aligned assignment for implicit values.
- **Hexadecimal display** follows explicit hexadecimal initializers and the implicit members that follow them. Decimal sequences stay decimal.
- **Parameter hints** show `size:` or `uint32_t size:`. You can also turn them off.
- **Aggregate hints** show array indices such as `[0]=` and field names such as `.command=`.

```text
dispatch(‹Mode mode:› Mode::Ready ‹/* = 8 */›, ‹uint32_t size:› 256);
auto count ‹: int› = 3;
Point points[] = { ‹[0]=›{ ‹.x=›1, ‹.y=›2 } };
```

The editor shows the text inside `‹…›` as hints.

## Getting started

This package targets Windows x64 and requires VS Code 1.77 or later. Enable the official clangd extension or Microsoft C/C++, then open a C or C++ file.

The extension prefers clangd when it is available and uses the bundled LibTooling helper for AST analysis. When you use Microsoft's C/C++ extension, hints can use IntelliSense. For an ARM Compiler 5 project, you can select Microsoft C/C++ by turning off `clangdStyleCppHints.useClangd` in that workspace.

```json
{
  "clangdStyleCppHints.enumValueReferences": true,
  "clangdStyleCppHints.enumValuePlacement": "inlineComment",
  "clangdStyleCppHints.parameterHintStyle": "nameAndType"
}
```

The extension provides localized setting descriptions in Simplified Chinese.
