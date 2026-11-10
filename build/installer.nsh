; fuck pdf installer extras
;
; Windows caches icons by file path, and the app exe keeps the same path
; between versions, so an update would keep showing the old logo on
; shortcuts. Point every shortcut at a versioned .ico instead, then tell
; Explorer to refresh. (The .pdf file icon is already versioned via the
; fileAssociations config.)

!macro fpdfShortcut LINK
  ${if} ${FileExists} "${LINK}"
    Delete "${LINK}"
    CreateShortCut "${LINK}" "$appExe" "" "$INSTDIR\resources\fuck-pdf-${VERSION}.ico" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "${LINK}" "${APP_ID}"
  ${endIf}
!macroend

!macro customInstall
  !insertmacro fpdfShortcut "$newStartMenuLink"
  !insertmacro fpdfShortcut "$newDesktopLink"

  ; the standalone updater
  CreateShortCut "$SMPROGRAMS\fuck pdf updater.lnk" "$INSTDIR\resources\updater\fuck-pdf-updater.exe" "" "$INSTDIR\resources\fuck-pdf-${VERSION}.ico" 0

  ; make Explorer drop cached icons (SHCNE_ASSOCCHANGED, SHCNF_FLUSH)
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
  ${if} ${FileExists} "$SYSDIR\ie4uinit.exe"
    nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
    Pop $0
  ${endIf}
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\fuck pdf updater.lnk"
!macroend
