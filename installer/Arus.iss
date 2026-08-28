#define AppName "Arus"
#ifndef AppVersion
#define AppVersion "1.0.0"
#endif
#define AppPublisher "Arus"
#define AppExeName "arus.exe"
#define ReleaseDir "..\build\windows\x64\runner\Release"

[Setup]
AppId={{A9F4A9D0-7A8D-4E63-9B69-2A6E7C2AF8F1}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\Arus
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\artifacts
OutputBaseFilename=Arus-Setup-{#AppVersion}
SetupIconFile=..\windows\runner\resources\app_icon.ico
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "{#ReleaseDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Arus"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Comment: "Arus Download Manager"
Name: "{autodesktop}\Arus"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Buat shortcut Arus di desktop"; Flags: unchecked

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Jalankan Arus"; Flags: nowait postinstall skipifsilent
