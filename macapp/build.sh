#!/bin/zsh
# Builds VidAnki.app and installs it in /Applications.
set -euo pipefail
cd "$(dirname "$0")"
PROJECT_DIR="$(cd .. && pwd)"
BUILD=build
APP="$BUILD/VidAnki.app"
rm -rf "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -o "$APP/Contents/MacOS/VidAnki" VidAnki.swift

# icon
ICONSET="$BUILD/VidAnki.iconset"
mkdir -p "$ICONSET"
swift make_icon.swift "$BUILD/icon1024.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$BUILD/icon1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$BUILD/icon1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/VidAnki.icns"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>VidAnki</string>
  <key>CFBundleDisplayName</key><string>VidAnki</string>
  <key>CFBundleIdentifier</key><string>local.vidanki.app</string>
  <key>CFBundleExecutable</key><string>VidAnki</string>
  <key>CFBundleIconFile</key><string>VidAnki</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>VidAnki switches to its tab in Chrome instead of opening a new one.</string>
  <key>VidAnkiProjectDir</key><string>$PROJECT_DIR</string>
</dict>
</plist>
EOF

codesign --force --deep -s - "$APP"
rm -rf /Applications/VidAnki.app
cp -R "$APP" /Applications/
echo "Installed /Applications/VidAnki.app (project: $PROJECT_DIR)"
