import 'dart:convert';
import 'dart:io';

import '../core/path_utils.dart';
import 'native_messaging.dart';

/// Installs the per-user Native Messaging manifests used by the browser
/// companion. No elevation is required; the registry entries live in HKCU.
class NativeHostInstaller {
  const NativeHostInstaller();

  Future<void> install() async {
    if (!Platform.isWindows) {
      throw UnsupportedError(
        'Native Messaging installation is currently Windows-only',
      );
    }

    final directory = Directory(joinPath(appDataDirectory(), 'native-hosts'));
    await directory.create(recursive: true);
    final executable = Platform.resolvedExecutable;
    final chromeManifest = File(
      joinPath(directory.path, '$nativeHostName.chrome.json'),
    );
    final firefoxManifest = File(
      joinPath(directory.path, '$nativeHostName.firefox.json'),
    );
    await chromeManifest.writeAsString(
      _prettyJson(<String, dynamic>{
        'name': nativeHostName,
        'description': 'Arus download manager bridge',
        'path': executable,
        'type': 'stdio',
        'allowed_origins': <String>['chrome-extension://$chromeExtensionId/'],
      }),
    );
    await firefoxManifest.writeAsString(
      _prettyJson(<String, dynamic>{
        'name': nativeHostName,
        'description': 'Arus download manager bridge',
        'path': executable,
        'type': 'stdio',
        'allowed_extensions': <String>[firefoxExtensionId],
      }),
    );

    final registryEntries = <List<String>>[
      <String>[
        'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\$nativeHostName',
        chromeManifest.path,
      ],
      <String>[
        'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\$nativeHostName',
        chromeManifest.path,
      ],
      <String>[
        'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\$nativeHostName',
        chromeManifest.path,
      ],
      <String>[
        'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\$nativeHostName',
        firefoxManifest.path,
      ],
    ];
    for (final entry in registryEntries) {
      await _regAdd(<String>[
        'ADD',
        entry[0],
        '/ve',
        '/t',
        'REG_SZ',
        '/d',
        entry[1],
        '/f',
      ]);
    }

    await _regAdd(<String>[
      'ADD',
      'HKCU\\Software\\Classes\\arus',
      '/ve',
      '/t',
      'REG_SZ',
      '/d',
      'URL:Arus Download Link',
      '/f',
    ]);
    await _regAdd(<String>[
      'ADD',
      'HKCU\\Software\\Classes\\arus',
      '/v',
      'URL Protocol',
      '/t',
      'REG_SZ',
      '/d',
      '',
      '/f',
    ]);
    await _regAdd(<String>[
      'ADD',
      'HKCU\\Software\\Classes\\arus\\shell\\open\\command',
      '/ve',
      '/t',
      'REG_SZ',
      '/d',
      '"$executable" "%1"',
      '/f',
    ]);
  }

  Future<void> _regAdd(List<String> arguments) async {
    final result = await Process.run('reg.exe', arguments);
    if (result.exitCode != 0) {
      throw StateError(
        'Failed to register Windows integration: ${result.stderr}',
      );
    }
  }

  String _prettyJson(Map<String, dynamic> value) =>
      const JsonEncoder.withIndent('  ').convert(value);
}
