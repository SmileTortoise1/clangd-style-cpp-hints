# Clangd 风格 C/C++ 内联提示

**Clangd-Style C/C++ Inlay Hints** 是一个 VS Code 扩展。它为 C 和 C++ 提供 clangd 风格的参数、类型和初始化提示，并为 clangd 补充枚举成员在声明处和引用处的数值提示。可以搭配官方 clangd 或微软 C/C++ 使用，适用于使用 ARM Compiler 5（AC5）的嵌入式项目。

```text
enum class DeviceState {
    ‹07› Idle = 7,
    ‹08› Ready,
    ‹16› Fault = 16,
};

dispatch(‹DeviceState state:› DeviceState::Ready ‹/* = 8 */›, ‹uint32_t size:› 256);
auto count ‹: int› = 3;
auto read_count() ‹-> int› { return 3; }
Point points[] = { ‹[0]=›{ ‹.x=›1, ‹.y=›2 } };
```

`‹…›` 内是编辑器显示的提示。示例启用了枚举引用和参数类型提示，源码保持原样。

## 安装

1. 使用 VS Code 1.77 或更高版本，启用官方 clangd（`llvm-vs-code-extensions.vscode-clangd`）或微软 C/C++（`ms-vscode.cpptools`）。
2. 从本仓库的 **Releases** 下载 Windows x64 的 `.vsix`。安装包包含 LibTooling 助手和 Clang 内建头文件。
3. 在 VS Code 扩展面板的菜单中选择 **从 VSIX 安装…**，选中下载的文件，再打开 C 或 C++ 文件。


## 选择语言服务

| 项目环境 | 工作方式 |
| --- | --- |
| 使用 clangd | 默认复用官方 clangd 扩展的连接，并启动随包分发的 LibTooling 助手。助手从 Clang AST 读取枚举值及其引用、参数签名、推导类型和初始化器信息。助手不可用或解析失败时，使用可用的 clangd 提示和语义结果。 |
| 使用微软 C/C++ | 只启用微软 C/C++ 时直接使用 IntelliSense。枚举提示优先根据符号定义和源码求值，必要时读取悬停信息。 |
| 同时启用两种服务 | 默认优先使用可用的 clangd。可在工作区将 `clangdStyleCppHints.useClangd` 设为 `false`，使用微软 C/C++。 |

扩展运行时只读取语言服务设置。F12 跳转仍由当前语言扩展提供。

### AC5 项目

使用 Keil/AC5 时，可以沿用微软 C/C++ 的头文件、宏和 IntelliSense 配置。若采用 clangd 后端，LibTooling 可读取 `compile_commands.json`、`compile_flags.txt` 或选定的 `.vscode/c_cpp_properties.json`。扩展会转换常见的 `armcc` 参数，包括头文件路径、宏、预包含头文件和常用 Cortex CPU 选项。存在多套 C/C++ 配置时，可通过 `clangdStyleCppHints.clangdConfiguration` 指定配置名称。

如果启用的项目或用户级 clangd 配置含有 `CompileFlags`，扩展使用 clangd 应用这些选项后的语义结果。切换构建目标后，可在命令面板运行 **Clangd 风格 C/C++ 内联提示：刷新**。

## 配置

以下示例同时打开枚举引用、十六进制显示和参数类型。将需要的项目填入项目的 `.vscode/settings.json`。

```json
{
  "clangdStyleCppHints.enumValuePlacement": "inlineComment",
  "clangdStyleCppHints.enumValueReferences": true,
  "clangdStyleCppHints.enumValuesHexadecimal": true,
  "clangdStyleCppHints.parameterHintStyle": "nameAndType"
}
```

### 枚举声明和引用

声明与引用提示可独立开关。引用处显示为 `DeviceState::Ready /* = 8 */`。声明位置在设置界面提供三种选项。

| 枚举声明样式 | 编辑器中的效果 |
| --- | --- |
| `prefix` 成员名前 | `08 Ready,`。按同一枚举的最宽数值补零。 |
| `inlineComment` 成员声明后 | `Ready,  // = 08`。将虚拟注释放在原注释之前并对齐，优先利用已有空白。 |
| `implicitAssignment` 虚拟补齐 | `Ready = 8,`。只标出省略赋值的成员，每行一个成员时对齐等号、数值和逗号。 |

开启十六进制显示时，十六进制字面量定义的成员和紧跟它的隐式成员会使用十六进制。例如 `A = 0x07, B` 显示 `0x07` 和 `0x08`。遇到显式十进制赋值时恢复十进制，适用于声明和引用。

### 参数、推导类型和初始化

参数可显示为 `size:` 或 `uint32_t size:`，也可关闭本扩展的参数提示。使用类型模式时，如遇到重复的原生参数提示，可以单独关闭微软 C/C++ 的 `C_Cpp.inlayHints.parameterNames.enabled`，或在项目的 `.clangd` 中将 `InlayHints.ParameterNames` 设为 `false`。

参数标签采用 VS Code 主题的 `editorInlayHint.parameterForeground` 和 `editorInlayHint.parameterBackground`。枚举值、结构体字段和数组下标采用 `editorInlayHint.foreground` 和 `editorInlayHint.background`。其余提示使用扩展提供的 `clangdStyleCppHints.foreground` 和 `clangdStyleCppHints.background`，可在 `workbench.colorCustomizations` 中调整。

### 设置一览

下表设置使用 `clangdStyleCppHints.` 前缀。

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 控制本扩展的提示。 |
| `enumValues` | `true` | 显示枚举声明处的数值。 |
| `enumValuePlacement` | `prefix` | 选择 `prefix`、`inlineComment` 或 `implicitAssignment`。 |
| `enumValueReferences` | `false` | 显示枚举引用处的数值。 |
| `enumValuesHexadecimal` | `false` | 保留十六进制字面量成员及后续隐式成员的十六进制显示。 |
| `parameterHintStyle` | `name` | `name` 显示参数名，`nameAndType` 同时显示类型，`disabled` 关闭本扩展的实参提示。 |
| `deducedTypes` | `true` | 显示可推导的 C++ 变量类型和函数返回类型。 |
| `arrayIndices` | `true` | 在顺序初始化的数组元素前显示 `[0]=` 等下标。 |
| `structFields` | `true` | 在顺序初始化的结构体成员前显示 `.command=` 等字段名。 |
| `useClangd` | `true` | 优先使用可用的 clangd。 |
| `clangdPath` | 空字符串 | 指定独立 clangd 程序的路径，仅在官方扩展缺失时使用。 |
| `clangdConfiguration` | 空字符串 | 选择 `c_cpp_properties.json` 的配置，只有一套时自动选用。 |
| `clangdFallbackFlags` | `[]` | 补充备用解析或转换后的 AC5 参数，每个参数单独填一项。 |

若没有提示，请先检查 VS Code 的 `editor.inlayHints.enabled`、文件的语言模式以及语言服务能否解析头文件和宏。枚举引用还需要单独开启 `enumValueReferences`。

