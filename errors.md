# Fera — Known Issues & Debugging

## Windows: App installs but can't crawl

**Symptom**: Fera opens, UI works, but clicking "Start Crawl" does nothing or errors.

**Likely cause**: The sidecar (`fera-crawler.exe`) can't find bundled Chromium at runtime.

**Debug steps**:
1. Check install directory (default: `C:\Users\<user>\AppData\Local\Fera\`)
2. Verify these files exist:
   - `Fera.exe` (main app)
   - `fera-crawler-x86_64-pc-windows-msvc.exe` (sidecar)
   - `chromium\chrome.exe` (bundled browser)
3. If `chromium\` folder is missing or in a different location, the resource bundling path is wrong
4. If `chromium\chrome.exe` exists but crawling still fails, the sidecar may be looking in the wrong relative path

**Sidecar Chromium search paths** (defined in `sidecar/src/crawler.ts`):
- `<sidecar_dir>/chromium/chrome.exe`
- `<sidecar_dir>/resources/chromium/chrome.exe`
- `<sidecar_dir>/../chromium/chrome.exe`

**To test manually**: Open PowerShell in the install directory and run:
```
.\fera-crawler-x86_64-pc-windows-msvc.exe crawl https://example.com --max-requests 1
```
This should output JSON. If it errors about Chromium/browser, the path issue is confirmed.

## Windows: "System administrator has set policies to prevent this installation"

**Cause**: Corporate Group Policy blocks `.msi` installs.
**Fix**: Use the `.exe` (NSIS) installer — it installs per-user to `AppData\Local` without admin rights.

## Windows: "Unsupported 16-Bit Application"

**Cause**: Sidecar was a renamed `.bat` file, not a real binary.
**Fix**: Resolved — sidecar is now compiled with `@yao-pkg/pkg` as a real native exe.

## Future improvement

Consider switching from bundled Chromium to using the system's Edge browser (`msedge.exe`). Every Windows 10/11 machine has Edge (Chromium-based). This would:
- Reduce installer from ~150MB to ~5MB
- Eliminate Chromium path resolution issues
- Require detecting Edge's install path at runtime
