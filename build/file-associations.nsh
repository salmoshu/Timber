; Register Open With entries without changing the user's default Markdown application.
!macro TimberMarkdownExtension EXT
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "Timber.Markdown" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".${EXT}" ""
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\Timber.Markdown" "" "Markdown document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Timber.Markdown\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\Timber.Markdown\shell\open" "" "Open with Timber"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Timber.Markdown\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Timber"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  !insertmacro TimberMarkdownExtension "md"
  !insertmacro TimberMarkdownExtension "markdown"
  !insertmacro TimberMarkdownExtension "mdown"
  !insertmacro TimberMarkdownExtension "mkd"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro TimberRemoveMarkdownExtension EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "Timber.Markdown"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids"
!macroend

!macro customUnInstall
  !insertmacro TimberRemoveMarkdownExtension "md"
  !insertmacro TimberRemoveMarkdownExtension "markdown"
  !insertmacro TimberRemoveMarkdownExtension "mdown"
  !insertmacro TimberRemoveMarkdownExtension "mkd"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Timber.Markdown"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
