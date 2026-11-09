; extra Start menu entry for the standalone updater
!macro customInstall
  CreateShortCut "$SMPROGRAMS\fuck pdf updater.lnk" "$INSTDIR\resources\updater\fuck-pdf-updater.exe" "" "$INSTDIR\resources\updater\fuck-pdf-updater.exe" 0
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\fuck pdf updater.lnk"
!macroend
