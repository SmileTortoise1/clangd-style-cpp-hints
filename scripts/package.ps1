param([string]$NativeDirectory, [string]$TargetPlatform = 'win32-x64')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ext = $root
$package = Get-Content -LiteralPath (Join-Path $ext 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$messages = Get-Content -LiteralPath (Join-Path $ext 'package.nls.json') -Raw -Encoding UTF8 | ConvertFrom-Json
function Get-ManifestText([string]$value) {
    if ($value -match '^%([^%]+)%$') {
        $key = $Matches[1]
        $entry = $messages.PSObject.Properties[$key]
        if (-not $entry) { throw "Missing localization key: $key" }
        $value = $entry.Value
    }
    [System.Security.SecurityElement]::Escape($value)
}
$displayName = Get-ManifestText $package.displayName
$description = Get-ManifestText $package.description
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$destination = Join-Path $dist ('clangd-style-c-cpp-inlay-hints-{0}.vsix' -f $package.version)
$nativeFiles = @()
$targetAttribute = ''
if ($TargetPlatform -notmatch '^(win32|linux|darwin)-(x64|arm64)$') { throw "Unsupported target platform: $TargetPlatform" }
if (-not $NativeDirectory) {
    $localNative = Join-Path $root "native/$TargetPlatform"
    if (Test-Path -LiteralPath $localNative -PathType Container) { $NativeDirectory = $localNative }
}
if ($NativeDirectory) {
    $NativeDirectory = (Resolve-Path -LiteralPath $NativeDirectory).Path
    $binary = if ($TargetPlatform.StartsWith('win32-')) { 'cpp-hint-ast.exe' } else { 'cpp-hint-ast' }
    if (-not (Test-Path -LiteralPath (Join-Path $NativeDirectory $binary) -PathType Leaf)) { throw "Missing $binary in $NativeDirectory" }
    if (-not (Test-Path -LiteralPath (Join-Path $NativeDirectory 'LICENSE-LLVM.txt') -PathType Leaf)) { throw "Missing LLVM license in $NativeDirectory" }
    $nativeFiles = @(Get-ChildItem -LiteralPath $NativeDirectory -File -Recurse)
    $targetAttribute = ' TargetPlatform="' + $TargetPlatform + '"'
}

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
    <Metadata>
        <Identity Language="en-US" Id="$($package.name)" Version="$($package.version)" Publisher="$($package.publisher)"$targetAttribute />
        <DisplayName>$displayName</DisplayName>
        <Description>$description</Description>
        <Categories>Programming Languages</Categories>
        <Properties>
            <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$($package.engines.vscode)" />
            <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
        </Properties>
    </Metadata>
    <Installation>
        <InstallationTarget Id="Microsoft.VisualStudio.Code" />
    </Installation>
    <Dependencies />
    <Assets>
        <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
        <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    </Assets>
</PackageManifest>
"@
$nativeTypes = foreach ($extension in ($nativeFiles.Extension | Where-Object { $_ -and $_ -notin @('.js', '.md', '.json') } | Sort-Object -Unique)) {
    '    <Default Extension="' + $extension.TrimStart('.') + '" ContentType="application/octet-stream" />'
}
$nativeOverrides = foreach ($nativeFile in ($nativeFiles | Where-Object { -not $_.Extension })) {
    $relative = $nativeFile.FullName.Substring($NativeDirectory.Length + 1).Replace('\', '/')
    '    <Override PartName="/extension/native/' + $TargetPlatform + '/' + $relative + '" ContentType="application/octet-stream" />'
}
$contentTypes = @"
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="vsixmanifest" ContentType="text/xml" />
    <Default Extension="json" ContentType="application/json" />
    <Default Extension="js" ContentType="application/javascript" />
    <Default Extension="md" ContentType="text/plain" />
$($nativeTypes -join "`n")
$($nativeOverrides -join "`n")
</Types>
"@

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$file = [System.IO.File]::Create($destination)
$zip = [System.IO.Compression.ZipArchive]::new($file, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($entry in @{ 'extension.vsixmanifest' = $manifest; '[Content_Types].xml' = $contentTypes }.GetEnumerator()) {
        $stream = $zip.CreateEntry($entry.Key).Open()
        $writer = [System.IO.StreamWriter]::new($stream)
        try { $writer.Write($entry.Value) } finally { $writer.Dispose() }
    }
    foreach ($name in 'package.json', 'package.nls.json', 'package.nls.zh-cn.json', 'extension.js', 'source.js', 'intellisense.js', 'enum-hints.js', 'enum-references.js', 'clangd-client.js', 'clangd-config.js', 'clangd-hints.js', 'ast-hints.js', 'render.js', 'README.md') {
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $ext $name), "extension/$name")
    }
    foreach ($nativeFile in $nativeFiles) {
        $relative = $nativeFile.FullName.Substring($NativeDirectory.Length + 1).Replace('\', '/')
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $nativeFile.FullName, "extension/native/$TargetPlatform/$relative")
    }
} finally {
    $zip.Dispose()
    $file.Dispose()
}
Get-Item -LiteralPath $destination | Select-Object FullName, Length
