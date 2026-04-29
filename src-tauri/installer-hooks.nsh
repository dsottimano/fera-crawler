; Tauri NSIS installer hooks. Run inside the per-user installer
; (installMode: "currentUser"), so $APPDATA resolves to the installing user's
; %APPDATA% — typically C:\Users\<name>\AppData\Roaming.
;
; Pre-install: nuke any prior Fera per-user data (sessions DB, browser
; profile, og:images) so colleagues with broken/half-installed builds get a
; truly clean slate. The DB schema is still young and migrations across the
; install gaps are not worth the friction this early in the project.

!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$APPDATA\com.fera.crawler"
!macroend
