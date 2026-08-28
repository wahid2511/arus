import 'package:flutter_test/flutter_test.dart';

import 'package:arus_flutter/src/models/download_models.dart';
import 'package:arus_flutter/src/services/clipboard_link_monitor.dart';
import 'package:arus_flutter/src/services/native_messaging.dart';

void main() {
  test('persists the global speed limit and tray preference', () {
    const original = DownloadSettings(
      speedLimitBytesPerSecond: 12 * 1024 * 1024,
      minimizeToTray: false,
    );

    final restored = DownloadSettings.fromJson(original.toJson());

    expect(restored.speedLimitBytesPerSecond, 12 * 1024 * 1024);
    expect(restored.minimizeToTray, isFalse);
  });

  test('accepts supported clipboard and native bridge URLs only', () {
    expect(
      ClipboardLinkMonitor.isDownloadUrl('https://example.com/file.zip'),
      isTrue,
    );
    expect(
      ClipboardLinkMonitor.isDownloadUrl('ftp://example.com/file.zip'),
      isTrue,
    );
    expect(isSupportedUrl('http://127.0.0.1/file.bin'), isTrue);
    expect(ClipboardLinkMonitor.isDownloadUrl('file:///tmp/file.zip'), isFalse);
    expect(isSupportedUrl('magnet:?xt=urn:btih:abc'), isFalse);
  });
}
