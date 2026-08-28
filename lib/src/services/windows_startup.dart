import 'dart:io';

/// Per-user Windows startup registration for the optional launch-at-login
/// setting. It intentionally uses HKCU, so no administrator prompt is needed.
class WindowsStartupService {
  const WindowsStartupService();

  static const String _key =
      r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run';
  static const String _value = 'Arus';

  Future<void> setEnabled(bool enabled) async {
    if (!Platform.isWindows) {
      return;
    }
    final arguments = enabled
        ? <String>[
            'ADD',
            _key,
            '/v',
            _value,
            '/t',
            'REG_SZ',
            '/d',
            '"${Platform.resolvedExecutable}"',
            '/f',
          ]
        : <String>['DELETE', _key, '/v', _value, '/f'];
    final result = await Process.run('reg.exe', arguments);
    if (result.exitCode != 0 && enabled) {
      throw StateError('Failed to update launch-at-login: ${result.stderr}');
    }
  }
}
