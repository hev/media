#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app="$HOME/Applications/hev Media.app"
mkdir -p "$app/Contents/MacOS" "$HOME/.local/bin"
xcrun swiftc "$source_dir/Handler.swift" -o "$app/Contents/MacOS/hev-media" -framework AppKit
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.hevmind.media.resolve</string>
<key>CFBundleName</key><string>hev Media</string>
<key>CFBundleExecutable</key><string>hev-media</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>hev Media Resolve</string><key>CFBundleURLSchemes</key><array><string>hevmedia</string></array></dict></array>
</dict></plist>
PLIST
install -m 755 "$source_dir/../bin/resolve-open" "$HOME/.local/bin/resolve-open"
codesign --force --sign - "$app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
printf 'Installed %s. Open in Resolve now handles hevmedia:// links.\n' "$app"
